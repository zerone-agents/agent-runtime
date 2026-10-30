# Append System Prompt — 追加系统提示词示例

演示 `appendSystemPrompt` 双入口：配置级（`agents.yaml` 固定追加）+ 请求级（runs 请求体按次注入）。本示例面向真实 LLM API：凭据经环境变量注入后实际调用（区别于单元测试的 mock）。

## 原理

`appendSystemPrompt` 的内容会追加到系统提示词的**最末尾**，两级可叠加：

```
base prompt（systemPrompt + <datasets>）
→ SDK 环境块（env / skills / subagents / deferred tools / AGENTS.md）
→ 配置级 appendSystemPrompt（agents.yaml，部署时固定）
→ 请求级 appendSystemPrompt（runs body，仅当次 run）
```

- 两级同时存在时以空行（`\n\n`）连接，配置级在前。
- 请求级**仅当次 run 生效**：不写入 session，同一 `sessionId` 的下一次请求不带该字段就不再生效，需要每次重发。
- `Task`/`MultiTask` 派生的子代理不继承请求级注入（各自只带自己的配置级）。

## 启动

```bash
node --import tsx src/index.ts --config examples/append-system-prompt
```

## 环境变量

凭据不写入 `agents.yaml`，全部经环境变量注入（优先级高于配置文件）：

```bash
export ZERONE_AGENT_API_KEY=sk-xxx
export ZERONE_AGENT_BASE_URL=https://xxx
export ZERONE_AGENT_MODEL=kimi-k2.5
export ZERONE_AGENT_API_TYPE=anthropic-messages
```

（`apiType` 合法取值：`anthropic-messages` / `openai-completions`）

## 测试

三步演示，全部用阻塞模式（`stream:false`），从响应中取 `sessionId`：

### 第一步：配置级生效

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"你是谁？你服务于什么项目？","stream":false}'
```

期望：回复用中文、自称「小助」、提到 DemoApp——这些来自 `agents.yaml` 里的 `appendSystemPrompt`。记下响应中的 `sessionId`（下同）。

### 第二步：请求级注入（与配置级叠加）

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"用一句话介绍你能做什么","stream":false,"sessionId":"上一步的sessionId","appendSystemPrompt":"当前提问者是 VIP 客户，每次回复以「尊敬的 VIP 客户：」开头。"}'
```

期望：回复以「尊敬的 VIP 客户：」开头，且仍自称「小助」——请求级与配置级同时生效。

### 第三步：仅当次生效（不写入 session）

```bash
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"再介绍一下你自己","stream":false,"sessionId":"同一个sessionId"}'
```

期望：回复**不再**有「尊敬的 VIP 客户：」开头，但配置级仍在（小助/DemoApp）——请求级注入只对携带它的那一次 run 生效。

## 文件结构

```
append-system-prompt/
├── agents.yaml     # Agent 定义：inline systemPrompt + 配置级 appendSystemPrompt
└── README.md
```

## 关键点

- 请求级仅当次 run 生效、不写入 session；下次不带即失效，调用方需每次重发
- `Task`/`MultiTask` 派生子代理不继承请求级注入（child 只带各自配置级）
- 空串 `""` / `null` 视为未传；非 string 返回 `400`
- `apiKey` 永不写进 `agents.yaml`；环境变量优先级高于配置文件
- 换 LLM 只改环境变量，不改 `agents.yaml`
