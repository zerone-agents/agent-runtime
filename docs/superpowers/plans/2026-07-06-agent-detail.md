# Agent 详情端点实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展 `GET /v1/agents/:agentId` 让它返回 agent 的配置层完整信息（model、tools、MCP、skills、subagents 等），其中 MCP 的 `env` / `headers` 值强制脱敏为 `"***"`。

**Architecture:** 方案 A —— 在 `src/registry.ts` 新增 `AgentDetail` / `McpServerSummary` 类型与 `getDetail(agentId)` 实例方法，内部用 `sanitizeMcpServers()` 纯函数处理脱敏。路由层 `src/router/agent.ts` 改为薄壳调用 `registry.getDetail()`。脱敏逻辑可单测、不依赖 Hono。

**Tech Stack:** TypeScript（strict）、Zod、Vitest、Hono、Node.js 22

## Global Constraints

- 所有本地导入必须使用 `.js` 扩展名（ESM + NodeNext）。
- 不调 SDK：`getDetail` 纯粹读取 `defs` Map，不创建 agent、不需要 mock `@zerone-agent/open-agent-sdk`。
- `hasSystemPrompt` 和 `maxTurns` 始终返回；其他字段未配置时**省略**（不返回 `null`）。
- MCP 脱敏策略：`env` 与 `headers` 的 value 替换为 `"***"`，保留 key；`command`、`args`、`url` 原样。
- 即使 agent `status === "unavailable"`，`getDetail` 也返回完整 detail（`status` 字段为 `"unavailable"`）。
- `list()` / `getStatus()` / `create()` 行为不变；`GET /v1/agents`（列表）形态不变。
- 提交前必须运行 `npx tsc --noEmit` 和 `npm test`，全绿才能提交。
- 提交信息使用 conventional commits 前缀（`feat(agent-detail):`）。
- 设计文档（只读参考）：`docs/superpowers/specs/2026-07-06-agent-detail-endpoint-design.md`

---

## File Structure

| 文件 | 职责 |
|------|------|
| `src/registry.ts` | 新增 `McpServerSummary` / `AgentDetail` export 类型；新增内部 `sanitizeMcpServers()` 函数；新增 `AgentRegistry.getDetail(id)` 实例方法。 |
| `src/router/agent.ts` | 改写 `GET /:agentId` 路由为调用 `registry.getDetail(id)`。 |
| `src/__tests__/registry.test.ts` | 扩展 `getDetail` 测试组（完整配置、最小配置、MCP 脱敏三种 transport、subagents 极简、hasSystemPrompt 三种情况、404、unavailable）。 |
| `src/__tests__/router-agent.test.ts` | 改写现有两个 `GET /:agentId` 用例以适配新响应形态；保留 `GET /v1/agents` 列表回归测试。 |

---

### Task 1: 创建功能分支

**Files:**
- 无文件修改

**Interfaces:**
- 无

- [ ] **Step 1: 从 main 切出 feature 分支**

```bash
git checkout -b feat/agent-detail
```

Expected: 当前分支变为 `feat/agent-detail`。

- [ ] **Step 2: 确认分支状态**

```bash
git branch --show-current
```

Expected: 输出 `feat/agent-detail`。

---

### Task 2: 新增 `AgentDetail` 类型与 `getDetail()` 方法

**Files:**
- Modify: `src/registry.ts`
- Test: `src/__tests__/registry.test.ts`

**Interfaces:**
- Consumes: `AgentDefinition`（已存在，含 `model` / `allowedTools` / `mcpServers` / `subagents` / `systemPrompt` / `systemPromptFile` / `settingSources` / `extraUserSkillDirs` / `extraProjectSkillDirs` / `permissionMode` / `maxTurns` / `datasets` / `skills` / `disallowedTools` / `id` / `name` 等字段）。
- Produces:
  - `export interface McpServerSummary { transport: "stdio"|"sse"|"http"; command?: string; args?: string[]; env?: Record<string,string>; url?: string; headers?: Record<string,string> }`（脱敏后的形态）
  - `export interface AgentDetail { id; name; model; status; maxTurns; hasSystemPrompt; permissionMode?; allowedTools?; disallowedTools?; skills?; settingSources?; extraUserSkillDirs?; extraProjectSkillDirs?; mcpServers?: Record<string, McpServerSummary>; subagents?: Record<string, { description: string }>; datasets?: Record<string, string> }`
  - `AgentRegistry.getDetail(agentId: string): AgentDetail | null`（找不到返回 `null`）

- [ ] **Step 1: 在 `src/registry.ts` 加类型与 `getDetail` stub（让测试编译通过但失败）**

在 `src/registry.ts` 顶部 `AgentInfo` 接口下方加入两个新接口（紧跟着已有的 `AgentInfo`）：

```ts
export interface McpServerSummary {
  transport: "stdio" | "sse" | "http"
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  headers?: Record<string, string>
}

export interface AgentDetail {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  maxTurns: number
  hasSystemPrompt: boolean
  permissionMode?: string
  allowedTools?: string[]
  disallowedTools?: string[]
  skills?: string[]
  settingSources?: string[]
  extraUserSkillDirs?: string[]
  extraProjectSkillDirs?: string[]
  mcpServers?: Record<string, McpServerSummary>
  subagents?: Record<string, { description: string }>
  datasets?: Record<string, string>
}
```

在 `AgentRegistry` class 中（紧跟 `getStatus` 方法之后）加入 stub：

```ts
getDetail(agentId: string): AgentDetail | null {
  return null
}
```

- [ ] **Step 2: 在 `src/__tests__/registry.test.ts` 写第一组失败测试**

在 `describe("list", ...)` 与 `describe("getStatus", ...)` 之间插入新的 `describe("getDetail", ...)` 块：

```ts
  describe("getDetail", () => {
    it("returns null for unknown agent", () => {
      expect(registry.getDetail("unknown")).toBeNull()
    })

    it("returns full detail for a fully-configured agent", async () => {
      const config = makeConfig([{
        id: "full-agent",
        name: "Full Agent",
        model: "claude-sonnet-4-6",
        systemPrompt: "you are a bot",
        maxTurns: 25,
        permissionMode: "auto",
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        skills: ["cbt"],
        settingSources: ["project"],
        extraUserSkillDirs: ["/mnt/sk"],
        extraProjectSkillDirs: ["./sk"],
        datasets: { book1: "description" },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("full-agent")!
      expect(detail).toEqual({
        id: "full-agent",
        name: "Full Agent",
        model: "claude-sonnet-4-6",
        status: "ready",
        maxTurns: 25,
        hasSystemPrompt: true,
        permissionMode: "auto",
        allowedTools: ["Read", "Write"],
        disallowedTools: ["Bash"],
        skills: ["cbt"],
        settingSources: ["project"],
        extraUserSkillDirs: ["/mnt/sk"],
        extraProjectSkillDirs: ["./sk"],
        datasets: { book1: "description" },
      })
    })

    it("omits unset fields for a minimally-configured agent", async () => {
      const config = makeConfig([{ id: "min", model: "gpt-4" }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("min")!
      expect(detail).toEqual({
        id: "min",
        name: "min",
        model: "gpt-4",
        status: "ready",
        maxTurns: 10,
        hasSystemPrompt: false,
      })
      // 未配置字段不在响应里
      expect(detail.allowedTools).toBeUndefined()
      expect(detail.mcpServers).toBeUndefined()
      expect(detail.subagents).toBeUndefined()
      expect(detail.permissionMode).toBeUndefined()
    })

    it("hasSystemPrompt is true when systemPromptFile is set (without reading the file)", async () => {
      const config = makeConfig([{
        id: "file-agent",
        model: "gpt-4",
        systemPromptFile: "/tmp/prompt.txt",
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("file-agent")!
      expect(detail.hasSystemPrompt).toBe(true)
    })

    it("returns subagents with only { description }", async () => {
      const config = makeConfig([{
        id: "parent",
        model: "gpt-4",
        subagents: {
          coder: {
            description: "writes code",
            prompt: "secret prompt",
            tools: ["Read"],
            model: "gpt-4",
            skills: ["x"],
          },
          writer: { description: "writes docs" },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("parent")!
      expect(detail.subagents).toEqual({
        coder: { description: "writes code" },
        writer: { description: "writes docs" },
      })
    })

    it("returns status='unavailable' detail for unavailable agent", async () => {
      const { resolveSystemPrompt } = await import("../config.js")
      vi.mocked(resolveSystemPrompt).mockImplementationOnce(() => {
        throw new Error("fail")
      })
      const config = makeConfig([{ id: "broken", model: "gpt-4", allowedTools: ["Read"] }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("broken")!
      expect(detail.status).toBe("unavailable")
      expect(detail.allowedTools).toEqual(["Read"])
    })

    it("sanitizes MCP stdio env values (keeps command and args)", async () => {
      const config = makeConfig([{
        id: "stdio-agent",
        model: "gpt-4",
        mcpServers: {
          local: {
            transport: "stdio",
            command: "npx",
            args: ["-y", "some-server"],
            env: { API_KEY: "secret-token", OTHER: "x" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("stdio-agent")!
      expect(detail.mcpServers).toEqual({
        local: {
          transport: "stdio",
          command: "npx",
          args: ["-y", "some-server"],
          env: { API_KEY: "***", OTHER: "***" },
        },
      })
    })

    it("sanitizes MCP sse headers (keeps url)", async () => {
      const config = makeConfig([{
        id: "sse-agent",
        model: "gpt-4",
        mcpServers: {
          remote: {
            transport: "sse",
            url: "https://example.com/sse",
            headers: { Authorization: "Bearer xxx" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("sse-agent")!
      expect(detail.mcpServers).toEqual({
        remote: {
          transport: "sse",
          url: "https://example.com/sse",
          headers: { Authorization: "***" },
        },
      })
    })

    it("sanitizes MCP http headers (keeps url)", async () => {
      const config = makeConfig([{
        id: "http-agent",
        model: "gpt-4",
        mcpServers: {
          api: {
            transport: "http",
            url: "https://example.com/mcp",
            headers: { "X-API-Key": "abc" },
          },
        },
      }])
      await registry.loadFromConfig(config, "/tmp")

      const detail = registry.getDetail("http-agent")!
      expect(detail.mcpServers).toEqual({
        api: {
          transport: "http",
          url: "https://example.com/mcp",
          headers: { "X-API-Key": "***" },
        },
      })
    })
  })
```

- [ ] **Step 3: 运行新测试，确认全部失败（stub 返回 null）**

```bash
npx vitest run src/__tests__/registry.test.ts -t "getDetail"
```

Expected: 8 个用例失败（除 "returns null for unknown agent" 外）。错误类似 `expected null not to be null` 或 `received undefined`。

> 注意：如果 `returns null for unknown agent` 通过、其他失败，符合预期，进入下一步。

- [ ] **Step 4: 实现内部 `sanitizeMcpServers` 函数**

在 `src/registry.ts` 文件底部（class 外、`convertMcpServers` 函数附近）加入：

```ts
function sanitizeMcpServers(
  servers: Record<string, any> | undefined,
): Record<string, McpServerSummary> | undefined {
  if (!servers) return undefined

  const result: Record<string, McpServerSummary> = {}
  for (const [name, cfg] of Object.entries(servers)) {
    const summary: McpServerSummary = { transport: cfg.transport }
    if (cfg.transport === "stdio") {
      if (cfg.command !== undefined) summary.command = cfg.command
      if (cfg.args !== undefined) summary.args = cfg.args
      if (cfg.env !== undefined) {
        summary.env = Object.fromEntries(
          Object.keys(cfg.env).map((k) => [k, "***"]),
        )
      }
    } else {
      // sse | http
      if (cfg.url !== undefined) summary.url = cfg.url
      if (cfg.headers !== undefined) {
        summary.headers = Object.fromEntries(
          Object.keys(cfg.headers).map((k) => [k, "***"]),
        )
      }
    }
    result[name] = summary
  }
  return result
}
```

- [ ] **Step 5: 实现 `getDetail` 方法（替换 stub）**

把 Task 2 Step 1 写的 stub 替换为：

```ts
getDetail(agentId: string): AgentDetail | null {
  const def = this.defs.get(agentId)
  if (!def) return null

  const status = this.statuses.get(agentId) ?? "unavailable"
  const detail: AgentDetail = {
    id: def.id,
    name: def.name ?? def.id,
    model: def.model ?? "",
    status,
    maxTurns: def.maxTurns,
    hasSystemPrompt: Boolean(def.systemPrompt || def.systemPromptFile),
  }
  if (def.permissionMode !== undefined) detail.permissionMode = def.permissionMode
  if (def.allowedTools !== undefined) detail.allowedTools = def.allowedTools
  if (def.disallowedTools !== undefined) detail.disallowedTools = def.disallowedTools
  if (def.skills !== undefined) detail.skills = def.skills
  if (def.settingSources !== undefined) detail.settingSources = def.settingSources
  if (def.extraUserSkillDirs !== undefined) detail.extraUserSkillDirs = def.extraUserSkillDirs
  if (def.extraProjectSkillDirs !== undefined) detail.extraProjectSkillDirs = def.extraProjectSkillDirs
  const mcp = sanitizeMcpServers(def.mcpServers as Record<string, any> | undefined)
  if (mcp !== undefined) detail.mcpServers = mcp
  if (def.subagents !== undefined) {
    const sub: Record<string, { description: string }> = {}
    for (const [id, s] of Object.entries(def.subagents)) {
      sub[id] = { description: s.description }
    }
    detail.subagents = sub
  }
  if (def.datasets !== undefined) detail.datasets = def.datasets
  return detail
}
```

- [ ] **Step 6: 运行所有 registry 测试，确认全部通过**

```bash
npx vitest run src/__tests__/registry.test.ts
```

Expected: 全部通过，包括 8 个 `getDetail` 新用例和原有的 `loadFromConfig` / `create` / `list` / `getStatus` / `closeAll` 用例。

- [ ] **Step 7: 类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误输出。

- [ ] **Step 8: 提交**

```bash
git add src/registry.ts src/__tests__/registry.test.ts
git commit -m "feat(agent-detail): add AgentRegistry.getDetail() with MCP sanitization"
```

Expected: commit 成功，工作区干净。

---

### Task 3: 路由层接入 `getDetail`

**Files:**
- Modify: `src/router/agent.ts`
- Test: `src/__tests__/router-agent.test.ts`

**Interfaces:**
- Consumes: `AgentRegistry.getDetail(agentId: string): AgentDetail | null`（来自 Task 2）。
- Produces: `GET /v1/agents/:agentId` 返回完整 `AgentDetail` 或 404。

- [ ] **Step 1: 改写 `src/router/agent.ts` 的 `GET /:agentId` 路由**

把 `src/router/agent.ts` 中的：

```ts
  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const status = registry.getStatus(agentId)
    if (status === "not_found") {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json({
      id: agentId,
      status,
    })
  })
```

替换为：

```ts
  router.get("/:agentId", (c) => {
    const { agentId } = c.req.param()
    const detail = registry.getDetail(agentId)
    if (!detail) {
      return c.json({ error: "Agent not found" }, 404)
    }
    return c.json(detail)
  })
```

- [ ] **Step 2: 在 `src/__tests__/router-agent.test.ts` 的 `beforeEach` mock 里加 `getDetail`**

把现有：

```ts
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn(),
    }
```

改为：

```ts
    registry = {
      list: vi.fn(),
      create: vi.fn(),
      getStatus: vi.fn(),
      getDetail: vi.fn(),
    }
```

- [ ] **Step 3: 改写现有 `returns agent detail when found` 用例**

把 `src/__tests__/router-agent.test.ts` 中的：

```ts
    it("returns agent detail when found", async () => {
      registry.getStatus.mockReturnValue("ready")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/my-agent")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual({ id: "my-agent", status: "ready" })
    })
```

替换为：

```ts
    it("returns agent detail when found", async () => {
      const detail = {
        id: "my-agent",
        name: "My Agent",
        model: "gpt-4",
        status: "ready",
        maxTurns: 10,
        hasSystemPrompt: true,
        allowedTools: ["Read"],
      }
      registry.getDetail.mockReturnValue(detail)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/my-agent")
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body).toEqual(detail)
    })
```

- [ ] **Step 4: 改写现有 `returns 404 for unknown agent` 用例**

把 `src/__tests__/router-agent.test.ts` 中的：

```ts
    it("returns 404 for unknown agent", async () => {
      registry.getStatus.mockReturnValue("not_found")
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/unknown")
      expect(res.status).toBe(404)
    })
```

替换为：

```ts
    it("returns 404 for unknown agent", async () => {
      registry.getDetail.mockReturnValue(null)
      const app = createApp(registry, metrics)

      const res = await app.request("http://localhost/v1/agents/unknown")
      expect(res.status).toBe(404)
      const body = await res.json()
      expect(body).toEqual({ error: "Agent not found" })
    })
```

- [ ] **Step 5: 运行 router-agent 测试，确认全部通过**

```bash
npx vitest run src/__tests__/router-agent.test.ts
```

Expected: 所有 `GET /v1/agents/:agentId` 与 `POST /v1/agents/:agentId/runs` 用例通过。

- [ ] **Step 6: 提交**

```bash
git add src/router/agent.ts src/__tests__/router-agent.test.ts
git commit -m "feat(agent-detail): wire getDetail into GET /v1/agents/:agentId"
```

Expected: commit 成功。

---

### Task 4: 全量验证与合并

**Files:**
- 无修改

**Interfaces:**
- 无

- [ ] **Step 1: 全量类型检查**

```bash
npx tsc --noEmit
```

Expected: 无错误。

- [ ] **Step 2: 全量测试**

```bash
npm test
```

Expected: 所有测试通过，包括：
- `src/__tests__/registry.test.ts`
- `src/__tests__/router-agent.test.ts`
- `src/__tests__/router-health.test.ts`
- `src/__tests__/router-session.test.ts`
- `src/__tests__/config.test.ts`
- `src/__tests__/auth.test.ts`
- `src/__tests__/metrics.test.ts`

- [ ] **Step 3: 手动 smoke test（可选，验证端到端）**

启动 server 并发请求：

```bash
# 终端 1
npm run start
```

```bash
# 终端 2 — 用项目自带的 agents.yaml 里的 general agent
curl -s http://localhost:3000/v1/agents/general | jq
```

Expected: 返回包含 `model` / `allowedTools` / `subagents` 等字段的完整对象。

- [ ] **Step 4: 检查 README 是否需要同步更新**

```bash
grep -n "GET /v1/agents" README.md
```

如果 README 描述了 `GET /v1/agents/:agentId` 的响应形态，需更新为新形态。否则跳过。

- [ ] **Step 5: 合并到 main**

```bash
git checkout main
git pull
git merge --no-ff feat/agent-detail -m "feat(agent-detail): expose full agent config via GET /v1/agents/:agentId"
git push origin main
```

Expected: merge 成功，无冲突（如果在执行期间 main 未变）。

- [ ] **Step 6: 删除 feature 分支**

```bash
git branch -d feat/agent-detail
```

Expected: 分支删除成功。

---

## 验收清单

实现完成后，逐项核对：

- [ ] `GET /v1/agents/:agentId` 返回 `AgentDetail` 完整对象
- [ ] 未配置字段被省略（不是 `null`）
- [ ] MCP `env` / `headers` 值替换为 `"***"`，key 保留
- [ ] MCP `command` / `args` / `url` 原样返回
- [ ] `hasSystemPrompt` 正确反映 `systemPrompt` 或 `systemPromptFile` 是否配置（不读文件）
- [ ] `subagents` 只返回 `{ description }`
- [ ] `status: "unavailable"` 的 agent 仍返回完整 detail
- [ ] 找不到 agent 返回 404 + `{ error: "Agent not found" }`
- [ ] `GET /v1/agents`（列表）形态不变
- [ ] `npx tsc --noEmit` 通过
- [ ] `npm test` 全绿
