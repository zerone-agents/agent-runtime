<div align="center">

# Zerone Agent Runtime

**AI agent 的 HTTP 服务运行时。**<br/>
用 YAML 或 TypeScript 定义 agent，通过 Streamable HTTP（SSE + JSON）对外暴露。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow)](./LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/zerone-agents/agent-runtime?style=flat)](https://github.com/zerone-agents/agent-runtime/stargazers)
[![Node](https://img.shields.io/badge/Node-22-339933?logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

[快速开始](#快速开始) · [文档](#文档) · [生态](#生态) · [许可证](#许可证)

**[English](README.md) | 简体中文**

</div>

---

## Zerone Agent Runtime 是什么？

Zerone Agent Runtime 是 AI agent 的执行层 —— 一个轻量 HTTP 服务，把 agent 定义（YAML 或 TypeScript）转换成 REST/SSE 端点。基于 [`@zerone-agent/agent-sdk`](https://github.com/zerone-agents/agent-sdk)，负责 Streamable HTTP 传输（SSE token 流、SSE block 模式、阻塞 JSON）、会话管理、subagent 派生、File Browsing API —— 让任何客户端（agent-hub 聊天界面、CLI 或你自己的应用）都能通过统一的 HTTP 协议与 agent 交互。

**三种响应模式：** SSE raw · SSE block · JSON

## 快速开始

```bash
npm install

# 创建配置
cat > agents.yaml << 'EOF'
agents:
  - id: "assistant"
    description: "通用助手"
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
| `GET` | `/health` | 健康检查，含 runtime 版本号（无需认证） |
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
| `POST` | `/v1/files/uploads` | 上传聊天附件（multipart；≤10 个文件、单个 ≤20MB、单请求 ≤50MB） |

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
    maxSessionQueries: 50
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
| `description` | 是 | — | 一行描述；用于 detail 端点与 `Task` 路由 |
| `model` | 否 | `claude-sonnet-4-6` | LLM 模型名 |
| `systemPrompt` | 否 | — | 内联 system prompt |
| `systemPromptFile` | 否 | — | `.md` 文件路径（相对配置目录） |
| `maxTurns` | 否 | `10` | agent 循环最大轮数 |
| `maxSessionQueries` | 否 | 不限 | 发送给 LLM 的最大对话轮数（上下文窗口） |
| `allowedTools` | 否 | 全部工具 | 工具名白名单 |
| `disallowedTools` | 否 | — | 工具名黑名单 |
| `settingSources` | 否 | — | 扫描哪些 skill 目录：`user`（~/.openagent/skills/）、`project`（<cwd>/.openagent/skills/）、`local`（无操作）。扫描到的 skill 全部暴露——无白名单 |
| `extraUserSkillDirs` | 否 | — | 额外的 user 级 skill 目录（在默认目录之后扫描） |
| `mcpServers` | 否 | — | MCP server 配置 |
| `permissionMode` | 否 | `default` | `default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk`、`auto` |
| `subagents` | 否 | — | 供 `Task` 工具挂载的 agent id 列表 |
| `datasets` | 否 | — | dataset-id 到描述的映射，以 `<datasets>` 块注入 system prompt |

`systemPrompt` 与 `systemPromptFile` 互斥。

### AIGC 标识（GB 45438-2025）

可选的顶层 `aigc` 配置：启用后，每个响应都携带符合国标的隐式标识 `aigc` 字段，并生成逐次运行的审计记录。支持环境变量覆盖（`ZERONE_AGENT_AIGC_*`）。完整配置、设计依据与合规材料清单见 [`docs/compliance.md`](docs/compliance.md)。

### Hub 聊天记录回传（可选）

可选的顶层 `hub` 配置：启用后，每次成功完成的 run 会异步把该 session 的全量快照推送到 agent-hub（hub 侧幂等 upsert）。请求头 `X-User-Name` 映射为 session 用户归属且必传——缺失时 runtime 跳过该次推送；租户归属只来自部署级配置 `hub.org`（经 agent-hub/agent-deployer 下发），**请求头 `X-Org` 已删除、不再读取**，未配置 `hub.org` 时省略 org 字段、由 hub 按部署模式解析默认租户。推送永不阻塞 run —— 网络错误/5xx 以 1s→2s 退避重试 2 次，4xx 不重试。完整配置见 [`docs/configuration.md` 的 `hub` 章节](docs/configuration.md#hub-聊天记录回传可选)。

### Cron 定时任务（可选）

可选的顶层 `cron` 配置：启用后，runtime 在 HTTP 监听之前启动 cron 调度器，通过 `/v1/cron/*` 路由和 `zerone-agent cron` CLI 子命令（在线模式；暂不支持 `--offline`）管理定时任务。需显式开启——定时运行会产生模型调用与工具执行。

```yaml
cron:
  enabled: true
  dataRoot: .zerone
  executionTimeoutMs: 600000
  drainMs: 5000

agents:
  - id: assistant
    description: General assistant used by scheduled prompts
    model: claude-sonnet-4-6
```

任务状态与执行历史持久化在 `<dataRoot>/cron/` 下（单写者锁）。HTTP API 见 [`docs/api/cron.md`](docs/api/cron.md)，完整配置见 [`docs/configuration.md` 的 `cron` 章节](docs/configuration.md#cron)，可运行示例见 [`examples/cron-runtime/`](examples/cron-runtime/)。

### Skill 加载

Skill **完全由文件系统驱动**——无白名单。通过 `settingSources` 选择扫描目录（`~/.openagent/skills/`、`<cwd>/.openagent/skills/`，外加 `extraUserSkillDirs`）；发现的每个 `SKILL.md` 都会暴露给 agent。Skill 在启动时扫描一次，修改文件系统后需重启生效。`GET /v1/agents/:id` 返回的 `availableSkills` 字段可查看实际加载的列表。

### Subagents

所有 agent 都扁平定义在 `agents` 列表中，都是一等公民——出现在 `GET /v1/agents` 列表、可直接 run。通过 id 列表把其他 agent 挂载为 subagent，父 agent 经 `Task` 工具委派任务：

```yaml
agents:
  - id: "coder"
    description: "编写和修改代码"
    model: "claude-sonnet-4-6"
    systemPrompt: "你是专业程序员，编写简洁、可运行的代码。"
    allowedTools: ["Read", "Write", "Edit", "Bash"]
    maxTurns: 30

  - id: "researcher"
    description: "网络搜索与研究"
    model: "claude-sonnet-4-6"
    systemPrompt: "你是研究员，搜索并总结信息。"
    allowedTools: ["WebSearch", "WebFetch"]
    maxTurns: 15

  - id: "coordinator"
    description: "协调者，向专家委派任务"
    model: "claude-sonnet-4-6"
    systemPrompt: "使用 Task 工具把复杂任务委派给合适的 subagent。"
    allowedTools: ["Task", "Read"]
    subagents: ["coder", "researcher"]
```

挂载时会物化子 agent 自己的 Agent-local 能力——解析后的 `systemPrompt`（注入它自己的 datasets）、MCP 工具、文件自定义工具、skills、`allowedTools`/`disallowedTools` 策略。这些能力不从父 agent 继承、不合并、不回退：未声明 MCP 的 subagent 看不到父级的 MCP 工具。凭证保持 runtime 全局：沿用父运行的 provider、model 和工作目录。委派深度为 1：subagent 不能再挂载 subagent。`subagents` 中的未知 id 或重复 id 会在启动时报错。

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

## 聊天附件

先上传到 Runtime（落入 `<cwd>/.zerone-uploads`，扁平目录，生命周期跟随容器），再在 Run 中引用：

```bash
curl -X POST http://localhost:3000/v1/files/uploads \
  -H "x-api-key: $KEY" -F "files=@report.pdf"
# → 201 { "files": [{ "id","name","mime","size","path": ".zerone-uploads/report.pdf" }] }

curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" -H "x-api-key: $KEY" \
  -d '{"message":"请总结这份报告","attachments":[{"id":"…","name":"report.pdf","mime":"application/pdf","size":123,"path":".zerone-uploads/report.pdf"}]}'
```

可解码的 JPEG/PNG/GIF/WebP 直接进入模型 image block（长边超过 1536px 时等比缩放，需转码时 JPEG quality 85，原文件不被修改）；SVG、伪图片及其他格式以安全的工作区相对路径交给 Agent 用 `Read` 工具读取。每次 Run 都会重新校验附件描述（扁平路径、普通文件、真实 size，数量/大小限额在读取任何内容之前复核），绝不信任调用方；交给 Agent 的路径是从校验字节物化的按次快照（`.zerone-uploads/snap-…`），校验后的文件系统改动（含对原始上传的 symlink 换链）无法影响本次 Run 实际读到的内容。Agent 的 `Read` 工具同样在 runtime 层被加固：`.zerone-uploads/` 下的读取在执行时重新校验（拒绝 symlink 与越界），并经内核 fd 引用（`/proc/self/fd`）委托，SDK 实际打开的就是校验过的字节。**平台要求**：上传、快照物化与 Read 委托都绑定内核 fd 引用（Linux `/proc/self/fd`）；其他平台一律 fail-closed 拒绝（500 / 工具错误），不降级为不安全的路径方案。

### 附件代次校验（`X-Expected-Container-Id`）

聊天附件锚定到上传时的 Runtime 容器代次。`POST /v1/files/uploads`、`GET /v1/files/content` 与带附件的 run 请求支持可选请求头 `X-Expected-Container-Id: <完整 64-hex containerId>`；Header 存在时，Runtime 在**任何附件 I/O 或 run 启动之前**原子校验自身容器身份——不匹配 → `412 generation_mismatch`（零 I/O、无 SSE flush、无 assistant message），身份无法确定 → `503 generation_unavailable`（禁止忽略 Header 继续）。Header 缺失保持旧行为。身份识别优先 `ZERONE_RUNTIME_CONTAINER_ID`（deployer 注入）> cgroup 完整 ID > Docker 默认 12-hex hostname 前缀（仅允许完整 64-hex expected 的前 12 位精确相等）；显式/非法/来源矛盾一律 fail-closed。`GET /health` 声明 `capabilities.attachmentExpectedGeneration: true` 供能力探测。**升级顺序**：发布本 Runtime → Hub 启用能力探测并携带 Header → 重新部署 Agent。

## 作为库使用

运行时也可以作为库嵌入（`createRuntime`、`AgentRuntimeHost`）——见 [`docs/sdk-usage.md`](docs/sdk-usage.md)。

## License

MIT
