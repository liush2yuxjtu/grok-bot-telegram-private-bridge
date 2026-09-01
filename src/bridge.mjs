import {
  mkdirSync,
  openSync,
  writeSync,
  fsyncSync,
  closeSync,
  renameSync,
  chmodSync,
  readFileSync,
  existsSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

export const TELEGRAM_MAX = 4096;
export const MAX_TEXT_BYTES = 8 * 1024;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
export const PAIRING_MAX_ATTEMPTS = 5;
export const BACKOFF_CAP_MS = 30_000;
export const SEEN_CAP = 512;

export function emptyState() {
  return {
    pairing: null,
    owner: null,
    sessionStopped: false,
    seenUpdateIds: [],
    offset: 0,
  };
}

export function splitTelegramText(text) {
  const chars = Array.from(text == null ? "" : String(text));
  if (chars.length === 0) return [""];
  const parts = [];
  for (let i = 0; i < chars.length; i += TELEGRAM_MAX) {
    parts.push(chars.slice(i, i + TELEGRAM_MAX).join(""));
  }
  return parts;
}

export function atomicWriteJson(filePath, value, mode = 0o600) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(tmp, "w", mode);
  try {
    writeSync(fd, Buffer.from(`${JSON.stringify(value)}\n`, "utf8"));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(tmp, mode);
  renameSync(tmp, filePath);
  chmodSync(filePath, mode);
}

export function loadState(filePath) {
  if (!existsSync(filePath)) return emptyState();
  const st = lstatSync(filePath);
  if (!st.isFile() || st.isSymbolicLink()) {
    throw new Error("state must be a regular file");
  }
  if ((st.mode & 0o777) !== 0o600) {
    throw new Error("state must be mode 0600");
  }
  const parsed = JSON.parse(readFileSync(filePath, "utf8"));
  return {
    ...emptyState(),
    ...parsed,
    seenUpdateIds: Array.isArray(parsed.seenUpdateIds) ? parsed.seenUpdateIds : [],
    offset: Number.isInteger(parsed.offset) ? parsed.offset : 0,
  };
}

export function saveState(filePath, state) {
  atomicWriteJson(filePath, state, 0o600);
}

const SECRET_RE =
  /(bot\d+:[A-Za-z0-9_-]+)|(\bBearer\s+[A-Za-z0-9._~+/=-]+)|((?:token|secret|authorization|api[_-]?key)\s*[:=]\s*\S+)/gi;
const URL_RE = /https?:\/\/[^\s]+/gi;
const ADDR_RE = /\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g;

export function redactError(err) {
  const raw =
    err == null
      ? ""
      : typeof err === "string"
        ? err
        : err instanceof Error
          ? `${err.name}: ${err.message}`
          : String(err);
  return raw
    .replace(URL_RE, "[redacted-url]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "[redacted]")
    .replace(SECRET_RE, "[redacted]")
    .replace(ADDR_RE, "[redacted-addr]");
}

export function issuePairing(state, now = Date.now(), bytesFn = randomBytes) {
  const code = bytesFn(16).toString("hex");
  state.pairing = {
    code,
    expiresAt: now + PAIRING_TTL_MS,
    attempts: 0,
  };
  return { expiresAt: state.pairing.expiresAt, code };
}

function isOwner(state, userId, chatId) {
  return (
    state.owner != null &&
    Number(state.owner.userId) === Number(userId) &&
    Number(state.owner.chatId) === Number(chatId)
  );
}

export function tryPair(state, submitted, userId, chatId, now = Date.now()) {
  const pairing = state.pairing;
  if (pairing == null) {
    return { ok: false, reason: "no_pairing" };
  }
  if (now > pairing.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (pairing.attempts >= PAIRING_MAX_ATTEMPTS) {
    return { ok: false, reason: "too_many_attempts" };
  }
  const got = String(submitted || "").trim().toLowerCase();
  if (got !== pairing.code) {
    pairing.attempts += 1;
    const left = PAIRING_MAX_ATTEMPTS - pairing.attempts;
    return {
      ok: false,
      reason: left <= 0 ? "too_many_attempts" : "mismatch",
      attemptsLeft: Math.max(0, left),
    };
  }
  state.owner = { userId: Number(userId), chatId: Number(chatId) };
  state.pairing = null;
  state.sessionStopped = false;
  return { ok: true };
}

export function utf8ByteLength(text) {
  return Buffer.byteLength(text == null ? "" : String(text), "utf8");
}

export function nextBackoffMs(failCount) {
  const n = Math.max(0, Number(failCount) || 0);
  const ms = 1000 * 2 ** n;
  return Math.min(BACKOFF_CAP_MS, ms);
}

export function parseRetryAfter(source) {
  if (source == null) return null;
  if (typeof source === "number" && Number.isFinite(source) && source >= 0) {
    return Math.min(BACKOFF_CAP_MS, Math.ceil(source * 1000));
  }
  if (typeof source === "string") {
    const n = Number(source);
    if (Number.isFinite(n) && n >= 0) return Math.min(BACKOFF_CAP_MS, Math.ceil(n * 1000));
    return null;
  }
  if (typeof source === "object") {
    const header =
      source.retry_after ??
      source.retryAfter ??
      source["retry-after"] ??
      source["Retry-After"];
    if (header != null && header !== source) {
      const fromHeader = parseRetryAfter(header);
      if (fromHeader != null) return fromHeader;
    }
    const nested =
      source.parameters?.retry_after ??
      source.body?.parameters?.retry_after ??
      source.error?.parameters?.retry_after;
    if (nested != null) return parseRetryAfter(nested);
  }
  return null;
}

export function backoffForTelegramError(err, failCount) {
  const retry = parseRetryAfter(err);
  if (retry != null) return retry;
  return nextBackoffMs(failCount);
}

export function classifyGatewayError(err) {
  const msg = err == null ? "" : err instanceof Error ? err.message : String(err);
  const code = err && typeof err === "object" ? err.code : undefined;
  if (
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "ENOTFOUND" ||
    /unavailable|econnrefused|timed out/i.test(msg)
  ) {
    return { unavailable: true, log: redactError(err) };
  }
  return { unavailable: false, log: redactError(err) };
}

function rememberUpdate(state, updateId) {
  if (!Number.isInteger(updateId)) return { duplicate: false };
  if (state.seenUpdateIds.includes(updateId)) return { duplicate: true };
  state.seenUpdateIds.push(updateId);
  if (state.seenUpdateIds.length > SEEN_CAP) {
    state.seenUpdateIds = state.seenUpdateIds.slice(-SEEN_CAP);
  }
  if (updateId + 1 > state.offset) state.offset = updateId + 1;
  return { duplicate: false };
}

export const FEEDBACK_STAR_URL =
  "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge";
export const FEEDBACK_DISCUSSIONS_URL =
  "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge/discussions";
export const FEEDBACK_ISSUE_URL =
  "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge/issues/new/choose";

export const FEEDBACK_REPLY = [
  "⭐ Star the project",
  "",
  FEEDBACK_STAR_URL,
  "",
  "💬 Share your setup or idea",
  "",
  FEEDBACK_DISCUSSIONS_URL,
  "",
  "🐛 Report a compatibility problem",
  "",
  FEEDBACK_ISSUE_URL,
].join("\n");

export const BOUND_START_REPLY = "已绑定。直接发文字即可。发送 /feedback 查看反馈入口。";

function unauthorizedReply() {
  return "未绑定。在已授权的 Grok Bot 对话取得配对码后，发送 /pair <code>";
}

export function commandName(text) {
  const m = String(text || "").match(/^\/([A-Za-z0-9_]+)(?:@[\w]+)?(?:\s|$)/);
  return m ? m[1].toLowerCase() : null;
}

export function processUpdate(state, update, now = Date.now()) {
  if (update == null || typeof update !== "object") {
    return { action: "ignore" };
  }
  const updateId = update.update_id;
  if (Number.isInteger(updateId)) {
    const { duplicate } = rememberUpdate(state, updateId);
    if (duplicate) return { action: "duplicate", updateId };
  }

  const msg = update.message;
  if (msg == null || typeof msg !== "object") return { action: "ignore", updateId };
  if (msg.chat?.type !== "private") return { action: "ignore", updateId };
  if (typeof msg.text !== "string") return { action: "ignore", updateId };

  if (utf8ByteLength(msg.text) > MAX_TEXT_BYTES) {
    return {
      action: "too_long",
      updateId,
      replies: splitTelegramText("消息超过 8 KiB 上限，已丢弃。"),
    };
  }

  const text = msg.text.trim();
  const userId = msg.from?.id;
  const chatId = msg.chat?.id;
  const owner = isOwner(state, userId, chatId);
  const bound = owner && !state.sessionStopped;
  const cmd = commandName(text);

  if (cmd === "start") {
    if (owner && state.sessionStopped) {
      state.sessionStopped = false;
      return { action: "start", updateId, replies: splitTelegramText("会话已恢复。发送 /feedback 查看反馈入口。") };
    }
    if (bound) {
      return { action: "start", updateId, replies: splitTelegramText(BOUND_START_REPLY) };
    }
    return { action: "start", updateId, replies: splitTelegramText(unauthorizedReply()) };
  }

  if (cmd === "feedback") {
    if (!owner) {
      return { action: "unauthorized", updateId, replies: splitTelegramText(unauthorizedReply()) };
    }
    return {
      action: "feedback",
      updateId,
      replies: splitTelegramText(FEEDBACK_REPLY),
    };
  }

  if (cmd === "status") {
    if (!bound) {
      return { action: "unauthorized", updateId, replies: splitTelegramText(unauthorizedReply()) };
    }
    return {
      action: "status",
      updateId,
      replies: splitTelegramText("已绑定，会话运行中。"),
    };
  }

  if (cmd === "stop") {
    if (!isOwner(state, userId, chatId)) {
      return { action: "unauthorized", updateId, replies: splitTelegramText(unauthorizedReply()) };
    }
    state.sessionStopped = true;
    return { action: "stop", updateId, replies: splitTelegramText("已停止 Telegram 会话。") };
  }

  if (cmd === "pair" || text.startsWith("/pair")) {
    const submitted = text.slice("/pair".length).trim();
    const result = tryPair(state, submitted, userId, chatId, now);
    if (result.ok) {
      return { action: "paired", updateId, replies: splitTelegramText("绑定成功。") };
    }
    return {
      action: "pair_failed",
      reason: result.reason,
      updateId,
      replies: splitTelegramText("配对失败。"),
    };
  }

  if (!bound) {
    return { action: "unauthorized", updateId, replies: splitTelegramText(unauthorizedReply()) };
  }

  return {
    action: "user_message",
    updateId,
    text: msg.text,
    userId,
    chatId,
  };
}
