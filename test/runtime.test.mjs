import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  writeFileSync,
  chmodSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { startBridge } from "../src/main.mjs";
import { emptyState, saveState } from "../src/bridge.mjs";
import {
  wrapTelegramPayload,
  extractNewFinalAssistant,
  loadGatewayConfig,
  GatewayClient,
  TELEGRAM_UNTRUSTED_OPEN,
  TELEGRAM_UNTRUSTED_CLOSE,
} from "../src/gateway-client.mjs";
import { readTokenFile } from "../src/telegram-client.mjs";

const FAKE_TG_TOKEN = "999000:AAFakeTokenNotReal";
const FAKE_GW_TOKEN = "test-gw-token-not-real";

function writeMode(path, content, mode = 0o600) {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), "tgb-rt-"));
  chmodSync(dir, 0o700);
  return dir;
}

function priv(text, { updateId = 1, userId = 1, chatId = 1 } = {}) {
  return {
    update_id: updateId,
    message: {
      text,
      from: { id: userId },
      chat: { id: chatId, type: "private" },
    },
  };
}

function writeJson(res, status, json) {
  const b = Buffer.from(JSON.stringify(json), "utf8");
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": b.length,
    connection: "close",
  });
  res.end(b);
}

function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

function closeServer(server) {
  return new Promise((resolve) => {
    try {
      server.closeAllConnections();
    } catch {
      /* ignore */
    }
    server.close(() => resolve());
  });
}

function waitUntil(fn, timeoutMs = 2000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      try {
        if (fn()) {
          resolve();
          return;
        }
      } catch {
        /* retry */
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error("timeout waiting for condition"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createTelegramFake(handlers = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const segs = u.pathname.split("/").filter(Boolean);
    const method = segs[segs.length - 1] || "";
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      const call = {
        method,
        body,
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        req,
        res,
      };
      calls.push(call);
      Promise.resolve()
        .then(() => {
          const custom = handlers[method];
          if (typeof custom === "function") return custom(call);
          return undefined;
        })
        .then((result) => {
          if (result === undefined) {
            if (typeof handlers[method] === "function") return;
            if (method === "getWebhookInfo") {
              writeJson(res, 200, { ok: true, result: { url: "" } });
              return;
            }
            if (method === "getUpdates") {
              writeJson(res, 200, { ok: true, result: [] });
              return;
            }
            if (method === "sendMessage") {
              writeJson(res, 200, { ok: true, result: { message_id: 1 } });
              return;
            }
            writeJson(res, 200, { ok: true, result: true });
            return;
          }
          if (result === false) return;
          const status = result.status ?? 200;
          const json = result.json ?? result;
          writeJson(res, status, json);
        })
        .catch(() => {
          if (!res.headersSent) writeJson(res, 500, { ok: false });
        });
    });
  });
  return { server, calls };
}

function createGatewayFake(handlers = {}) {
  const calls = [];
  const server = createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      let body = {};
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        body = {};
      }
      const path = u.pathname;
      calls.push({
        method: req.method,
        path,
        body,
        auth: Boolean(req.headers.authorization),
      });
      const custom = handlers[path] || handlers[`${req.method} ${path}`];
      Promise.resolve()
        .then(() => (typeof custom === "function" ? custom({ body, req, res, path }) : undefined))
        .then((result) => {
          if (result === undefined) {
            if (typeof custom === "function") return;
            writeJson(res, 404, { message: "unknown", failureCode: "gateway/unknown-method" });
            return;
          }
          if (result === false) return;
          writeJson(res, result.status ?? 200, result.json ?? result);
        })
        .catch(() => {
          if (!res.headersSent) writeJson(res, 500, { message: "fake error" });
        });
    });
  });
  return { server, calls };
}

function writeGateway(path, port) {
  writeMode(
    path,
    `${JSON.stringify({
      host: "0.0.0.0",
      port,
      scheme: "http",
      token: FAKE_GW_TOKEN,
    })}\n`
  );
}

function bridgeOpts({ files, tgPort, ac, extra } = {}) {
  return {
    tokenFile: files.tokenFile,
    gatewayPath: files.gatewayPath,
    statePath: files.statePath,
    telegramApiBase: `http://127.0.0.1:${tgPort}`,
    pollTimeoutSec: 0,
    heartbeatMs: 0,
    signal: ac?.signal,
    waitFn: async () => {},
    pollDelayMs: 10,
    timeoutMs: 2500,
    logFn: () => {},
    ...extra,
  };
}

function makeFiles() {
  const dir = tempDir();
  const tokenFile = join(dir, "token");
  const gatewayPath = join(dir, "gateway.json");
  const statePath = join(dir, "state.json");
  writeMode(tokenFile, `${FAKE_TG_TOKEN}\n`);
  return { dir, tokenFile, gatewayPath, statePath };
}

describe("wrapTelegramPayload markers", () => {
  it("wraps text between fixed untrusted markers", () => {
    const p = wrapTelegramPayload("hello");
    assert.ok(p.includes(TELEGRAM_UNTRUSTED_OPEN));
    assert.ok(p.includes("hello"));
    assert.ok(p.includes(TELEGRAM_UNTRUSTED_CLOSE));
    assert.match(p, /untrusted/i);
    const inner = p.split(TELEGRAM_UNTRUSTED_OPEN)[1].split(TELEGRAM_UNTRUSTED_CLOSE)[0];
    assert.ok(inner.includes("hello"));
    assert.equal(p.includes("```"), false);
  });
});

describe("extractNewFinalAssistant ignores old ids", () => {
  it("returns only new assistant content", () => {
    const before = [
      {
        id: "old",
        kind: "message",
        message: { type: "assistant", content: "OLD_SHOULD_NOT_FORWARD" },
      },
    ];
    const after = [
      ...before,
      {
        id: "tool1",
        kind: "tool",
        message: { type: "tool", content: "TRACE" },
      },
      {
        id: "new",
        kind: "message",
        message: { type: "assistant", content: "ONLY_NEW_FINAL" },
      },
    ];
    assert.equal(extractNewFinalAssistant(before, after), "ONLY_NEW_FINAL");
  });

  it("extracts live send-message text and skips inbound message", () => {
    const before = [
      {
        id: "old",
        kind: "send-message",
        message: { type: "text", content: "OLD_SHOULD_NOT_FORWARD" },
      },
    ];
    const after = [
      ...before,
      { id: "in", kind: "message", message: { type: null } },
      {
        id: "new",
        kind: "send-message",
        message: { type: "text", content: "LIVE_FINAL" },
      },
    ];
    assert.equal(extractNewFinalAssistant(before, after), "LIVE_FINAL");
  });
});

describe("submitAndWaitFinalReply live settlement", () => {
  it("uses listAgents lastTurnSettlement when promptAcceptanceStatus is not-found", async () => {
    const oldEntry = {
      id: "old",
      kind: "send-message",
      message: { type: "text", content: "OLD_SHOULD_NOT_FORWARD" },
      timestampMs: 1,
    };
    const inbound = { id: "in", kind: "message", message: { type: null }, timestampMs: 2 };
    const newEntry = {
      id: "new",
      kind: "send-message",
      message: { type: "text", content: "LIVE_FINAL" },
      timestampMs: 3,
    };
    let sent = false;
    let nonce = null;
    const gw = createGatewayFake({
      "/health": () => ({
        json: {
          ok: true,
          activeAgentId: "agent-test",
          pid: 1,
          isBusy: false,
          busyOnlyAwaitingApproval: false,
          startedAt: 1,
          lastBusyAtMs: 0,
        },
      }),
      "/api/listAgents": () => ({
        json: [
          {
            id: "agent-test",
            isActive: true,
            isRunningTurn: !sent,
            lastTurnSettlement: sent
              ? { clientNonce: nonce, outcome: "success", settledAtMs: 9 }
              : { clientNonce: "prev", outcome: "success", settledAtMs: 1 },
          },
        ],
      }),
      "/api/sendPrompt": ({ body }) => {
        nonce = body.clientNonce;
        sent = true;
        return { json: { accepted: true } };
      },
      "/api/promptAcceptanceStatus": () => ({ json: { outcome: "not-found" } }),
      "/api/getAgentTranscriptTail": () => {
        if (!sent) return { json: { entries: [oldEntry], nextBeforeSeq: 0 } };
        return { json: { entries: [oldEntry, inbound, newEntry], nextBeforeSeq: 0 } };
      },
    });
    try {
      const port = await listen(gw.server);
      const client = new GatewayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: FAKE_GW_TOKEN,
        pollDelayMs: 5,
        timeoutMs: 2000,
        maxWaitMs: 2000,
        waitFn: async () => {},
      });
      const text = await client.submitAndWaitFinalReply("ping");
      assert.equal(text, "LIVE_FINAL");
    } finally {
      await closeServer(gw.server);
    }
  });
});

describe("configured Grok Bot name", () => {
  it("routes to the exact named Bot instead of the active Bot", async () => {
    let sentAgentId = null;
    const gw = createGatewayFake({
      "/api/listAgents": () => ({
        json: [
          { id: "active-agent", name: "Other Bot", isActive: true },
          { id: "target-agent", name: "Telegram Bot", isActive: false },
        ],
      }),
      "/api/getAgentTranscriptTail": () => ({
        json: {
          entries: [
            {
              id: "reply",
              kind: "send-message",
              message: { type: "text", content: "named reply" },
            },
          ],
        },
      }),
      "/api/sendPrompt": ({ body }) => {
        sentAgentId = body.agentId;
        return { json: { accepted: true } };
      },
      "/api/promptAcceptanceStatus": () => ({ json: { outcome: "settled" } }),
    });
    try {
      const port = await listen(gw.server);
      const client = new GatewayClient({
        baseUrl: `http://127.0.0.1:${port}`,
        token: FAKE_GW_TOKEN,
        agentName: "Telegram Bot",
        waitFn: async () => {},
      });
      await client.submitAndWaitFinalReply("ping");
      assert.equal(sentAgentId, "target-agent");
    } finally {
      await closeServer(gw.server);
    }
  });
});

describe("readTokenFile permissions", () => {
  it("rejects 0644 and symlinks, accepts a regular 0600 file", () => {
    const dir = tempDir();
    try {
      const bad = join(dir, "bad");
      writeMode(bad, "secret-token\n", 0o644);
      assert.throws(() => readTokenFile(bad), /0600/);
      const good = join(dir, "good");
      writeMode(good, "  tok-value  \n", 0o600);
      assert.equal(readTokenFile(good), "tok-value");
      const link = join(dir, "link");
      symlinkSync(good, link);
      assert.throws(() => readTokenFile(link), /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadGatewayConfig boundary", () => {
  it("forces loopback and requires a regular 0600 file", () => {
    const dir = tempDir();
    try {
      const p = join(dir, "gateway.json");
      writeMode(
        p,
        `${JSON.stringify({
          host: "0.0.0.0",
          port: 1340,
          scheme: "http",
          token: FAKE_GW_TOKEN,
        })}\n`
      );
      const cfg = loadGatewayConfig(p);
      assert.equal(cfg.baseUrl, "http://127.0.0.1:1340");
      assert.equal(cfg.baseUrl.includes("0.0.0.0"), false);
      assert.equal(typeof cfg.token, "string");

      chmodSync(p, 0o644);
      assert.throws(() => loadGatewayConfig(p), /0600/);
      chmodSync(p, 0o600);
      const link = join(dir, "gateway-link.json");
      symlinkSync(p, link);
      assert.throws(() => loadGatewayConfig(link), /regular file/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("runtime fake http", () => {
  it("webhook already set", async () => {
    const files = makeFiles();
    const tg = createTelegramFake({
      getWebhookInfo: () => ({
        json: { ok: true, result: { url: "https://example.invalid/hook" } },
      }),
    });
    const gw = createGatewayFake();
    try {
      const tgPort = await listen(tg.server);
      const gwPort = await listen(gw.server);
      writeGateway(files.gatewayPath, gwPort);
      const result = await startBridge(bridgeOpts({ files, tgPort, extra: { signal: undefined } }));
      assert.equal(result.exitCode, 2);
      assert.equal(tg.calls.filter((c) => c.method === "deleteWebhook").length, 0);
      assert.equal(tg.calls.filter((c) => c.method === "getUpdates").length, 0);
      assert.ok(tg.calls.some((c) => c.method === "getWebhookInfo"));
    } finally {
      await closeServer(tg.server);
      await closeServer(gw.server);
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("poll/offset", async () => {
    const files = makeFiles();
    let updates = 0;
    const tg2 = createTelegramFake({
      getUpdates: (call) => {
        updates += 1;
        if (updates === 1) {
          return {
            json: {
              ok: true,
              result: [priv("/start", { updateId: 10, userId: 9, chatId: 9 })],
            },
          };
        }
        return { json: { ok: true, result: [] } };
      },
    });
    const gw = createGatewayFake();
    const ac = new AbortController();
    try {
      const tgPort = await listen(tg2.server);
      const gwPort = await listen(gw.server);
      writeGateway(files.gatewayPath, gwPort);
      const p = startBridge(bridgeOpts({ files, tgPort, ac }));
      await waitUntil(() =>
        tg2.calls.some(
          (c) =>
            c.method === "getUpdates" &&
            (c.body?.offset === 11 || Number(c.query?.offset) === 11)
        )
      );
      const offsetCalls = tg2.calls.filter((c) => c.method === "getUpdates");
      const first = offsetCalls[0];
      const firstOffset = first.body?.offset ?? first.query?.offset;
      assert.ok(firstOffset === 0 || firstOffset === undefined || firstOffset === null);
      const later = offsetCalls.find(
        (c) => c.body?.offset === 11 || Number(c.query?.offset) === 11
      );
      assert.ok(later);
      ac.abort();
      const result = await p;
      assert.equal(result.exitCode, 0);
    } finally {
      ac.abort();
      await closeServer(tg2.server);
      await closeServer(gw.server);
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("gateway submit + final reply", async () => {
    const files = makeFiles();
    saveState(files.statePath, { ...emptyState(), owner: { userId: 1, chatId: 1 } });
    let sent = false;
    const oldEntry = {
      id: "old",
      kind: "message",
      message: { type: "assistant", content: "OLD_SHOULD_NOT_FORWARD" },
      timestampMs: 1,
    };
    const newEntry = {
      id: "new",
      kind: "message",
      message: { type: "assistant", content: "ONLY_NEW_FINAL" },
      timestampMs: 2,
    };
    let updates = 0;
    const tg = createTelegramFake({
      getUpdates: () => {
        updates += 1;
        if (updates === 1) {
          return {
            json: { ok: true, result: [priv("hello", { updateId: 20, userId: 1, chatId: 1 })] },
          };
        }
        return { json: { ok: true, result: [] } };
      },
    });
    const gw = createGatewayFake({
      "/health": () => ({
        json: {
          ok: true,
          activeAgentId: "agent-test",
          pid: 1,
          isBusy: false,
          busyOnlyAwaitingApproval: false,
          startedAt: 1,
          lastBusyAtMs: 0,
        },
      }),
      "/api/sendPrompt": ({ body }) => {
        assert.equal(typeof body.prompt, "string");
        assert.ok(body.prompt.includes(TELEGRAM_UNTRUSTED_OPEN));
        assert.ok(body.prompt.includes("hello"));
        assert.ok(body.prompt.includes(TELEGRAM_UNTRUSTED_CLOSE));
        sent = true;
        return { json: { accepted: true } };
      },
      "/api/promptAcceptanceStatus": () => ({ json: { outcome: "settled" } }),
      "/api/getAgentTranscriptTail": () => {
        if (!sent) return { json: { entries: [oldEntry], nextBeforeSeq: 0 } };
        return { json: { entries: [oldEntry, newEntry], nextBeforeSeq: 0 } };
      },
    });
    const ac = new AbortController();
    try {
      const tgPort = await listen(tg.server);
      const gwPort = await listen(gw.server);
      writeGateway(files.gatewayPath, gwPort);
      const p = startBridge(bridgeOpts({ files, tgPort, ac }));
      await waitUntil(() =>
        tg.calls.some(
          (c) => c.method === "sendMessage" && String(c.body?.text || "").includes("ONLY_NEW_FINAL")
        )
      );
      const texts = tg.calls
        .filter((c) => c.method === "sendMessage")
        .map((c) => String(c.body?.text || ""));
      assert.ok(texts.some((t) => t === "ONLY_NEW_FINAL"));
      assert.equal(texts.some((t) => t.includes("OLD_SHOULD_NOT_FORWARD")), false);
      ac.abort();
      const result = await p;
      assert.equal(result.exitCode, 0);
    } finally {
      ac.abort();
      await closeServer(tg.server);
      await closeServer(gw.server);
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("429", async () => {
    const files = makeFiles();
    let updates = 0;
    const started = Date.now();
    const tg = createTelegramFake({
      getUpdates: () => {
        updates += 1;
        if (updates === 1) {
          return {
            status: 429,
            json: { ok: false, error_code: 429, parameters: { retry_after: 0 } },
          };
        }
        return { json: { ok: true, result: [] } };
      },
    });
    const gw = createGatewayFake();
    const ac = new AbortController();
    try {
      const tgPort = await listen(tg.server);
      const gwPort = await listen(gw.server);
      writeGateway(files.gatewayPath, gwPort);
      const p = startBridge(bridgeOpts({ files, tgPort, ac }));
      await waitUntil(() => tg.calls.filter((c) => c.method === "getUpdates").length >= 2);
      ac.abort();
      const result = await p;
      assert.equal(result.exitCode, 0);
      assert.ok(Date.now() - started < 2000);
      assert.ok(tg.calls.filter((c) => c.method === "getUpdates").length >= 2);
    } finally {
      ac.abort();
      await closeServer(tg.server);
      await closeServer(gw.server);
      rmSync(files.dir, { recursive: true, force: true });
    }
  });

  it("shutdown", async () => {
    const files = makeFiles();
    let hangingReq = null;
    let closed = false;
    const tg = createTelegramFake({
      getUpdates: (call) => {
        hangingReq = call.req;
        call.req.on("close", () => {
          closed = true;
        });
        call.req.on("aborted", () => {
          closed = true;
        });
        return false;
      },
    });
    const gw = createGatewayFake();
    const ac = new AbortController();
    const uncaught = [];
    const onUncaught = (err) => uncaught.push(err);
    process.on("uncaughtException", onUncaught);
    process.on("unhandledRejection", onUncaught);
    try {
      const tgPort = await listen(tg.server);
      const gwPort = await listen(gw.server);
      writeGateway(files.gatewayPath, gwPort);
      const p = startBridge(bridgeOpts({ files, tgPort, ac, extra: { timeoutMs: 8000 } }));
      await waitUntil(() => hangingReq != null);
      ac.abort();
      const result = await p;
      assert.equal(result.exitCode, 0);
      await waitUntil(() => closed || hangingReq.destroyed, 1000);
      assert.ok(closed || hangingReq.destroyed);
      assert.equal(uncaught.length, 0);
    } finally {
      process.off("uncaughtException", onUncaught);
      process.off("unhandledRejection", onUncaught);
      ac.abort();
      await closeServer(tg.server);
      await closeServer(gw.server);
      rmSync(files.dir, { recursive: true, force: true });
    }
  });
});
