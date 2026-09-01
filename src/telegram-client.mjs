import { lstatSync, readFileSync } from "node:fs";
import {
  splitTelegramText,
  backoffForTelegramError,
  nextBackoffMs,
  BACKOFF_CAP_MS,
} from "./bridge.mjs";
import { requestJson } from "./gateway-client.mjs";

function defaultWait(ms) {
  const n = Number(ms) || 0;
  if (n <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}

function abortError() {
  const e = new Error("aborted");
  e.name = "AbortError";
  return e;
}

export function readTokenFile(path) {
  let st;
  try {
    st = lstatSync(path);
  } catch {
    throw new Error("telegram token file missing or unreadable");
  }
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error("telegram token file must be a regular file");
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw new Error("telegram token file must be mode 0600");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token) {
    throw new Error("telegram token file is empty");
  }
  return token;
}

export class TelegramClient {
  constructor({ token, apiBase, timeoutMs = 35_000, waitFn, signal } = {}) {
    if (!token) throw new Error("telegram token required");
    this.token = token;
    this.apiBase = (apiBase || "https://api.telegram.org").replace(/\/$/, "");
    this.timeoutMs = timeoutMs == null ? 35_000 : timeoutMs;
    this.waitFn = waitFn || defaultWait;
    this.signal = signal;
  }

  async call(method, payload = {}) {
    const url = `${this.apiBase}/bot${this.token}/${method}`;
    let failCount = 0;
    for (;;) {
      if (this.signal?.aborted) throw abortError();
      try {
        const { status, json } = await requestJson({
          url,
          method: "POST",
          headers: { "content-type": "application/json" },
          body: payload == null ? {} : payload,
          timeoutMs: this.timeoutMs,
          signal: this.signal,
        });
        const is429 = status === 429 || json?.error_code === 429;
        if (is429) {
          const waitMs = Math.min(
            BACKOFF_CAP_MS,
            backoffForTelegramError(json ?? {}, failCount)
          );
          failCount += 1;
          await this.waitFn(waitMs);
          continue;
        }
        if (!json || json.ok !== true) {
          const err = new Error(`telegram ${method} failed`);
          err.status = status;
          throw err;
        }
        return json.result;
      } catch (e) {
        if (e?.name === "AbortError" || this.signal?.aborted) throw abortError();
        if (e && e.status && e.status !== 429) throw e;
        const waitMs = Math.min(BACKOFF_CAP_MS, nextBackoffMs(failCount));
        failCount += 1;
        await this.waitFn(waitMs);
        if (failCount > 6) throw e;
      }
    }
  }

  getWebhookInfo() {
    return this.call("getWebhookInfo", {});
  }

  async getUpdates({ offset, timeout, limit } = {}) {
    const body = {};
    if (offset !== undefined && offset !== null) body.offset = offset;
    if (timeout !== undefined && timeout !== null) body.timeout = timeout;
    if (limit !== undefined && limit !== null) body.limit = limit;
    const result = await this.call("getUpdates", body);
    return Array.isArray(result) ? result : [];
  }

  async sendMessage(chatId, text) {
    const parts = splitTelegramText(text);
    const out = [];
    for (const part of parts) {
      out.push(await this.call("sendMessage", { chat_id: chatId, text: part }));
    }
    return out;
  }
}
