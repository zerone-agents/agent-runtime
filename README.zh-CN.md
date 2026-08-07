# agent-runtime

[agent-sdk](https://github.com/zerone-agents/agent-sdk) agent 的 HTTP Server 运行时。

[English](README.md) | 中文

多 agent 运行时，支持 Streamable HTTP（SSE + JSON 内容协商）。用 YAML 或 TypeScript 定义 agent，启动服务，调用 API。

## 快速开始

```bash
npm install

# 创建配置
cat > agents.yaml << 'EOF'
agents:
  - id: "assistant"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a helpful assistant."
    maxTurns: 10
EOF

npm start
```

也支持 TypeScript 配置（`agent.config.ts`）——见 [`docs/configuration.md`](docs/configuration.md)。

## API

所有路由以 `/v1` 为前缀。run 端点采用 Streamable HTTP —— 通过 `Accept` 头协商响应模式：

| `Accept` 头 | Body | 响应 |
|---|---|---|
| `text/event-stream` | — | SSE，token 级 `partial_message` 事件 |
| `text/event-stream` | `stream: "block"` | SSE，仅完整消息 |
| `application/json` | — | 阻塞式 JSON 响应 |

```bash
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"Hello"}'
```

SSE 事件序列、block 模式及 legacy `stream` 字段兼容性见 [`docs/api/runs.md`](docs/api/runs.md)。

### 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/health` | 健康检查（无需认证） |
| `GET` | `/v1/metrics` | Token 用量、请求数、成本 |
| `GET` | `/v1/agents` | 列出已注册 agent |
| `GET` | `/v1/agents/:id` | Agent 详情 |
| `POST` | `/v1/agents/:id/runs` | 运行 agent（Streamable HTTP） |
| `GET` | `/v1/sessions` | 列出会话 |
| `GET` | `/v1/sessions/:id` | 会话详情（含消息） |
| `DELETE` | `/v1/sessions/:id` | 删除会话 |
| `GET` | `/v1/files` | 列出 cwd 下的文件（`?path`、`?recursive`、`?depth`） |
| `GET` | `/v1/files/content` | 下载文件（`?path=`） |
| `HEAD` | `/v1/files/content` | 仅文件头信息（`?path=`） |

## Run 生命周期与取消

每次 `POST /v1/agents/:agentId/runs` 执行都会被分配一个唯一的
`runId`（UUID）用于传输层标识。该 ID 通过以下方式暴露：

- 响应头 `X-Run-ID`（SSE 和 JSON 都有）
- SSE 初始 `system` 事件的 `runId` 字段
- JSON 响应体的 `runId` 字段

### 取消 run

```http
POST /v1/runs/:runId/cancel
```

中止指定的活跃 run。响应码：

| 场景 | Code | Body |
|---|---|---|
| 触发取消 | 202 | `{ runId, state: "cancelling" }` |
| 重复取消（幂等） | 202 | `{ runId, state: "cancelling" \| "cancelled", reason }` |
| run 已处于非取消的终态 | 409 | `{ runId, state: "completed" \| "failed" }` |
| 未知 / 过期的 runId | 404 | `{ error: "Run not found" }` |

终态缓存 TTL：**5 分钟**。过期后重复取消返回 404。

### SSE 取消语义

当 run 被取消时（显式 API 调用或客户端断连），SSE 流会发送：

```
event: cancelled
data: {"runId":"...","reason":"client_request|disconnect"}

event: done
data: {}
```

- `reason=client_request`：显式调用 `POST /v1/runs/:runId/cancel`。
- `reason=disconnect`：SSE 客户端断开连接。

**客户端断连 = 静默取消**：关闭 SSE 连接会中止底层的 agent 执行。
runtime 不区分"主动取消"和"网络中断"——两者都会停止 run 以避免
浪费 token。

### 不在范围内

本 API 是传输层级别的。agent-runtime **不**提供：

- 持久化的 run 历史记录（请使用外部编排器）
- 重试 / 故障转移策略
- 可持久化的事件回放（不支持中途重连）
- GET 状态端点（终态通过响应本身传达）

### 关停语义

`RunRegistry.closeAll()` 供包装 runtime 进程的编排器（例如
agent-deployer）使用，便于在 SIGTERM 时排空 in-flight run。runtime
自身不安装信号处理器 —— 容器级 SIGTERM/KILL 是编排器的责任。

## 配置

```yaml
agents:
  - id: "researcher"
    name: "Research Assistant"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/researcher.md"
    maxTurns: 10
    maxSessionTurns: 50
    allowedTools:
      - WebFetch
      - WebSearch
      - Read

  - id: "coder"
    model: "claude-sonnet-4-6"
    systemPromptFile: "./prompts/coder.md"
    maxTurns: 20
    allowedTools:
      - Bash
      - Read
      - Write
      - Edit
    mcpServers:
      github:
        transport: "stdio"
        command: "mcp-server-github"
        args: ["--owner", "myorg"]
    datasets:
      docs: "Internal knowledge base for the project"
```

**字段说明：**

| 字段 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `id` | 是 | — | 唯一标识，用于 API 路由 |
| `model` | 否 | `claude-sonnet-4-6` | LLM 模型名 |
| `systemPrompt` | 否 | — | 内联 system prompt |
| `systemPromptFile` | 否 | — | `.md` 文件路径（相对配置目录） |
| `maxTurns` | 否 | `10` | agent 循环最大轮数 |
| `maxSessionTurns` | 否 | 不限 | 发送给 LLM 的最大对话轮数（上下文窗口） |
| `allowedTools` | 否 | 全部工具 | 工具名白名单 |
| `disallowedTools` | 否 | — | 工具名黑名单 |
| `settingSources` | 否 | — | 扫描哪些 skill 目录：`user`（~/.openagent/skills/）、`project`（<cwd>/.openagent/skills/）、`local`（无操作）。扫描到的 skill 全部暴露——无白名单 |
| `extraUserSkillDirs` | 否 | — | 额外的 user 级 skill 目录（在默认目录之后扫描） |
| `extraProjectSkillDirs` | 否 | — | 额外的 project 级 skill 目录（在默认目录之后扫描） |
| `mcpServers` | 否 | — | MCP server 配置 |
| `permissionMode` | 否 | `default` | `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto` |
| `subagents` | 否 | — | 供 `Task` 工具使用的 subagent 定义 |
| `datasets` | 否 | — | dataset-id 到描述的映射，以 `<datasets>` 块注入 system prompt |

`systemPrompt` 与 `systemPromptFile` 互斥。

### AIGC 标识（GB 45438-2025）

可选的顶层 `aigc` 配置：启用后，每个响应都携带符合国标的隐式标识 `aigc` 字段，并生成逐次运行的审计记录。支持环境变量覆盖（`ZERONE_AGENT_AIGC_*`）。完整配置、设计依据与合规材料清单见 [`docs/compliance.md`](docs/compliance.md)。

### Skill 加载

Skill **完全由文件系统驱动**——无白名单。通过 `settingSources` 选择扫描目录（`~/.openagent/skills/`、`<cwd>/.openagent/skills/`，外加 `extraUserSkillDirs` / `extraProjectSkillDirs`）；发现的每个 `SKILL.md` 都会暴露给 agent。Skill 在启动时扫描一次，修改文件系统后需重启生效。`GET /v1/agents/:id` 返回的 `availableSkills` 字段可查看实际加载的列表。

### Subagent

在 agent 的 `subagents` 键下定义 subagent；父 agent 通过 `Task` 工具委派任务：

```yaml
agents:
  - id: "coordinator"
    model: "claude-sonnet-4-6"
    systemPrompt: "Delegate complex tasks to the appropriate subagent using the Task tool."
    allowedTools:
      - Task
      - Read
    subagents:
      coder:
        description: "Write and edit code"
        prompt: "You are an expert programmer. Write clean, working code."
        tools:
          - Read
          - Write
          - Edit
          - Bash
        maxTurns: 30
      researcher:
        description: "Research topics on the web"
        prompt: "You are a research assistant. Search and summarize information."
        tools:
          - WebSearch
          - WebFetch
        maxTurns: 15
```

字段参考与 TypeScript 模式：[`docs/configuration.md`](docs/configuration.md)。

## 认证

可选：未配置 API key 时所有路由开放。设置 `ZERONE_AGENT_HTTP_API_KEY` 环境变量（优先级更高）或配置中的 `auth.apiKey`，然后在所有 `/v1/*` 请求中通过 `x-api-key` 头携带 key：

```bash
ZERONE_AGENT_HTTP_API_KEY="your-secret-key" npm start

curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-secret-key" \
  -d '{"message":"Hello"}'
```

`/health` 保持免认证，供负载均衡器和监控探针使用。缺失或错误的 key 返回 `401` 及 JSON 错误体。

## CLI

```bash
zerone-agent                          # 使用 cwd 下的配置启动
zerone-agent --config ./my-agents/    # 指定配置目录
zerone-agent --port 8080              # 覆盖端口
```

## 示例

| 目录 | 说明 |
|---|---|
| `examples/simple/` | 单 agent + YAML 配置 |
| `examples/complex/` | 多个专职 agent（researcher、coder、writer） |
| `examples/code-driven/` | TypeScript 配置 + 自定义工具（`agent.config.ts`） |
| `examples/programmatic/` | 完整 SDK+Runtime 编程式用法：自定义工具、hooks、多 agent、自定义路由 |

## 架构

```
Client → Hono HTTP Server → AgentRegistry → agent-sdk Agent
         (Accept header)         ↓                ↓
              ↓          AsyncGenerator<SDKMessage>
     ┌────────┴────────┐           ↓
     │                 │    Streamable HTTP Bridge
  SSE stream      JSON response    → Client
```

- **AgentRegistry** 启动时从配置创建 Agent 实例，进程内缓存
- **Streamable HTTP Bridge** 将 SDK 流式事件路由到 SSE，或聚合为 JSON，通过 `Accept` 头协商
- **会话**管理委托给 SDK 的文件系统存储

## 文件浏览

`/v1/files` 通过 HTTP 暴露运行时的工作目录（列表、下载、Range 请求）——便于外部控制台调试和观测。

**信任模型：** 任何持有有效 API key 的调用方都对 cwd 下的一切拥有完整读权限——包括 `agents.yaml`、`.env` 及任何密钥。生产部署前请配置 `ZERONE_AGENT_HTTP_API_KEY`。

完整 API 参考见 [`docs/api/files.md`](docs/api/files.md)。

## 作为库使用

运行时也可以作为库嵌入（`createApp`、`AgentRegistry`、`MetricsCollector`）——见 [`docs/sdk-usage.md`](docs/sdk-usage.md)。

## License

MIT
