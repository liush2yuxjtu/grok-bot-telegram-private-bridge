import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import {
  emptyState,
  splitTelegramText,
  atomicWriteJson,
  loadState,
  saveState,
  redactError,
  issuePairing,
  tryPair,
  processUpdate,
  commandName,
  FEEDBACK_REPLY,
  FEEDBACK_STAR_URL,
  FEEDBACK_DISCUSSIONS_URL,
  FEEDBACK_ISSUE_URL,
  BOUND_START_REPLY,
  nextBackoffMs,
  parseRetryAfter,
  backoffForTelegramError,
  classifyGatewayError,
  utf8ByteLength,
  TELEGRAM_MAX,
  MAX_TEXT_BYTES,
  PAIRING_TTL_MS,
  PAIRING_MAX_ATTEMPTS,
  BACKOFF_CAP_MS,
} from "../src/bridge.mjs";

function priv(text, { updateId = 1, userId = 100, chatId = 200 } = {}) {
  return {
    update_id: updateId,
    message: {
      text,
      from: { id: userId },
      chat: { id: chatId, type: "private" },
    },
  };
}

describe("unauthorized reject", () => {
  it("rejects unknown private users", () => {
    const state = emptyState();
    const r = processUpdate(state, priv("hello", { userId: 9, chatId: 9 }));
    assert.equal(r.action, "unauthorized");
    assert.match(r.replies.join(""), /未绑定/);
  });

  it("ignores non-private chats", () => {
    const state = emptyState();
    const r = processUpdate(state, {
      update_id: 2,
      message: {
        text: "hello",
        from: { id: 1 },
        chat: { id: 2, type: "group" },
      },
    });
    assert.equal(r.action, "ignore");
  });
});

describe("pair expiry and attempts", () => {
  it("expires after 10 minutes", () => {
    const state = emptyState();
    const now = 1_000_000;
    const { code } = issuePairing(state, now, (n) => Buffer.alloc(n, 7));
    const late = tryPair(state, code, 1, 2, now + PAIRING_TTL_MS + 1);
    assert.equal(late.ok, false);
    assert.equal(late.reason, "expired");
  });

  it("locks after 5 mismatches", () => {
    const state = emptyState();
    issuePairing(state, 0, (n) => Buffer.alloc(n, 1));
    let last;
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      last = tryPair(state, "deadbeef", 1, 2, 0);
    }
    assert.equal(last.ok, false);
    assert.equal(last.reason, "too_many_attempts");
    const extra = tryPair(state, Buffer.alloc(16, 1).toString("hex"), 1, 2, 0);
    assert.equal(extra.ok, false);
    assert.equal(extra.reason, "too_many_attempts");
  });
});

describe("owner bind", () => {
  it("binds unique owner and accepts their messages", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => randomBytes(n));
    const paired = processUpdate(
      state,
      priv(`/pair ${code}`, { updateId: 10, userId: 42, chatId: 99 }),
      0
    );
    assert.equal(paired.action, "paired");
    assert.deepEqual(state.owner, { userId: 42, chatId: 99 });
    const msg = processUpdate(state, priv("hi", { updateId: 11, userId: 42, chatId: 99 }));
    assert.equal(msg.action, "user_message");
    assert.equal(msg.text, "hi");
    const other = processUpdate(state, priv("nope", { updateId: 12, userId: 7, chatId: 8 }));
    assert.equal(other.action, "unauthorized");
  });

  it("owner /stop stops session without dropping bind", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => randomBytes(n));
    processUpdate(state, priv(`/pair ${code}`, { updateId: 1, userId: 42, chatId: 99 }), 0);
    const stop = processUpdate(state, priv("/stop", { updateId: 2, userId: 42, chatId: 99 }));
    assert.equal(stop.action, "stop");
    assert.equal(state.sessionStopped, true);
    assert.ok(state.owner);
    const after = processUpdate(state, priv("hi", { updateId: 3, userId: 42, chatId: 99 }));
    assert.equal(after.action, "unauthorized");
  });
});

describe("overlong message", () => {
  it("rejects over 8 KiB utf8", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => randomBytes(n));
    processUpdate(state, priv(`/pair ${code}`, { updateId: 1, userId: 1, chatId: 1 }), 0);
    const big = "x".repeat(MAX_TEXT_BYTES + 1);
    assert.ok(utf8ByteLength(big) > MAX_TEXT_BYTES);
    const r = processUpdate(state, priv(big, { updateId: 2, userId: 1, chatId: 1 }));
    assert.equal(r.action, "too_long");
  });
});

describe("duplicate update_id", () => {
  it("ignores repeats", () => {
    const state = emptyState();
    const a = processUpdate(state, priv("/start", { updateId: 50, userId: 3, chatId: 4 }));
    const b = processUpdate(state, priv("/start", { updateId: 50, userId: 3, chatId: 4 }));
    assert.equal(a.action, "start");
    assert.equal(b.action, "duplicate");
  });
});

describe("offset restore", () => {
  it("atomically persists and reloads offset", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgb-"));
    const file = join(dir, "state.json");
    try {
      const state = emptyState();
      processUpdate(state, priv("/start", { updateId: 77 }));
      saveState(file, state);
      assert.equal(statSync(file).mode & 0o777, 0o600);
      const loaded = loadState(file);
      assert.equal(loaded.offset, 78);
      assert.deepEqual(loaded.seenUpdateIds, [77]);
      const again = processUpdate(loaded, priv("/start", { updateId: 77 }));
      assert.equal(again.action, "duplicate");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomicWriteJson replaces without leftover tmp", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgbw-"));
    const file = join(dir, "x.json");
    try {
      atomicWriteJson(file, { a: 1 });
      atomicWriteJson(file, { a: 2 });
      assert.equal(JSON.parse(readFileSync(file, "utf8")).a, 2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a permissive or symlinked state file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tgbs-"));
    const file = join(dir, "state.json");
    try {
      writeFileSync(file, "{}\n", { mode: 0o644 });
      chmodSync(file, 0o644);
      assert.throws(() => loadState(file), /0600/);
      chmodSync(file, 0o600);
      const link = join(dir, "state-link.json");
      symlinkSync(file, link);
      assert.throws(() => loadState(link), /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("reply split", () => {
  it("splits at 4096", () => {
    const parts = splitTelegramText("a".repeat(TELEGRAM_MAX + 10));
    assert.equal(parts.length, 2);
    assert.equal(parts[0].length, TELEGRAM_MAX);
    assert.equal(parts[1].length, 10);
  });

  it("does not split a Unicode surrogate pair", () => {
    const parts = splitTelegramText(`${"a".repeat(TELEGRAM_MAX - 1)}😀b`);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].endsWith("😀"), true);
    assert.equal(parts[1], "b");
  });
});

describe("log redaction", () => {
  it("redacts bot token, Bearer, and API URLs", () => {
    const s = redactError(
      "fetch https://api.telegram.org/bot123456:AASecretTokenHere/getUpdates Authorization: Bearer abc.def failed token=shh"
    );
    assert.equal(s.includes("AASecretTokenHere"), false);
    assert.equal(s.includes("abc.def"), false);
    assert.equal(s.includes("api.telegram.org"), false);
    assert.match(s, /\[redacted/);
  });

  it("does not log pairing code", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => Buffer.alloc(n, 9));
    const logLine = redactError(`pair fail update_id=3 status=mismatch`);
    assert.equal(logLine.includes(code), false);
  });
});

describe("gateway unavailable", () => {
  it("classifies connection errors without leaking urls", () => {
    const err = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1340"), {
      code: "ECONNREFUSED",
    });
    const c = classifyGatewayError(err);
    assert.equal(c.unavailable, true);
    assert.equal(c.log.includes("127.0.0.1"), false);
  });
});

describe("Telegram 429 retry_after", () => {
  it("parses parameters.retry_after seconds and caps at 30s", () => {
    assert.equal(parseRetryAfter({ parameters: { retry_after: 2 } }), 2000);
    assert.equal(parseRetryAfter({ parameters: { retry_after: 90 } }), BACKOFF_CAP_MS);
    assert.equal(parseRetryAfter({ "Retry-After": "5" }), 5000);
    assert.equal(backoffForTelegramError({ parameters: { retry_after: 1 } }, 8), 1000);
  });

  it("exponential backoff caps at 30s", () => {
    assert.equal(nextBackoffMs(0), 1000);
    assert.equal(nextBackoffMs(1), 2000);
    assert.equal(nextBackoffMs(10), BACKOFF_CAP_MS);
  });
});

describe("/feedback", () => {
  it("recognizes /feedback and /feedback@bot", () => {
    assert.equal(commandName("/feedback"), "feedback");
    assert.equal(commandName("/feedback@SomeBot"), "feedback");
    assert.equal(commandName("/feedback extra"), "feedback");
    assert.equal(commandName("feedback"), null);
  });

  it("owner gets the three exact public URLs", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => randomBytes(n));
    processUpdate(state, priv(`/pair ${code}`, { updateId: 1, userId: 42, chatId: 99 }), 0);
    const r = processUpdate(state, priv("/feedback", { updateId: 2, userId: 42, chatId: 99 }));
    assert.equal(r.action, "feedback");
    const body = r.replies.join("");
    assert.equal(body, FEEDBACK_REPLY);
    assert.equal(body.includes(FEEDBACK_STAR_URL), true);
    assert.equal(body.includes(FEEDBACK_DISCUSSIONS_URL), true);
    assert.equal(body.includes(FEEDBACK_ISSUE_URL), true);
    assert.equal(
      FEEDBACK_STAR_URL,
      "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge"
    );
    assert.equal(
      FEEDBACK_DISCUSSIONS_URL,
      "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge/discussions"
    );
    assert.equal(
      FEEDBACK_ISSUE_URL,
      "https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge/issues/new/choose"
    );
    const start = processUpdate(state, priv("/start", { updateId: 3, userId: 42, chatId: 99 }));
    assert.match(start.replies.join(""), /\/feedback/);
    assert.equal(start.replies.join(""), BOUND_START_REPLY);
  });

  it("rejects unbound users without URLs or runtime status", () => {
    const state = emptyState();
    const r = processUpdate(state, priv("/feedback", { updateId: 5, userId: 7, chatId: 8 }));
    assert.equal(r.action, "unauthorized");
    const body = r.replies.join("");
    assert.equal(body.includes("github.com"), false);
    assert.equal(body.includes("已绑定"), false);
    assert.equal(body.includes("会话运行中"), false);
    assert.match(body, /未绑定/);
  });

  it("does not treat normal owner text as /feedback", () => {
    const state = emptyState();
    const { code } = issuePairing(state, 0, (n) => randomBytes(n));
    processUpdate(state, priv(`/pair ${code}`, { updateId: 1, userId: 42, chatId: 99 }), 0);
    const msg = processUpdate(state, priv("please /feedback later", { updateId: 2, userId: 42, chatId: 99 }));
    assert.equal(msg.action, "user_message");
    assert.equal(msg.text, "please /feedback later");
  });
});
