# Contributing

Use [Discussions](https://github.com/liush2yuxjtu/grok-bot-telegram-private-bridge/discussions) for setup reports and ideas. Use Issues for reproducible compatibility bugs.

Before opening an issue:

1. Revoke any credential that appeared in chat, a screenshot, or a log.
2. Remove Telegram tokens, gateway tokens, pairing codes, chat IDs, user IDs, agent IDs, usernames, message text, and personal paths.
3. Include the Grok Bot version, Node.js version, failing command, shortest redacted error, and whether the gateway file was recreated by an update.

Before submitting code:

```bash
npm test
npm run check
```

Keep the runtime dependency-free unless a standard-library implementation cannot meet a measured requirement. Do not add telemetry.

Report security problems through [private vulnerability reporting](SECURITY.md), never a public issue.
