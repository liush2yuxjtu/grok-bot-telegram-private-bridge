#!/usr/bin/env node
import { issuePairing, loadState, saveState } from "./bridge.mjs";

const statePath =
  process.env.STATE_PATH ||
  (process.env.HOME
    ? `${process.env.HOME}/.local/share/telegram-grok-bridge/state.json`
    : "state.json");

const state = loadState(statePath);
const { code, expiresAt } = issuePairing(state);
saveState(statePath, state);

process.stdout.write(`/pair ${code}\nexpires ${new Date(expiresAt).toISOString()}\n`);
