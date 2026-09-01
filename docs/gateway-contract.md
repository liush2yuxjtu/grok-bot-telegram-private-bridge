# Sand gateway contract (loopback only)

This document is the Telegram↔Grok Bot bridge contract for talking to the **local Sand gateway**. It records **endpoint names** and **non-sensitive field schemas** observed on a local host. It does **not** contain tokens, agent names, agent ids, or message bodies.

## Binding rules

- Read `$GATEWAY_PATH` in memory.
- Use **only** these fields: `scheme` (default `http`), `port`, `token` (Authorization).
- **Never** connect to the `host` bind address if it is `0.0.0.0`. Always call `http://127.0.0.1:<port>`.
- Do not listen on public ports. Do not copy or log the gateway token. Do not print non-`host` fields of `gateway.json`.
- Auth header: `Authorization: Bearer <token>`.
- JSON RPC: `POST /api/<method>` with `Content-Type: application/json`. Unknown method → HTTP 404 `{ message: string, failureCode: "gateway/unknown-method" }`.

## Observed `gateway.json`

- `host` (bind): `0.0.0.0` → clients **must** use loopback `127.0.0.1`.
- File mode on the host: `0600` (host still `0.0.0.0`; clients still connect only to `127.0.0.1`). Do not chmod this host store from the bridge.

## Endpoints

### `GET /health`

Liveness. No body.

**Response 200** `application/json`:

| field | type |
| --- | --- |
| `ok` | boolean |
| `pid` | number |
| `isBusy` | boolean |
| `busyOnlyAwaitingApproval` | boolean |
| `activeAgentId` | string |
| `startedAt` | number |
| `lastBusyAtMs` | number |

Use `activeAgentId` in memory as the current Grok Bot agent for `sendPrompt`. Do not log it.

### `POST /api/listAgents`

**Request:** `{}` (no required args).

**Response 200** `application/json`: array of agent rows.

Each row (keys only; values omitted):

- identity: `id`, `name`, `description`, `title`, `path`, `origin`, `isGroup`, `memberIds`
- avatar: `avatarDataUrl`, `avatarVersion`, `avatarShape`, `avatarColor`
- flags: `isActive`, `isRunning`, `isComposingMessage`, `isRunningTurn`, `isRetrying`, `hasUnread`, `unreadCount`, `isHiddenFromSidebar`, `notificationsEnabled`, `notifyOnUpdatesEnabled`
- timestamps: `createdAt`, `updatedAt`, `lastViewedAt`, `lastActivityAt`
- last message (do **not** forward these to Telegram): `lastEntry` `{ kind, text }`, `lastMessageId`, `lastMessagePreview`, `lastMessagePreviewSource`, `lastMessageAuthorId`, `newestEntryId`, `pushMessageContent`
- turn: `awaitingUserResponse`, `lastTurnSettlement` `{ clientNonce, outcome, settledAtMs }`, `currentActivity` `{ kind, tool, detail, callId }`
- snapshot: `snapshotEpoch`, `snapshotSeq`

The bridge must not copy `name` / `id` / message text into logs or Telegram except as needed to route a prompt.

### `POST /api/sendPrompt`

Deliver one user prompt to a specific agent.

**Request:**

| field | type | required | notes |
| --- | --- | --- | --- |
| `prompt` | string | yes | Telegram `message.text` after untrusted handling and 8 KiB cap |
| `agentId` | string | yes | from `/health.activeAgentId` (or a chosen row `id`) |
| `clientNonce` | string | recommended | UUID; used to poll settlement |
| `sessionId` | string | no | |
| `attachmentPaths` | array | no | unused for Telegram text |

**Response 200** `application/json`:

| field | type |
| --- | --- |
| `accepted` | boolean |

`accepted: true` means the gateway queued the turn. It is **not** the final assistant reply. Do not send this object to Telegram.

### `POST /api/promptAcceptanceStatus`

Poll whether the turn identified by `clientNonce` has settled.

**Request:**

| field | type | required |
| --- | --- | --- |
| `accountSlot` | string | yes |
| `clientNonce` | string | yes (same nonce passed to `sendPrompt`) |
| `agentId` | string | no |
| `sessionId` | string | no |

**Response 200** `application/json`:

| field | type |
| --- | --- |
| `outcome` | string |

`outcome` is a settlement enum (do not treat it as the assistant text). Poll until settled; exponential backoff capped at 30s is the bridge policy, not a gateway requirement.

### `POST /api/getAgentTranscriptTail`

Fetch recent transcript entries after a turn. **Only the final assistant text** for the Telegram-triggered turn may be forwarded. Never forward tool traces, secrets, or earlier messages.

**Request:**

| field | type |
| --- | --- |
| `id` | string (agent id) |
| `limit` | number |

**Response 200** `application/json`:

| field | type |
| --- | --- |
| `entries` | array |
| `nextBeforeSeq` | number |

Each entry:

| field | type |
| --- | --- |
| `kind` | string |
| `id` | string |
| `message` | `{ type: string, content: string }` |
| `timestampMs` | number |
| `requestId` | string |

Bridge rule: wait until the Telegram-triggered turn is settled, then take the last assistant `message.content` for that turn only. Split to Telegram 4096-char chunks.

### `GET /events`

Server-Sent Events. Optional completion signal alongside `promptAcceptanceStatus`.

- Status 200
- `Content-Type: text/event-stream`
- Query: `?channels=` (optional)
- Observed SSE preamble includes `retry: 1000`

Do not log event payloads that contain prompts, tokens, or agent names.

### Other (not used by the bridge)

- `POST /prepare-upgrade` → `{ quiescing, runningTurns }`
- Related methods seen in the gateway surface: `getTranscript`, `getAgentTranscript`, `openAgent`, `interruptAgentRun`. The bridge uses `sendPrompt` + `promptAcceptanceStatus` + `getAgentTranscriptTail`.

## Probe record

| # | call | result |
| --- | --- | --- |
| 1 | `GET /health` | success |
| 2 | `POST /api/listAgents` | success |
| 3 | `POST /api/sendPrompt` (`prompt` = `bridge-probe-ignore`) | success (`accepted`) |
| 4 | `POST /api/promptAcceptanceStatus` + `POST /api/getAgentTranscriptTail` | success |
| N/A | `GET /events` | success (SSE) |

Failed probes would report HTTP status only. None failed.

## Bridge mapping

1. Load gateway.json → loopback base URL + bearer token (memory only).
2. `GET /health` → `activeAgentId`.
3. `POST /api/sendPrompt` with Telegram text and a fresh `clientNonce`.
4. Poll `POST /api/promptAcceptanceStatus` until `outcome` is terminal.
5. `POST /api/getAgentTranscriptTail` → last assistant message of that turn.
6. Split and send only that text to Telegram.
