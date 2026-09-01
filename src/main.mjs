import { pathToFileURL } from "node:url";
import {
  loadState,
  saveState,
  processUpdate,
  redactError,
  nextBackoffMs,
} from "./bridge.mjs";
import { loadGatewayConfig, GatewayClient } from "./gateway-client.mjs";
import { readTokenFile, TelegramClient } from "./telegram-client.mjs";

const DEFAULT_GATEWAY_PATH = process.env.HOME
  ? `${process.env.HOME}/sand-data/gateway.json`
  : "gateway.json";
const DEFAULT_STATE_PATH = process.env.HOME
  ? `${process.env.HOME}/.local/share/telegram-grok-bridge/state.json`
  : "state.json";
const GATEWAY_UNAVAILABLE_ZH = "网关暂时不可用，请稍后重试。";
const GATEWAY_EMPTY_ZH = "未能取得回复，请稍后重试。";

function defaultWait(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function makeLog(logFn) {
  return (fields) => {
    const rec = { ts: new Date().toISOString(), ...fields };
    if (rec.error != null) rec.error = redactError(rec.error);
    if (typeof logFn === "function") {
      logFn(rec);
      return;
    }
    process.stderr.write(`${JSON.stringify(rec)}\n`);
  };
}

function isAborted(signal) {
  return Boolean(signal && signal.aborted);
}

function statusForAction(action) {
  if (action === "paired") return "paired";
  if (action === "unauthorized") return "unauthorized";
  if (action === "user_message") return "user_message";
  if (action === "stop") return "stop";
  if (action === "start") return "update";
  if (action === "feedback") return "feedback";
  return action || "update";
}

export async function startBridge(options = {}) {
  const log = makeLog(options.logFn);
  const signal = options.signal;
  const waitFn = options.waitFn || defaultWait;
  const tokenFile = options.tokenFile ?? process.env.TELEGRAM_TOKEN_FILE;
  if (!tokenFile) {
    throw new Error("TELEGRAM_TOKEN_FILE is required");
  }
  const token = readTokenFile(tokenFile);
  const gatewayPath = options.gatewayPath ?? process.env.GATEWAY_PATH ?? DEFAULT_GATEWAY_PATH;
  const statePath = options.statePath ?? process.env.STATE_PATH ?? DEFAULT_STATE_PATH;
  const telegramApiBase = options.telegramApiBase ?? process.env.TELEGRAM_API_BASE;
  const agentName = options.agentName ?? process.env.GROK_AGENT_NAME;
  const pollTimeoutSec = options.pollTimeoutSec ?? Number(process.env.POLL_TIMEOUT_SEC ?? 25);
  const heartbeatMs = options.heartbeatMs === undefined ? 30_000 : options.heartbeatMs;
  const pollDelayMs = options.pollDelayMs ?? 200;
  const timeoutMs =
    options.timeoutMs ?? Math.max(10_000, (Number(pollTimeoutSec) + 10) * 1000);

  log({ status: "start" });

  const gwCfg = loadGatewayConfig(gatewayPath);
  const telegram = new TelegramClient({
    token,
    apiBase: telegramApiBase,
    timeoutMs,
    waitFn,
    signal,
  });
  const gateway = new GatewayClient({
    baseUrl: gwCfg.baseUrl,
    token: gwCfg.token,
    agentName,
    pollDelayMs,
    timeoutMs,
    maxWaitMs: options.maxWaitMs ?? 120_000,
    waitFn,
    signal,
  });

  const info = await telegram.getWebhookInfo();
  const hookUrl = info && typeof info.url === "string" ? info.url.trim() : "";
  if (hookUrl) {
    log({ status: "webhook_present" });
    return { exitCode: 2 };
  }

  let state = loadState(statePath);
  let heartbeatTimer = null;
  if (heartbeatMs > 0) {
    heartbeatTimer = setInterval(() => {
      log({ status: "heartbeat" });
    }, heartbeatMs);
    if (typeof heartbeatTimer.unref === "function") heartbeatTimer.unref();
  }

  const persist = () => {
    try {
      saveState(statePath, state);
    } catch (e) {
      log({ status: "exit", error: e });
    }
  };

  try {
    let failCount = 0;
    while (!isAborted(signal)) {
      try {
        log({ status: "poll" });
        const updates = await telegram.getUpdates({
          offset: state.offset,
          timeout: pollTimeoutSec,
          limit: 100,
        });
        failCount = 0;
        for (const update of updates) {
          if (isAborted(signal)) break;
          const processed = processUpdate(state, update);
          saveState(statePath, state);
          const updateId = processed.updateId ?? update.update_id;
          log({ update_id: updateId, status: statusForAction(processed.action) });
          const chatId = processed.chatId ?? update.message?.chat?.id;
          if (processed.replies && processed.replies.length && chatId != null) {
            for (const part of processed.replies) {
              await telegram.sendMessage(chatId, part);
            }
            log({ update_id: updateId, status: "reply" });
          }
          if (processed.action === "user_message") {
            try {
              const finalText = await gateway.submitAndWaitFinalReply(processed.text);
              if (finalText == null || finalText === "") {
                await telegram.sendMessage(chatId, GATEWAY_EMPTY_ZH);
              } else {
                await telegram.sendMessage(chatId, finalText);
              }
              log({ update_id: updateId, status: "reply" });
            } catch (e) {
              if (e?.name === "AbortError" || isAborted(signal)) throw e;
              log({ update_id: updateId, status: "backoff", error: e });
              if (chatId != null) {
                await telegram.sendMessage(chatId, GATEWAY_UNAVAILABLE_ZH);
              }
            }
          }
        }
      } catch (e) {
        if (e?.name === "AbortError" || isAborted(signal)) break;
        failCount += 1;
        log({ status: "backoff", error: e });
        await waitFn(nextBackoffMs(failCount - 1));
      }
    }
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    persist();
    log({ status: "stop" });
    log({ status: "exit" });
  }
  return { exitCode: 0 };
}

function isCliEntry() {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
}

if (isCliEntry()) {
  const ac = new AbortController();
  const stop = () => ac.abort();
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  startBridge({ signal: ac.signal })
    .then(({ exitCode }) => {
      process.exit(exitCode ?? 0);
    })
    .catch((err) => {
      process.stderr.write(
        `${JSON.stringify({
          ts: new Date().toISOString(),
          status: "exit",
          error: redactError(err),
        })}\n`
      );
      process.exit(1);
    });
}
