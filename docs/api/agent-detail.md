# Agent Detail API

`GET /v1/agents/:agentId` — 返回某个 agent 的**配置层 + 运行时层**完整信息：模型、工具、MCP servers、实际扫描到的技能、子代理、datasets 等。

用于运维 / 调试 / 控制台展示——让上游一眼看到"这个 agent 配了什么、实际能用什么"。

> **配置层 vs 运行时层**：`settingSources` 是配置（"扫哪里"），`availableSkills` 是运行时（"扫到了什么"）。后者由 runtime 在启动时根据前者扫描文件系统得出，反映真实可用的 SKILL.md 清单。

---

## Endpoint

```
GET /v1/agents/:agentId
```

| 属性 | 值 |
|---|---|
| 路径参数 | `agentId`（string，必填） |
| 鉴权 | 受 `ZERONE_AGENT_HTTP_API_KEY` / `auth.apiKey` 保护（若配置） |
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

#### 示例 2：心理咨询 Agent（带技能扫描）

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
  "settingSources": ["user", "project"],
  "availableSkills": [
    {
      "name": "CBT-skills",
      "description": "认知行为疗法对话技能",
      "source": "user",
      "location": "/Users/zero/.openagent/skills/CBT-skills/SKILL.md"
    },
    {
      "name": "reflection",
      "description": "主动倾听与反馈",
      "source": "project",
      "location": "/workdir/.openagent/skills/reflection/SKILL.md"
    }
  ]
}
```

注意 `availableSkills` 是 runtime 启动时扫描文件系统得出的真实清单（不是配置）：
- 同名 skill 后扫到的会覆盖先扫到的（project 覆盖 user）
- `source` 标明来自哪一层级，便于排查"为什么这个 skill 没生效"
- 没扫到任何 skill 时该字段不出现（保持"未配置字段不出现"约定）

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
  "subagents": [
    { "agent_id": "coder", "description": "Write and edit code" },
    { "agent_id": "researcher", "description": "Research topics on the web" }
  ]
}
```

每个子代理条目为 `{ agent_id, description }`，不返回 prompt / tools / model 等内部字段。详见 [subagents 字段](#subagents)。

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
| `availableSkills` | `SkillSummary[]` | **运行时层**：runtime 启动时扫描文件系统得出的实际可用技能清单。仅在扫到 ≥1 个时出现。详见 [SkillSummary](#skillsummary-字段说明) |
| `settingSources` | (`"user"` \| `"project"` \| `"local"`)[] | **配置层**：技能扫描来源：`user`→`~/.openagent/skills/`，`project`→`<cwd>/.openagent/skills/`，`local`→SDK 类型里有但 loader 未实现（no-op） |
| `extraUserSkillDirs` | string[] | 额外用户级技能目录 |
| `mcpServers` | Record\<string, `McpServerSummary`\> | MCP servers，已脱敏，详见 [McpServerSummary](#mcpserversummary-字段说明) |
| `subagents` | Array\<\{ `agent_id`: string, `description`: string \}\> | 子代理 id + description 列表，详见 [subagents](#subagents) |
| `datasets` | Record\<string, string\> | 数据集 ID → 描述映射（运行时会被注入到 systemPrompt） |

### Skill 模型说明

技能**完全基于文件系统**——没有白名单配置。runtime 启动时按以下顺序扫描目录：

1. `settingSources: ["user"]` → `~/.openagent/skills/` + `extraUserSkillDirs`
2. `settingSources: ["project"]` → `<cwd>/.openagent/skills/`

所有扫到的 SKILL.md 都会暴露给 agent，没有过滤。同名 skill 后扫到的覆盖先扫到的（project 覆盖 user）。扫描结果缓存在 `availableSkills` 字段，重启 runtime 才会刷新。

---

## `SkillSummary` 字段说明

每个 `availableSkills` 数组元素的字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `name` | string | 技能名（取自 SKILL.md frontmatter 的 `name` 字段；未填则用所在目录名） |
| `description` | string | 技能描述（取自 SKILL.md frontmatter 的 `description` 字段，必填） |
| `source` | `"user"` \| `"project"` | 来源层级：`user` = `~/.openagent/skills/` 或 `extraUserSkillDirs`；`project` = `<cwd>/.openagent/skills/` |
| `location` | string | SKILL.md 文件的绝对路径 |

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

每个条目为 `{ "agent_id": string, "description": string }`——保留让父 agent 选择子代理的"招牌"信息。

条目仅包含 `agent_id` 与 `description` 两个字段，agent 的其余配置（`model`、`systemPrompt`、`allowedTools`、`mcpServers`、`maxTurns` 等）不随父 agent 返回。

被挂载的 agent 本身是一等公民，其完整信息可经 `GET /v1/agents/{agent_id}` 获取。

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

- 配置字段全集（`agents.yaml`）：见仓库根 `README.md` 的 Configuration 章节
