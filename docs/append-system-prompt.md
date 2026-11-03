# Context Injection (`appendSystemPrompt`)

`appendSystemPrompt` appends extra context to the very end of the system
prompt. It has two entry points that stack:

- **Config-level** — declared per agent in `agents.yaml` (or
  `agent.config.ts`). Fixed at deploy time; applies to the root agent AND
  every mounted child.
- **Request-level** — passed in the `POST /v1/agents/:agentId/runs` body.
  Per-run injection; applies to that run only and is never persisted.

Both are optional and independent: use either one, or both (they are joined
with a blank line, config-level first).

## Where it lands

The runtime merges the value(s) into the SDK agent definition's
`appendPrompt`; the final system prompt assembles as:

```text
base prompt (systemPrompt/systemPromptFile + <datasets>)
→ SDK environment block (env / skills / subagents / deferred tools / AGENTS.md)
→ config-level appendSystemPrompt (agents.yaml)
→ request-level appendSystemPrompt (runs body)
```

The appends land after the environment block — the last thing the model
reads before the conversation starts.

## Config-level vs request-level

|             | Config-level                                          | Request-level                                       |
|-------------|--------------------------------------------------------|-----------------------------------------------------|
| Declared in | `agents.yaml` / `agent.config.ts`                      | runs request body                                   |
| Timing      | deploy time, fixed per agent                           | every run, caller-supplied                          |
| Applies to  | root agent + all mounted children                      | that run's root agent only                          |
| Persistence | lives with the config                                  | never persisted to the session                      |
| Typical use | stable project/team/language constraints               | per-business context: user tier, channel, task type |

## Lifecycle and boundaries

- Request-level injection is effective for **this run only**. It is never
  written to the session: a follow-up run on the same `sessionId` without
  the field runs without it — resend it on every run that needs it.
- Subagents spawned via `Task`/`MultiTask` do **not** inherit the
  request-level append; they only carry their own config-level value, if any.
- Cron-triggered runs carry the config-level append automatically (it is
  part of the agent definition). There is no request-level entry point for
  cron or the CLI.
- The runtime performs no conflict resolution between the two levels — they
  simply stack.

## Validation and errors

Request-level field in the runs body:

- Must be a string when present. Any non-string type returns `400` with
  `{"error": "Invalid request: appendSystemPrompt must be a string"}`.
- An empty string (`""`) or `null` is treated as absent (same precedent as
  `attachments: []`).

Config-level field in `agents.yaml`:

- Declared as `z.string().min(1).optional()` — an empty string fails config
  load with a ZodError. An empty append is meaningless at deploy time, so
  there is no "empty means absent" equivalent at this level.

## Trust and safety

- Request-level injection shares the same trust boundary as `message`: any
  caller that can start a run can inject. There is no gate and no length
  cap; deployments control callers with `auth.apiKey`.
- **Recommended**: keep credentials out of `agents.yaml` and inject
  `ZERONE_AGENT_API_KEY` via environment variables. The schema does allow
  `apiKey` in config — this is a recommendation, not an enforcement.

## Choosing between the two levels

- Stable constraints that rarely change (project layout, build commands,
  team conventions, language policy) → **config-level**.
- Per-request context that varies with the business (user tier, channel,
  campaign, task type) → **request-level**.
- Both is a valid setup: config-level for the stable base, request-level for
  the per-caller delta.

## Version requirement and probing

- Floor: **runtime ≥ 2.10.0**. On older runtimes the field is silently
  ignored — unknown runs-body fields are dropped, and unknown
  `agents.yaml` keys are stripped by the schema. No error is raised.
- **Probing**: `GET /health` returns `version` (plus `capabilities` bits,
  designed for hub-side capability detection). Gate the feature on
  `version >= 2.10.0` and degrade or refuse otherwise — do not assume the
  version. With `:latest`-tagged deployments the actual version is
  determined by the last container recreate, not by the config.

## See also

- [`docs/api/runs.md`](api/runs.md) — request-body field contract
  (`appendSystemPrompt`)
- [`examples/append-system-prompt/`](../examples/append-system-prompt/) —
  runnable three-step demo (config-level, request-level stacking,
  per-run-only lifecycle)
