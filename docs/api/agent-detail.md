# Agent Detail API

`GET /v1/agents/:agentId` — 返回某个 agent 的**配置层**完整信息：模型、工具、MCP servers、技能、子代理、datasets 等。

用于运维 / 调试 / 控制台展示——让上游一眼看到"这个 agent 配了什么"，不必翻 `agents.yaml`。

> 这是配置层信息，不是运行时层信息。比如 `skills` 字段是配置的技能白名单，不是 SDK 实际扫描到的技能文件列表。

---

## Endpoint

```
GET /v1/agents/:agentId
```

| 属性 | 值 |
|---|---|
| 路径参数 | `agentId`（string，必填） |
| 鉴权 | 受 `OPENAGENT_HTTP_API_KEY` / `auth.apiKey` 保护（若配置） |
| Content-Type | `application/json` |

### curl 示例

```bash
curl http://localhost:3000/v1/agents/threapy-agent
```

如启用鉴权：

```bash
curl -H "x-api-key: your-secret-key" \
     http://localhost:3000/v1/agents/threapy-agent
```

---

## 响应

### 200 OK

返回 [`AgentDetail`](#agentdetail-字段说明) 对象。

#### 示例 1：最小配置

请求：`GET /v1/agents/min`

```json
{
  "id": "min",
  "name": "min",
  "model": "claude-sonnet-4-6",
  "status": "ready",
  "maxTurns": 10,
  "hasSystemPrompt": false
}
```

未配置的字段（`allowedTools`、`mcpServers`、`subagents` 等）**不会出现在响应里**（不是 `null`）。

#### 示例 2：心理咨询 Agent（完整配置）

请求：`GET /v1/agents/threapy-agent`

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

#### 示例 3：带 MCP servers（脱敏后）

```json
{
  "id": "mcp-agent",
  "name": "MCP Agent",
  "model": "claude-sonnet-4-6",
  "status": "ready",
  "maxTurns": 10,
  "hasSystemPrompt": true,
  "mcpServers": {
    "github": {
      "transport": "stdio",
      "command": "mcp-server-github",
      "args": ["--owner", "myorg"],
      "env": {
        "GITHUB_TOKEN": "***"
      }
    },
    "remote": {
      "transport": "sse",
      "url": "https://mcp.example.com/sse",
      "headers": {
        "Authorization": "***"
      }
    }
  }
}
```

注意 `env` 和 `headers` 的 value 被替换为 `"***"`——key 保留，让上游知道这里配了什么，但不暴露具体值。详见 [MCP 脱敏策略](#mcp-脱敏策略)。

#### 示例 4：带子代理

```json
{
  "id": "coordinator",
  "name": "Coordinator",
  "model": "claude-sonnet-4-6",
  "status": "ready",
  "maxTurns": 10,
  "hasSystemPrompt": true,
  "subagents": {
    "coder": { "description": "Write and edit code" },
    "researcher": { "description": "Research topics on the web" }
  }
}
```

子代理只返回 `{ description }`，不返回 prompt / tools / model 等内部字段。详见 [subagents 字段](#subagents)。

#### 示例 5：unavailable 状态

```json
{
  "id": "broken",
  "name": "broken",
  "model": "claude-sonnet-4-6",
  "status": "unavailable",
  "maxTurns": 10,
  "hasSystemPrompt": false
}
```

agent 配置解析失败时（例如 `systemPromptFile` 找不到文件），`status` 会是 `"unavailable"`，但响应仍是 200 + 完整 `AgentDetail`。上游据此判断该 agent 是否可调用。

### 404 Not Found

`agentId` 不存在时：

```json
{ "error": "Agent not found" }
```

---

## `AgentDetail` 字段说明

### 必返回字段

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` | string | Agent 标识符（与路径参数一致） |
| `name` | string | Agent 显示名（未配置 `name` 时回退为 `id`） |
| `model` | string | LLM 模型名（如 `claude-sonnet-4-6`、`qwen3.7-plus`） |
| `status` | `"ready"` \| `"unavailable"` | Agent 是否可调用 |
| `maxTurns` | number | Agent 主循环最大轮数（默认 10） |
| `hasSystemPrompt` | boolean | 是否配了系统提示词。`true` = 配了 `systemPrompt` 或 `systemPromptFile`（不读取文件内容，仅判断字段是否设置） |

### 可选字段（仅在已配置时出现）

| 字段 | 类型 | 说明 |
|---|---|---|
| `permissionMode` | string | 工具权限模式：`default` / `acceptEdits` / `bypassPermissions` / `plan` / `dontAsk` / `auto` |
| `allowedTools` | string[] | 工具白名单 |
| `disallowedTools` | string[] | 工具黑名单 |
| `skills` | string[] | 技能白名单（仅在配了 `settingSources` 后才实际加载） |
| `settingSources` | (`"user"` \| `"project"` \| `"local"`)[] | 技能扫描来源：`user`→`~/.openagent/skills/`，`project`→`<cwd>/.openagent/skills/`，`local`→`<cwd>/.openagent.local/skills/` |
| `extraUserSkillDirs` | string[] | 额外用户级技能目录 |
| `extraProjectSkillDirs` | string[] | 额外项目级技能目录 |
| `mcpServers` | Record\<string, `McpServerSummary`\> | MCP servers，已脱敏，详见 [McpServerSummary](#mcpserversummary-字段说明) |
| `subagents` | Record\<string, \{ `description`: string \}\> | 子代理，仅含 description，详见 [subagents](#subagents) |
| `datasets` | Record\<string, string\> | 数据集 ID → 描述映射（运行时会被注入到 systemPrompt） |

---

## `McpServerSummary` 字段说明

所有 MCP server 共有：

| 字段 | 类型 | 说明 |
|---|---|---|
| `transport` | `"stdio"` \| `"sse"` \| `"http"` | 传输方式 |

### stdio 专属（可选）

| 字段 | 类型 | 说明 |
|---|---|---|
| `command` | string | 启动命令（如 `npx`、`mcp-server-github`）— **原样返回** |
| `args` | string[] | 命令行参数 — **原样返回**（可能含 `--token=xxx` 形式的密钥，详见下文边界说明） |
| `env` | Record\<string, string\> | 环境变量，**值脱敏**为 `"***"`（key 保留） |

### sse / http 专属（可选）

| 字段 | 类型 | 说明 |
|---|---|---|
| `url` | string | MCP server URL — **原样返回**（可能含 `?token=xxx` 或 `user:pass@host` 形式的密钥，详见下文边界说明） |
| `headers` | Record\<string, string\> | 请求头，**值脱敏**为 `"***"`（key 保留） |

---

## subagents

每个 subagent 仅返回 `{ "description": string }`——保留让父 agent 选择子代理的"招牌"信息。

不返回：`prompt`、`tools`、`disallowedTools`、`model`、`mcpServers`、`skills`、`maxTurns`。

如需查看子代理完整配置，目前没有单独端点（2026-07-06 状态）。

---

## MCP 脱敏策略

| 字段 | 处理方式 |
|---|---|
| `env` 值 | ✅ 替换为 `"***"`，key 保留 |
| `headers` 值 | ✅ 替换为 `"***"`，key 保留 |
| `command` | ⚠️ 原样返回 |
| `args` | ⚠️ 原样返回 |
| `url` | ⚠️ 原样返回 |

### 已知边界（上游需注意）

接口只对 **`env` 和 `headers` 的值**强制脱敏。`args` 和 `url` 字段原样返回，理论上可能携带密钥：

- `args`: 命令行参数可能含 `--token=xxx`、`--api-key=yyy` 之类的内联密钥
- `url`: 可能含 query string 形式的 token（`?token=xxx`）或 URL 内嵌凭证（`https://user:pass@host`）

**建议上游消费方**：在 UI / 日志展示 MCP server 配置时，对 `args` 和 `url` 也保持警惕，不要原样落日志或展示给终端用户。

---

## 兼容性

### 与旧响应（`{ id, status }`）的关系

新响应是旧响应的**严格超集**：

| 字段 | 旧响应 | 新响应 |
|---|---|---|
| `id` | ✅ | ✅（同 key 路径，同值域） |
| `status` | ✅ | ✅（同 key 路径，同值域） |
| 其他 | — | 新增（旧消费者忽略即可） |

旧消费者只读 `id` 和 `status` 两个字段，新字段不影响其行为。**理论向后兼容**。

### 不变的部分

- `GET /v1/agents`（agent 列表）形态不变
- `POST /v1/agents/:agentId/runs`（运行 agent）行为不变
- 鉴权机制不变（受同一个 `x-api-key` 保护）

---

## 相关

- 设计文档：[`docs/superpowers/specs/2026-07-06-agent-detail-endpoint-design.md`](../superpowers/specs/2026-07-06-agent-detail-endpoint-design.md)
- 配置字段全集（`agents.yaml`）：见仓库根 `README.md` 的 Configuration 章节
