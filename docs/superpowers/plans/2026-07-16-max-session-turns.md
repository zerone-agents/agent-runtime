# maxSessionTurns Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add support for SDK 0.7.0's `maxSessionTurns` parameter to limit conversation rounds sent to LLM.

**Architecture:** Three-layer implementation: config schema → registry → HTTP router. Optional field at each layer with no defaults (undefined = unlimited). Request-level override takes precedence over config-level value.

**Tech Stack:** TypeScript, Zod, Vitest, Hono

## Global Constraints

- SDK version: `@zerone-agent/open-agent-sdk` ^0.7.0 (already updated)
- ESM only: all imports use `.js` extension
- Backward compatible: no default values, undefined = SDK default behavior
- Test coverage: all new fields must have tests

---

## Task 1: Config Schema + Tests

**Files:**
- Modify: `src/config.ts:55` (AgentDefinitionSchema)
- Test: `src/__tests__/config.test.ts`

**Interfaces:**
- Consumes: Zod schema pattern from existing `maxTurns` field
- Produces: `AgentDefinition.maxSessionTurns?: number`

- [ ] **Step 1: Write failing config tests**

Open `src/__tests__/config.test.ts` and add after line 399 (after the subagents maxTurns test):

```typescript
describe("maxSessionTurns", () => {
  it("parses maxSessionTurns when provided", () => {
    const yaml = `
agents:
  - id: assistant
    model: claude-sonnet-4-6
    maxSessionTurns: 50
`
    const config = loadYamlConfigFromString(yaml)
    expect(config.agents[0].maxSessionTurns).toBe(50)
  })

  it("leaves maxSessionTurns undefined when not provided", () => {
    const yaml = `
agents:
  - id: assistant
    model: claude-sonnet-4-6
`
    const config = loadYamlConfigFromString(yaml)
    expect(config.agents[0].maxSessionTurns).toBeUndefined()
  })
})
```

Note: You'll need to check if `loadYamlConfigFromString` exists. If not, use the existing test pattern (likely `RuntimeConfigSchema.parse(parseYaml(yaml))`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/config.test.ts -t "maxSessionTurns"`
Expected: FAIL with "maxSessionTurns" not recognized or undefined

- [ ] **Step 3: Add maxSessionTurns to AgentDefinitionSchema**

Open `src/config.ts` and modify the AgentDefinitionSchema (around line 55):

```typescript
const AgentDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  model: z.string().default("claude-sonnet-4-6"),
  systemPrompt: z.string().optional(),
  systemPromptFile: z.string().optional(),
  maxTurns: z.number().default(10),
  maxSessionTurns: z.number().optional(),  // NEW: add this line
  allowedTools: z.array(z.string()).optional(),
  disallowedTools: z.array(z.string()).optional(),
  settingSources: z.array(z.enum(["user", "project", "local"])).optional(),
  extraUserSkillDirs: z.array(z.string()).optional(),
  extraProjectSkillDirs: z.array(z.string()).optional(),
  mcpServers: z.record(McpServerConfigSchema).optional(),
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan", "dontAsk", "auto"]).optional(),
  thinking: ThinkingConfigSchema.optional(),
  datasets: z.record(z.string()).optional(),
  subagents: z.record(SubagentDefinitionSchema).optional(),
}).refine(
  (data) => !(data.systemPrompt && data.systemPromptFile),
  { message: "systemPrompt and systemPromptFile are mutually exclusive" },
)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/config.test.ts -t "maxSessionTurns"`
Expected: PASS (2 tests)

- [ ] **Step 5: Run all config tests**

Run: `npx vitest run src/__tests__/config.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat(config): add maxSessionTurns field to AgentDefinitionSchema"
```

---

## Task 2: Registry Layer + Tests

**Files:**
- Modify: `src/registry.ts:103,147` (createOpts and getDetail)
- Test: `src/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition.maxSessionTurns?: number` from Task 1
- Produces: `AgentDetail.maxSessionTurns?: number` and passes to SDK createAgent

- [ ] **Step 1: Write failing registry tests**

Open `src/__tests__/registry.test.ts` and add a new describe block (find a good location after existing tests):

```typescript
describe("maxSessionTurns", () => {
  it("passes maxSessionTurns to createAgent when configured", async () => {
    const mockCreateAgent = vi.mocked(createAgent)
    const registry = new AgentRegistry()
    const config: RuntimeConfig = {
      server: { host: "0.0.0.0", port: 3000 },
      agents: [{ 
        id: "test", 
        model: "claude-sonnet-4-6", 
        maxTurns: 10,
        maxSessionTurns: 50 
      }],
    }
    
    await registry.loadFromConfig(config, "/tmp")
    registry.create("test")
    
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxSessionTurns: 50 })
    )
  })

  it("passes undefined maxSessionTurns when not configured", async () => {
    const mockCreateAgent = vi.mocked(createAgent)
    const registry = new AgentRegistry()
    const config: RuntimeConfig = {
      server: { host: "0.0.0.0", port: 3000 },
      agents: [{ id: "test", model: "claude-sonnet-4-6", maxTurns: 10 }],
    }
    
    await registry.loadFromConfig(config, "/tmp")
    registry.create("test")
    
    expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ maxSessionTurns: undefined })
    )
  })

  it("includes maxSessionTurns in getDetail when configured", async () => {
    const registry = new AgentRegistry()
    const config: RuntimeConfig = {
      server: { host: "0.0.0.0", port: 3000 },
      agents: [{ 
        id: "test", 
        model: "claude-sonnet-4-6", 
        maxTurns: 10,
        maxSessionTurns: 50 
      }],
    }
    
    await registry.loadFromConfig(config, "/tmp")
    const detail = registry.getDetail("test")
    
    expect(detail?.maxSessionTurns).toBe(50)
  })

  it("omits maxSessionTurns from getDetail when not configured", async () => {
    const registry = new AgentRegistry()
    const config: RuntimeConfig = {
      server: { host: "0.0.0.0", port: 3000 },
      agents: [{ id: "test", model: "claude-sonnet-4-6", maxTurns: 10 }],
    }
    
    await registry.loadFromConfig(config, "/tmp")
    const detail = registry.getDetail("test")
    
    expect(detail?.maxSessionTurns).toBeUndefined()
    expect(detail).not.toHaveProperty("maxSessionTurns")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/registry.test.ts -t "maxSessionTurns"`
Expected: FAIL (type errors or undefined values)

- [ ] **Step 3: Add maxSessionTurns to AgentDetail interface**

Open `src/registry.ts` and add to the AgentDetail interface (around line 35-52):

```typescript
export interface AgentDetail {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  maxTurns: number
  maxSessionTurns?: number  // NEW: add this line
  hasSystemPrompt: boolean
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  availableSkills?: SkillSummary[]
  settingSources?: string[]
  extraUserSkillDirs?: string[]
  extraProjectSkillDirs?: string[]
  mcpServers?: Record<string, McpServerSummary>
  subagents?: Record<string, { description: string }>
  datasets?: Record<string, string>
}
```

- [ ] **Step 4: Pass maxSessionTurns to createAgent opts**

Open `src/registry.ts` and modify the opts object in loadFromConfig (around line 95-111):

```typescript
const opts: CreateOpts = {
  model: process.env.OPENAGENT_MODEL ?? def.model,
  apiType: (process.env.OPENAGENT_API_TYPE as any) ?? undefined,
  apiKey: process.env.OPENAGENT_API_KEY ?? undefined,
  baseURL: process.env.OPENAGENT_BASE_URL ?? undefined,
  systemPrompt,
  allowedTools: def.allowedTools,
  disallowedTools: def.disallowedTools,
  maxTurns: def.maxTurns,
  maxSessionTurns: def.maxSessionTurns,  // NEW: add this line
  permissionMode: def.permissionMode,
  settingSources: def.settingSources,
  extraUserSkillDirs: def.extraUserSkillDirs,
  extraProjectSkillDirs: def.extraProjectSkillDirs,
  mcpServers: convertMcpServers(def.mcpServers),
  thinking: def.thinking as any,
  agents: def.subagents as any,
}
```

- [ ] **Step 5: Conditionally add maxSessionTurns in getDetail**

Open `src/registry.ts` and modify the getDetail method (around line 142-168). Add this line after setting maxTurns:

```typescript
const detail: AgentDetail = {
  id: def.id,
  name: def.name ?? def.id,
  model: def.model ?? "",
  status,
  maxTurns: def.maxTurns ?? 10,
  hasSystemPrompt: Boolean(def.systemPrompt || def.systemPromptFile),
}
if (def.maxSessionTurns !== undefined) {
  detail.maxSessionTurns = def.maxSessionTurns  // NEW: add these 3 lines
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run src/__tests__/registry.test.ts -t "maxSessionTurns"`
Expected: PASS (4 tests)

- [ ] **Step 7: Run all registry tests**

Run: `npx vitest run src/__tests__/registry.test.ts`
Expected: All tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/registry.ts src/__tests__/registry.test.ts
git commit -m "feat(registry): pass maxSessionTurns to SDK and expose in AgentDetail"
```

---

## Task 3: Router Layer + Tests

**Files:**
- Modify: `src/router/agent.ts:30,46,51,56` (POST /:agentId/runs handler)
- Test: `src/__tests__/router-agent.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry.create()` from Task 2
- Produces: HTTP API accepts `maxSessionTurns` in request body, passes to SDK methods

- [ ] **Step 1: Write failing router tests**

Open `src/__tests__/router-agent.test.ts` and add a new describe block:

```typescript
describe("maxSessionTurns parameter", () => {
  it("passes maxSessionTurns to agent.query in blocking mode", async () => {
    const mockQuery = vi.fn().mockReturnValue(async function* () {
      yield { type: "result", result: { text: "ok", usage: {}, num_turns: 1, duration_ms: 1 } }
    })
    const mockAgent = {
      query: mockQuery,
      prompt: vi.fn(),
      close: vi.fn(),
      getSessionId: () => "test-session",
    }
    vi.mocked(createAgent).mockReturnValue(mockAgent as any)

    const app = createApp()
    const res = await app.request("/v1/agents/test/runs", {
      method: "POST",
      body: JSON.stringify({ 
        message: "hello", 
        stream: "block",
        maxSessionTurns: 20 
      }),
    })

    expect(mockQuery).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ maxSessionTurns: 20 })
    )
  })

  it("passes maxSessionTurns to agent.query in SSE mode", async () => {
    const mockQuery = vi.fn().mockReturnValue(async function* () {
      yield { type: "result", result: { text: "ok", usage: {}, num_turns: 1, duration_ms: 1 } }
    })
    const mockAgent = {
      query: mockQuery,
      prompt: vi.fn(),
      close: vi.fn(),
      getSessionId: () => "test-session",
    }
    vi.mocked(createAgent).mockReturnValue(mockAgent as any)

    const app = createApp()
    const res = await app.request("/v1/agents/test/runs", {
      method: "POST",
      body: JSON.stringify({ 
        message: "hello", 
        stream: true,
        maxSessionTurns: 15 
      }),
    })

    expect(mockQuery).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ maxSessionTurns: 15 })
    )
  })

  it("passes maxSessionTurns to agent.prompt in sync mode", async () => {
    const mockPrompt = vi.fn().mockResolvedValue({
      text: "response",
      usage: {},
      num_turns: 1,
      duration_ms: 1,
    })
    const mockAgent = {
      query: vi.fn(),
      prompt: mockPrompt,
      close: vi.fn(),
      getSessionId: () => "test-session",
    }
    vi.mocked(createAgent).mockReturnValue(mockAgent as any)

    const app = createApp()
    const res = await app.request("/v1/agents/test/runs", {
      method: "POST",
      body: JSON.stringify({ 
        message: "hello", 
        stream: false,
        maxSessionTurns: 25 
      }),
    })

    expect(mockPrompt).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ maxSessionTurns: 25 })
    )
  })

  it("passes undefined maxSessionTurns when not provided", async () => {
    const mockPrompt = vi.fn().mockResolvedValue({
      text: "response",
      usage: {},
      num_turns: 1,
      duration_ms: 1,
    })
    const mockAgent = {
      query: vi.fn(),
      prompt: mockPrompt,
      close: vi.fn(),
      getSessionId: () => "test-session",
    }
    vi.mocked(createAgent).mockReturnValue(mockAgent as any)

    const app = createApp()
    const res = await app.request("/v1/agents/test/runs", {
      method: "POST",
      body: JSON.stringify({ message: "hello", stream: false }),
    })

    expect(mockPrompt).toHaveBeenCalledWith(
      "hello",
      expect.objectContaining({ maxSessionTurns: undefined })
    )
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/__tests__/router-agent.test.ts -t "maxSessionTurns"`
Expected: FAIL (parameter not passed)

- [ ] **Step 3: Extract maxSessionTurns from request body**

Open `src/router/agent.ts` and modify the POST handler (around line 30):

```typescript
router.post("/:agentId/runs", async (c) => {
  const { agentId } = c.req.param()

  const body = await c.req.json().catch(() => null)
  if (!body?.message) {
    return c.json({ error: "Invalid request: message is required" }, 400)
  }

  const { message, sessionId, stream = true, maxSessionTurns } = body  // MODIFIED: add maxSessionTurns

  const status = registry.getStatus(agentId)
  if (status === "not_found") {
    return c.json({ error: "Agent not found" }, 404)
  }
  if (status === "unavailable") {
    return c.json({ error: "Agent unavailable" }, 503)
  }

  const agent = registry.create(agentId, sessionId)
  if (!agent) {
    return c.json({ error: "Agent not found" }, 404)
  }

  if (stream === "block") {
    const agentStream = agent.query(message, { maxSessionTurns })  // MODIFIED: pass maxSessionTurns
    return streamAgentResponse(c, agentStream, () => agent.close())
  }

  if (stream === true || stream === "raw") {
    const agentStream = agent.query(message, { 
      includePartialMessages: true,
      maxSessionTurns  // MODIFIED: pass maxSessionTurns
    })
    return streamAgentResponse(c, agentStream, () => agent.close())
  }

  try {
    const result = await agent.prompt(message, { maxSessionTurns })  // MODIFIED: pass maxSessionTurns
    metrics.recordRun(agentId, result.usage, undefined)
    return c.json({
      sessionId: agent.getSessionId(),
      text: result.text,
      usage: result.usage,
      numTurns: result.num_turns,
      durationMs: result.duration_ms,
    })
  } finally {
    await agent.close()
  }
})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/__tests__/router-agent.test.ts -t "maxSessionTurns"`
Expected: PASS (4 tests)

- [ ] **Step 5: Run all router-agent tests**

Run: `npx vitest run src/__tests__/router-agent.test.ts`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/router/agent.ts src/__tests__/router-agent.test.ts
git commit -m "feat(router): accept maxSessionTurns in POST /runs request body"
```

---

## Task 4: Documentation + Examples

**Files:**
- Modify: `README.md` (configuration table and examples)
- Modify: `agents.yaml` (add example)

**Interfaces:**
- Consumes: All previous tasks complete
- Produces: User-facing documentation

- [ ] **Step 1: Update README.md configuration table**

Open `README.md` and find the agent configuration table (around line 152). Add a new row after `maxTurns`:

```markdown
| `maxTurns` | No | `10` | Max agentic loop turns |
| `maxSessionTurns` | No | unlimited | Max conversation rounds sent to LLM (context window) |
```

- [ ] **Step 2: Add maxSessionTurns to a YAML example**

Open `README.md` and find the first agents.yaml example (around line 18-30). Add `maxSessionTurns` to one agent:

```yaml
agents:
  - id: assistant
    name: AI Assistant
    model: claude-sonnet-4-6
    systemPrompt: You are a helpful assistant.
    maxTurns: 10
    maxSessionTurns: 50  # Limit context to 50 conversation rounds
    allowedTools:
      - read
      - write
      - execute
```

- [ ] **Step 3: Update agents.yaml example file**

Open `agents.yaml` (root directory) and add `maxSessionTurns` to one agent as an example (optional, around line 19):

```yaml
agents:
  - id: assistant
    name: AI Assistant
    model: claude-sonnet-4-6
    systemPromptFile: system-prompts/assistant.md
    maxTurns: 10
    maxSessionTurns: 50  # Optional: limit context window
    # ... rest of config
```

- [ ] **Step 4: Verify documentation renders correctly**

Run: `cat README.md | grep -A 2 maxSessionTurns`
Expected: See the new table row

- [ ] **Step 5: Commit**

```bash
git add README.md agents.yaml
git commit -m "docs: add maxSessionTurns to configuration documentation"
```

---

## Task 5: Final Verification

**Files:**
- None (verification only)

**Interfaces:**
- Consumes: All previous tasks complete
- Produces: Verified working implementation

- [ ] **Step 1: Run type checking**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All 200+ tests PASS

- [ ] **Step 3: Build the project**

Run: `npm run build`
Expected: Build succeeds, dist/ directory created

- [ ] **Step 4: Test with a real example (optional)**

If you have a running instance:
```bash
# Start the server
npm start

# In another terminal, test the API
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello", "maxSessionTurns": 10}'
```

- [ ] **Step 5: Create pull request (if on a branch)**

```bash
git push origin <branch-name>
gh pr create --title "feat: add maxSessionTurns support" --body "..."
```

- [ ] **Step 6: Final commit (if any fixes needed)**

```bash
git add .
git commit -m "fix: address review feedback"
```

---

## Summary

**Total Tasks:** 5  
**Estimated Time:** 30-45 minutes  
**Files Modified:** 7 (3 source + 3 test + 1 docs)  
**Tests Added:** 10 (2 config + 4 registry + 4 router)

**Execution Order:** Sequential (Task 1 → 2 → 3 → 4 → 5)
