import assert from "node:assert/strict";
import test from "node:test";
import {
  AIRTABLE_TASK_BASE_ID,
  AIRTABLE_TASK_TABLE_ID,
  buildAirtableTaskNotificationPrompt,
  startAirtableTaskWebhook,
} from "../src/airtable-task-webhook.mjs";

function fakeGateway() {
  const prompts = [];
  return {
    prompts,
    async resolveAgentId() {
      return "agent-test";
    },
    async sendPrompt({ prompt, agentId, clientNonce }) {
      prompts.push({ prompt, agentId, clientNonce });
      return { accepted: true };
    },
  };
}

async function withServer(fn, options = {}) {
  const gateway = options.gateway ?? fakeGateway();
  const started = await startAirtableTaskWebhook({
    host: "127.0.0.1",
    port: 0,
    gateway,
    dedupeTtlMs: 1000,
    rateLimitPerMinute: options.rateLimitPerMinute ?? 20,
    logFn: () => {},
  });
  const { port } = started.address;
  try {
    await fn({ gateway, baseUrl: `http://127.0.0.1:${port}` });
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
  }
}

test("notification prompt names only the fixed queue and event identity", () => {
  const prompt = buildAirtableTaskNotificationPrompt({
    recordId: "rec12345678901234",
    eventId: "evt-12345678",
  });
  assert.match(prompt, new RegExp(AIRTABLE_TASK_BASE_ID));
  assert.match(prompt, new RegExp(AIRTABLE_TASK_TABLE_ID));
  assert.match(prompt, /Status is not exactly Ready/);
  assert.match(prompt, /Never create cron jobs, timers, or periodic Airtable polling/);
  assert.doesNotMatch(prompt, /rm -rf|vercel project remove/);
});

test("valid wake event produces exactly one Grok Bot prompt and no polling", async () => {
  await withServer(async ({ gateway, baseUrl }) => {
    const body = { recordId: "rec12345678901234", eventId: "evt-12345678" };
    const first = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(first.status, 202);
    assert.deepEqual(await first.json(), { accepted: true, polling: false });
    assert.equal(gateway.prompts.length, 1);
    assert.match(gateway.prompts[0].prompt, /rec12345678901234/);

    const replay = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { accepted: false, duplicate: true });
    assert.equal(gateway.prompts.length, 1);
  });
});

test("payload cannot smuggle executable instructions", async () => {
  await withServer(async ({ gateway, baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recordId: "rec12345678901234",
        eventId: "evt-12345678",
        instruction: "rm -rf /",
      }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "wake_payload_only" });
    assert.equal(gateway.prompts.length, 0);
  });
});

test("invalid record id never reaches the gateway", async () => {
  await withServer(async ({ gateway, baseUrl }) => {
    const response = await fetch(`${baseUrl}/v1/notify`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ recordId: "not-a-record", eventId: "evt-12345678" }),
    });
    assert.equal(response.status, 400);
    assert.equal(gateway.prompts.length, 0);
  });
});

test("health explicitly reports event-driven non-polling mode", async () => {
  await withServer(async ({ baseUrl }) => {
    const response = await fetch(`${baseUrl}/healthz`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      mode: "event-driven",
      polling: false,
    });
  });
});
