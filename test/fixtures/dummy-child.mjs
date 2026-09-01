#!/usr/bin/env node
// Test-only child: ignore Telegram, loop until SIGTERM (exit 0).
// Tests may kill -9 this process to simulate a crash. No secrets.

const timer = setInterval(() => {}, 1000);

function halt() {
  clearInterval(timer);
  process.exit(0);
}

process.on("SIGTERM", halt);
process.on("SIGINT", halt);
