# Cron HTTP API

All `/v1/cron/*` routes require the `x-api-key` header when auth is enabled
(same as the rest of `/v1/*`). Error bodies are `{"error": string, "code": string}`.

## GET /v1/cron/status — always mounted

```json
{
  "enabled": true, "running": true,
  "runtimeId": "ephemeral-per-process",
  "configId": "sha256-of-canonical-config-dir",
  "dataId": "sha256-of-canonical-cron-dir",
  "taskCount": 4, "activeExecutionCount": 1
}
```

`configId`/`dataId` are identity digests for CLI mismatch protection — not credentials, no absolute paths. When cron is disabled, status returns `200` with `enabled: false`; every other `/v1/cron` route returns `503 {"code":"cron_disabled"}`.

## Tasks

| Method | Path | Success | Notes |
|---|---|---|---|
| GET | /v1/cron/tasks?agentId=&limit=&offset= | 200 | `{items, limit, offset, total}` |
| POST | /v1/cron/tasks | 201 | body `{name?, cron, prompt, agentId}` |
| GET | /v1/cron/tasks/:taskId | 200 / 404 | |
| PATCH | /v1/cron/tasks/:taskId | 200 / 404 | only `name`/`cron`/`prompt`/`agentId` |
| DELETE | /v1/cron/tasks/:taskId | 204 / 404 | |
| POST | /v1/cron/tasks/:taskId/run | 202 | `{executionId, status}` after durable claim (`pending`/`skipped`/`duplicate`) |

## Executions

- `GET /v1/cron/executions?taskId=&agentId=&status=&trigger=&from=&to=&limit=&offset=` — in-memory projection; stable sort `scheduledFireTime DESC, id DESC`; response `{items, limit, offset, total}`.
- `GET /v1/cron/executions/:executionId` — 200 / 404.

## Status codes

201 created · 200 read/update · 204 delete · 202 run accepted · 400 `invalid_request`/`cron_invalid` · 404 `task_not_found`/`execution_not_found`/`agent_not_found` · 409 conflict · 503 `cron_disabled`/`agent_unavailable` · 500 `internal`

Immediate execution uses the SDK's `enqueueNow()`: the HTTP response returns
after the execution claim is durable; the agent continues in the background
under the same coordinator as scheduled runs.
