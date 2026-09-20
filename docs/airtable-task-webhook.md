# Airtable → Grokbot event task bridge

This path wakes an existing Grok Bot only when Airtable emits an event. It does **not** poll Airtable and does not carry executable task text in the webhook.

## Source of truth

- Airtable base: `appoOASxNv8XKlrvQ`
- Table: `tblQIjjgdRz7xt1Zr` (`Grokbot Tasks`)
- Trigger condition: `Status = Ready`

The HTTP payload is intentionally tiny:

```json
{"recordId":"rec...","eventId":"evt-..."}
```

No `Instruction`, shell command, credential, or arbitrary prompt is accepted by the HTTP receiver. The receiver rejects extra payload keys. After the wake event reaches the local Sand gateway, Grokbot must use its connected Airtable tool to re-read the exact record, verify `Status=Ready`, claim the row, and only then execute the Airtable `Instruction`.

## Runtime

The receiver binds only to `127.0.0.1:8790` by default.

- `GET /healthz` → process health, includes `polling:false`
- `POST /v1/notify` → one event
- 4 KiB payload cap
- strict record/event ID validation
- event-ID dedupe
- bounded per-minute rate limit
- no task-discovery timers
- no cron

The existing Sand gateway may briefly check turn settlement *after* an event has already started a Grok Bot turn. That is not task discovery and does not scan Airtable.

## Start / stop

```bash
bin/start-airtable-tasks
bin/status-airtable-tasks
bin/stop-airtable-tasks
```

Environment overrides:

```bash
AIRTABLE_TASK_HOST=127.0.0.1
AIRTABLE_TASK_PORT=8790
AIRTABLE_TASK_RATE_LIMIT_PER_MINUTE=12
GATEWAY_PATH="$HOME/sand-data/gateway.json"
GROK_AGENT_NAME="optional exact Grok Bot name"
```

No Airtable API token is stored by this receiver. Airtable access stays inside Grokbot's connected Airtable tool boundary.

## Funnel

Bootstrap may add a dedicated Tailscale Funnel path that reverse-proxies only to the loopback receiver:

```bash
tailscale funnel --bg --yes --set-path=/agent-tasks localhost:8790
```

Do not reset Funnel configuration and do not replace existing `/` or `/project-registry` routes.

Airtable Automation should POST to:

```text
https://grokbot.tail6a877d.ts.net/agent-tasks/v1/notify
```

with only `recordId` and a unique `eventId`.
