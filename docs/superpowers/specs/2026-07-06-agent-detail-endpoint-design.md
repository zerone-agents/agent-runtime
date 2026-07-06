# Agent Detail Endpoint

**Date**: 2026-07-06
**Status**: Approved, ready for implementation plan
**Topic**: 扩展 `GET /v1/agents/:agentId` 返回完整配置层信息

## 背景与动机

当前 `GET /v1/agents/:agentId` 只返回 `{ id, status }`，无法回答"这个 agent 配了哪些工具、加载了哪些技能、挂了哪些 MCP、有哪些子代理"这类问题。运维和调试场景下，只能去翻 `agents.yaml` 才能确认配置，体验差且容易脱节。

`AgentRegistry` 内部其实已经持有完整 `AgentDefinition`（在 `private defs` Map 里），只是路由层没有把它暴露出来。

## 目标

扩展 `GET /v1/agents/:agentId`，让它返回 agent 的**配置层完整信息**——即 `agents.yaml` 里这个 agent 配的字段。

## 非目标

- **不**返回运行时层信息（如 SDK 实际扫描到的 skill 文件列表、子 agent 真正可用的工具）。仅返回配置。
- **不**修改 `POST /v1/agents/:agentId/runs` 的行为。
- **不**修改 `GET /v1/agents`（列表）的响应形态。
- **不**新增独立的 `/capabilities` 或 `/details` 端点。

## 数据契约

### 新增类型

`src/registry.ts` 中新增：

```ts
export interface McpServerSummary {
  transport: "stdio" | "sse" | "http"
  // stdio
  command?: string
  args?: string[]
  env?: Record<string, string>          // 值已脱敏
  // sse | http
  url?: string
  headers?: Record<string, string>      // 值已脱敏
}

export interface AgentDetail {
  id: string
  name: string
  model: string
  status: "ready" | "unavailable"
  maxTurns: number                       // 总是返回（schema 有默认值 10）
  hasSystemPrompt: boolean               // 仅指示存在性，不返回 prompt 全文
  // —— 以下字段未配置时省略（不返回 null） ——
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

### MCP 脱敏策略

- **`env` 和 `headers`**：保留 key，value 替换为 `"***"`。让调用方知道"这里配了 Authorization"但看不到值。
- **`command`、`args`、`url`**：原样返回。
  - `args`：用户自己写的命令行参数，识别成本高，不脱敏。
  - `url`：少数情况下含 token（`?token=xxx` 或 `user:pass@host`），先不处理，文档加注意事项。
- 脱敏后形态示例：

```json
{
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "some-server"],
  "env": { "API_KEY": "***" }
}
```

```json
{
  "transport": "sse",
  "url": "https://example.com/sse",
  "headers": { "Authorization": "***" }
}
```

### systemPrompt 处理

- **默认不返回 `systemPrompt` 全文**——可能很长，且经过 `resolveSystemPrompt()` 后还可能注入 datasets 内容。
- 通过 `hasSystemPrompt: boolean` 暴露存在性：
  - 配了 `systemPrompt` → `true`
  - 配了 `systemPromptFile` → `true`（不读文件，只看字段是否设置）
  - 都没配 → `false`
- 后续如需查全文，加 `?include=prompt` 查询参数单独取（本期不实现）。

### subagents 处理

极简展开：`Record<string, { description: string }>`。

不返回子代理的 `prompt`、`tools`、`model`、`skills`、`mcpServers` 等字段。要看详情需要单独的子代理端点，本期不实现。

## API 变更

### `GET /v1/agents/:agentId`

**响应（200）**：完整 `AgentDetail` 对象。

示例：

```json
{
  "id": "threapy-agent",
  "name": "threapy-agent",
  "model": "qwen3.7-plus",
  "status": "ready",
  "maxTurns": 50,
  "hasSystemPrompt": true,
  "permissionMode": "auto",
  "allowedTools": ["Bash", "Read", "Write", "Edit", "Glob", "Grep", "Skill"],
  "settingSources": ["project"]
}
```

未配置的字段（如 `disallowedTools`、`mcpServers`、`subagents`、`datasets`）不出现在响应里。

**响应（404）**：

```json
{ "error": "Agent not found" }
```

**响应（status 为 `unavailable` 时）**：仍返回 200 + 完整 `AgentDetail`，`status` 字段为 `"unavailable"`。运维能看到配置便于排查。

## 代码组织

**方案 A**：脱敏逻辑放 `AgentRegistry`，路由层薄壳。

### `src/registry.ts`

新增：

1. `McpServerSummary` 类型（export）
2. `AgentDetail` 类型（export）
3. 内部函数 `sanitizeMcpServers(servers: AgentDefinition["mcpServers"]): Record<string, McpServerSummary> | undefined`
4. `AgentRegistry` 实例方法 `getDetail(agentId: string): AgentDetail | null`

`getDetail` 行为：

- agent 不存在 → `null`
- agent 存在 → 返回 `AgentDetail`，从 `defs.get(id)` 读字段，未配置字段省略
- `hasSystemPrompt`：`!!def.systemPrompt || !!def.systemPromptFile`
- 即使 `status === "unavailable"` 也正常返回

### `src/router/agent.ts`

`GET /:agentId` 改为：

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

注意：`getStatus()` 不再被此端点调用，但保留方法（其他地方可能用）。

## 测试

沿用现有 vitest 风格，纯单元测试，**不需要 mock `@zerone-agent/open-agent-sdk`**（因为不调 `createAgent`）。

### `src/__tests__/registry.test.ts`（已存在，扩展）

| 用例 | 验证点 |
|---|---|
| 完整配置的 agent | 所有字段正确返回 |
| 最小配置（只有 id + model） | 未配字段被省略，不是 null |
| MCP stdio 配置 | `env` 值替换为 `"***"`，`command`/`args` 原样 |
| MCP sse 配置 | `headers` 值替换为 `"***"`，`url` 原样 |
| MCP http 配置 | `headers` 值替换为 `"***"`，`url` 原样 |
| 配置了多个 MCP servers | 都脱敏，都返回 |
| subagents 配置 | 只返回 `{ description }`，不返回 prompt/tools/model |
| `hasSystemPrompt=true`（systemPrompt） | 配了 `systemPrompt` 字段 |
| `hasSystemPrompt=true`（systemPromptFile） | 配了 `systemPromptFile` 字段（不读文件） |
| `hasSystemPrompt=false` | 都没配 |
| 找不到的 agent | 返回 `null` |
| unavailable 的 agent | 仍返回 detail，status 字段为 `"unavailable"` |

### `src/__tests__/router-agent.test.ts`（已存在，改写现有用例 + 新增）

现有文件已经包含 `GET /v1/agents/:agentId` 的两个用例：

| 现有用例 | 处理方式 |
|---|---|
| `returns agent detail when found` | **改写**：mock 改为 `registry.getDetail`，断言新响应形态（完整 AgentDetail 而非 `{id, status}`） |
| `returns 404 for unknown agent` | **改写**：mock `registry.getDetail.mockReturnValue(null)`，断言 404 不变 |

`beforeEach` 里的 registry mock 需要补一个 `getDetail: vi.fn()`（与现有 `getStatus`、`list`、`create` 并列）。

新增用例：

| 用例 | 验证点 |
|---|---|
| `GET /v1/agents` 列表 | 形态不变（回归验证，确保未受影响） |

## 兼容性

- `GET /v1/agents/:agentId` 响应是**旧响应的超集**（旧只有 `id` + `status`）。旧消费者忽略新字段即可，**理论向后兼容**。
- `GET /v1/agents`（列表）形态完全不变。
- 创建 agent 的路径（`registry.create()`）不动，`POST /:agentId/runs` 行为不变。
- Auth 保护范围不变：仍受 `OPENAGENT_HTTP_API_KEY` / `auth.apiKey` 保护（如果配置了）。

## 风险评估

**低**：

- 纯读取接口扩展，不涉及持久化、不涉及状态变更。
- 不影响 agent 运行路径。
- 改动文件少（2 个源文件 + 2 个测试文件）。

## 注意事项（实现时关注）

1. **`getDetail` 实现里读 `def` 字段时**：直接使用 `def.xxx` 即可（已经是 zod parse 后的对象）。注意 optional 字段判断 `undefined` 后决定是否放进返回对象。
2. **`sanitizeMcpServers`**：遍历 `Object.entries`，按 `transport` 分支处理。注意 stdio 没有 headers，sse/http 没有 env/args。
3. **TS 类型严格**：项目用 `strict` 模式，确保脱敏函数返回类型与 `McpServerSummary` 完全匹配。
4. **测试 mock**：现有 `registry.test.ts` 已经 mock 了 SDK，沿用同样模式即可。

## 未来扩展（本期不做）

- `?include=prompt`：返回 systemPrompt 全文。
- `GET /v1/agents/:agentId/subagents/:subId`：查看子代理详情。
- 运行时层信息（实际加载的 skills 文件、SDK 注册的工具列表等）——需要 SDK 暴露能力查询接口。
