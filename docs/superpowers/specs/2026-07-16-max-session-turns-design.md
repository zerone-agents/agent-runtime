# maxSessionTurns Support Design

**Date**: 2026-07-16  
**Status**: Approved  
**SDK Version**: 0.7.0+

## Overview

Add support for SDK 0.7.0's `maxSessionTurns` parameter, which limits the number of conversation rounds sent to the LLM (context window truncation). The full session transcript is preserved; only the API call is truncated.

### Difference from maxTurns

- **maxTurns**: Limits the agent's agentic loop (tool call iterations)
- **maxSessionTurns**: Limits conversation history sent to LLM (context window size)

## Design Decisions

### Default Behavior
**Decision**: No default value (undefined = unlimited, SDK default behavior)

**Rationale**: 
- Fully backward compatible
- No behavior change for existing deployments
- Users opt-in explicitly

### Approach
**Selected**: Approach A - Minimal Complete Support

- Configuration layer: `agents.yaml` supports `maxSessionTurns` (optional)
- Request layer: HTTP API supports dynamic `maxSessionTurns` per request (optional)
- API exposure: `AgentDetail` returns `maxSessionTurns` if configured
- Priority: Request param > Config value > SDK default (unlimited)

## Implementation

### 1. Configuration Layer (config.ts)

Add optional field to `AgentDefinitionSchema`:

```typescript
const AgentDefinitionSchema = z.object({
  // ...existing fields
  maxTurns: z.number().default(10),
  maxSessionTurns: z.number().optional(),  // NEW: no default
})
```

**Type**:
```typescript
export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>
// maxSessionTurns?: number
```

### 2. Registry Layer (registry.ts)

Pass to `createAgent`:

```typescript
const opts: CreateOpts = {
  // ...existing fields
  maxTurns: def.maxTurns,
  maxSessionTurns: def.maxSessionTurns,  // NEW: undefined if not configured
}
```

**AgentDetail interface**:
```typescript
export interface AgentDetail {
  // ...existing fields
  maxSessionTurns?: number  // NEW: conditional return
}
```

**getDetail() implementation**:
```typescript
if (def.maxSessionTurns !== undefined) {
  detail.maxSessionTurns = def.maxSessionTurns
}
```

### 3. Request Layer (router/agent.ts)

Support dynamic override per request:

```typescript
router.post("/:agentId/runs", async (c) => {
  const body = await c.req.json().catch(() => null)
  const { message, sessionId, stream = true, maxSessionTurns } = body  // NEW

  const agent = registry.create(agentId, sessionId)

  // Blocking mode
  if (stream === "block") {
    const agentStream = agent.query(message, { maxSessionTurns })
    return streamAgentResponse(c, agentStream, () => agent.close())
  }

  // SSE mode
  if (stream === true || stream === "raw") {
    const agentStream = agent.query(message, { 
      includePartialMessages: true,
      maxSessionTurns  // NEW
    })
    return streamAgentResponse(c, agentStream, () => agent.close())
  }

  // Sync mode
  const result = await agent.prompt(message, { maxSessionTurns })  // NEW
  // ...
})
```

### 4. Priority Resolution

```
Request body maxSessionTurns  (highest)
        ↓ (if undefined)
Agent config maxSessionTurns
        ↓ (if undefined)
SDK default (unlimited)
```

The SDK handles this automatically:
- `createAgent({ maxSessionTurns: 50 })` sets agent-level default
- `agent.query(msg, { maxSessionTurns: 10 })` overrides per request
- If both undefined, SDK uses unlimited

## Testing Strategy

### config.test.ts
- Parse YAML with `maxSessionTurns: 50` → field equals 50
- Parse YAML without field → field is undefined
- Validate type (must be number)

### registry.test.ts
- `createAgent` receives `maxSessionTurns` from config
- `createAgent` receives undefined when not configured
- `getDetail()` includes `maxSessionTurns` when configured
- `getDetail()` omits field when not configured

### router-agent.test.ts
- Request with `maxSessionTurns: 20` passes to `agent.query()`
- Request without field doesn't override agent config
- All three modes (block/SSE/sync) support the parameter

## Documentation Updates

### README.md
Add to agent configuration table:
```
| `maxSessionTurns` | No | unlimited | Max conversation rounds sent to LLM |
```

### agents.yaml example
```yaml
agents:
  - id: assistant
    model: claude-sonnet-4-6
    maxTurns: 10
    maxSessionTurns: 50  # Limit context window to 50 rounds
```

### API documentation
Update request body and response schemas to include `maxSessionTurns`.

## Files to Modify

1. `src/config.ts` - Add schema field
2. `src/registry.ts` - Pass to SDK, expose in AgentDetail
3. `src/router/agent.ts` - Accept in request body, pass to SDK methods
4. `src/__tests__/config.test.ts` - Config parsing tests
5. `src/__tests__/registry.test.ts` - Registry behavior tests
6. `src/__tests__/router-agent.test.ts` - Request layer tests
7. `README.md` - Documentation
8. `agents.yaml` (examples) - Usage examples

## Backward Compatibility

✅ **Fully backward compatible**
- No default value means existing behavior unchanged
- Optional field in config and request body
- No breaking changes to existing APIs

## Migration Path

No migration needed. Users can adopt incrementally:
1. Add `maxSessionTurns` to agent config (optional)
2. Pass `maxSessionTurns` in API requests (optional)
3. Existing deployments work unchanged
