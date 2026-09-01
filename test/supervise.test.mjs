import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  chmodSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readTokenFile } from "../src/telegram-client.mjs";

const execFileAsync = promisify(execFile);

const PROJECT = fileURLToPath(new URL("..", import.meta.url));
const BIN = join(PROJECT, "bin");
const DUMMY_CHILD = join(PROJECT, "test/fixtures/dummy-child.mjs");
const FAKE_TOKEN = "999000:AAFakeTokenNotRealSupervise";

function writeMode(path, content, mode = 0o600) {
  writeFileSync(path, content, { mode });
  chmodSync(path, mode);
}

function alive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(fn, timeoutMs = 5000, intervalMs = 50) {
  const start = Date.now();
  let lastErr;
  for (;;) {
    try {
      if (fn()) return;
    } catch (e) {
      lastErr = e;
    }
    if (Date.now() - start > timeoutMs) {
      const extra = lastErr ? `: ${lastErr.message}` : "";
      throw new Error(`timeout waiting for condition${extra}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function parseStatus(stdout) {
  const s = String(stdout).trim();
  if (s === "stopped") return { state: "stopped", raw: s };
  const m = /^running pid=(\d+) child=(\d+)$/.exec(s);
  if (!m) return { state: "unknown", raw: s };
  return { state: "running", pid: Number(m[1]), child: Number(m[2]), raw: s };
}

async function runBin(name, env, { allowFail = false } = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(join(BIN, name), {
      env,
      timeout: 10_000,
      encoding: "utf8",
    });
    return { code: 0, stdout: stdout || "", stderr: stderr || "" };
  } catch (e) {
    const result = {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout || "",
      stderr: e.stderr || "",
    };
    if (!allowFail) {
      throw new Error(
        `${name} failed code=${result.code} stdout=${JSON.stringify(result.stdout)} stderr=${JSON.stringify(result.stderr)}`
      );
    }
    return result;
  }
}

async function psArgs(pids) {
  const args = ["-ww", "-o", "args="];
  for (const p of pids) {
    args.push("-p", String(p));
  }
  try {
    const { stdout } = await execFileAsync("ps", args, {
      encoding: "utf8",
      timeout: 3000,
    });
    return stdout || "";
  } catch (e) {
    return e.stdout || "";
  }
}

function makeEnv(tmp, tokenPath) {
  return {
    PATH: `${BIN}:/usr/bin:/bin:${process.env.PATH || ""}`,
    HOME: process.env.HOME || homedir(),
    BRIDGE_ROOT: tmp,
    TELEGRAM_TOKEN_FILE: tokenPath,
    BRIDGE_CHILD: DUMMY_CHILD,
    LANG: "C",
  };
}

function killPid(pid) {
  if (!alive(pid)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    /* ignore */
  }
}

async function stopEnv(env, extraPids = []) {
  if (env) {
    try {
      await runBin("stop", env, { allowFail: true });
    } catch {
      /* ignore */
    }
  }
  for (const pid of extraPids) killPid(pid);
  if (env?.BRIDGE_ROOT) {
    for (const name of ["supervise.pid", "child.pid"]) {
      const f = join(env.BRIDGE_ROOT, "run", name);
      if (!existsSync(f)) continue;
      const pid = Number(String(readFileSync(f, "utf8")).replace(/\D/g, ""));
      killPid(pid);
    }
  }
}

describe("supervise recovery", { concurrency: false }, () => {
  let tmp;
  let tokenPath;
  let env;
  let supervisePid;
  let childPid;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "tgb-sup-"));
    chmodSync(tmp, 0o700);
    const secrets = join(tmp, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    chmodSync(secrets, 0o700);
    tokenPath = join(secrets, "token");
    writeMode(tokenPath, FAKE_TOKEN, 0o600);
    env = makeEnv(tmp, tokenPath);
  });

  after(async () => {
    await stopEnv(env, [supervisePid, childPid]);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("start → status running, supervise+child pids alive", async () => {
    const started = await runBin("start", env);
    assert.equal(started.stdout.trim(), "started");
    assert.equal(started.stdout.includes(FAKE_TOKEN), false);
    assert.equal(started.stderr.includes(FAKE_TOKEN), false);

    const st = parseStatus((await runBin("status", env)).stdout);
    assert.equal(st.state, "running");
    assert.ok(alive(st.pid), "supervise pid alive");
    assert.ok(alive(st.child), "child pid alive");
    supervisePid = st.pid;
    childPid = st.child;
  });

  it("status output contains running and does not contain fake token", async () => {
    const res = await runBin("status", env);
    assert.match(res.stdout, /running/);
    assert.equal(res.stdout.includes(FAKE_TOKEN), false);
    assert.equal(res.stderr.includes(FAKE_TOKEN), false);
  });

  it("no token leak in ps argv or supervise.log", async () => {
    const st = parseStatus((await runBin("status", env)).stdout);
    assert.equal(st.state, "running");
    const args = await psArgs([st.pid, st.child]);
    assert.equal(args.includes(FAKE_TOKEN), false);
    const logPath = join(tmp, "run", "supervise.log");
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
    assert.equal(log.includes(FAKE_TOKEN), false);
  });

  it("kill-child/restart: new child pid after SIGKILL", async () => {
    const before = parseStatus((await runBin("status", env)).stdout);
    assert.equal(before.state, "running");
    const oldChild = before.child;
    process.kill(oldChild, "SIGKILL");
    await waitUntil(() => {
      let raw;
      try {
        raw = readFileSync(join(tmp, "run", "child.pid"), "utf8");
      } catch {
        return false;
      }
      const n = Number(String(raw).replace(/\D/g, ""));
      return Boolean(n && n !== oldChild && alive(n) && alive(before.pid));
    }, 5000);
    const after = parseStatus((await runBin("status", env)).stdout);
    assert.equal(after.state, "running");
    assert.notEqual(after.child, oldChild);
    assert.ok(alive(after.child));
    assert.equal(after.pid, before.pid);
    childPid = after.child;
    supervisePid = after.pid;

    const args = await psArgs([after.pid, after.child]);
    assert.equal(args.includes(FAKE_TOKEN), false);
    const log = readFileSync(join(tmp, "run", "supervise.log"), "utf8");
    assert.equal(log.includes(FAKE_TOKEN), false);
  });

  it("stop → status stopped, pids dead", async () => {
    const before = parseStatus((await runBin("status", env)).stdout);
    const res = await runBin("stop", env);
    assert.equal(res.stdout.trim(), "stopped");
    assert.equal(res.stdout.includes(FAKE_TOKEN), false);
    const st = parseStatus((await runBin("status", env)).stdout);
    assert.equal(st.state, "stopped");
    assert.equal(st.raw, "stopped");
    if (before.state === "running") {
      assert.equal(alive(before.pid), false);
      assert.equal(alive(before.child), false);
    }
    supervisePid = undefined;
    childPid = undefined;
  });
});

describe("start rejects token mode 0644", { concurrency: false }, () => {
  let tmp;
  let tokenPath;
  let env;

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), "tgb-sup-mode-"));
    chmodSync(tmp, 0o700);
    const secrets = join(tmp, "secrets");
    mkdirSync(secrets, { mode: 0o700 });
    chmodSync(secrets, 0o700);
    tokenPath = join(secrets, "token");
    writeMode(tokenPath, FAKE_TOKEN, 0o644);
    env = makeEnv(tmp, tokenPath);
  });

  after(async () => {
    await stopEnv(env);
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it("readTokenFile and start reject 0644", async () => {
    assert.throws(() => readTokenFile(tokenPath), /0600/);
    const res = await runBin("start", env, { allowFail: true });
    assert.notEqual(res.code, 0);
    assert.equal((res.stdout + res.stderr).includes(FAKE_TOKEN), false);
    assert.match(res.stderr, /0600/);
    const st = parseStatus((await runBin("status", env)).stdout);
    assert.equal(st.state, "stopped");
  });
});
