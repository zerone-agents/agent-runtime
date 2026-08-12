# Run Agent API

`POST /v1/agents/:id/runs` — the same endpoint supports both streaming and blocking responses via **`Accept` header content negotiation** (Streamable HTTP).

## Streaming (SSE)

Send `Accept: text/event-stream` to receive token-level streaming with `partial_message` events (text deltas, thinking chunks, tool_use progress).

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Hello"}'
```

```
event: system
data: {"type":"system","subtype":"init",...}

event: partial_message
data: {"type":"partial_message","partial":{"type":"thinking","text":"Let me..."}}

event: partial_message
data: {"type":"partial_message","partial":{"type":"text","text":"Hello!"}}

event: partial_message
data: {"type":"partial_message","partial":{"type":"tool_use","tool_name":"Read",...}}

event: assistant
data: {"type":"assistant","message":{"role":"assistant","content":[...]}}

event: tool_result
data: {"type":"tool_result","result":{...}}

event: result
data: {"type":"result","subtype":"success",...}

event: done
data: {}
```

## SSE Block Mode

Add `stream: "block"` in the body to receive SSE with complete messages only — no `partial_message` events. Useful when you want streaming but don't need token-level granularity.

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Hello","stream":"block"}'
```

## Blocking (JSON)

Send `Accept: application/json` to receive the complete result as a single JSON response.

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{"message":"Hello"}'
```

### Error responses (blocking mode)

If the upstream LLM fails (rate limit, auth failure, connection error, etc.), the response is a non-200 status with `state: "failed"` instead of a success-looking empty result:

- `429` — upstream rate limit (`errorType: "rate_limit"`)
- `502` — all other upstream failures (e.g. `errorType: "auth"`, `"error_during_execution"`)

```json
{
  "runId": "...",
  "sessionId": "...",
  "state": "failed",
  "error": "HTTP 429: too many requests",
  "errorType": "rate_limit",
  "errors": ["HTTP 429: too many requests"],
  "text": "",
  "usage": {},
  "numTurns": 0,
  "durationMs": 5
}
```

`text` may contain partial output generated before the failure. Clients should check the HTTP status code (or `state` / `error` fields) to distinguish success from failure. A run that was cancelled via `POST /v1/runs/:runId/cancel` still returns 200 with `state: "cancelled"` — cancellation takes precedence over error reporting.

## Backward Compatibility

The legacy `stream` body field is still supported when no `Accept` header is provided:

- `stream: true` or `"raw"` (default) → SSE with `partial_message` events
- `stream: "block"` → SSE without `partial_message` events
- `stream: false` → JSON blocking response

For new integrations, prefer the `Accept` header approach (Streamable HTTP) as it follows standard HTTP content negotiation.
