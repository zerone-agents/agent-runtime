# Multi-Turn — 多轮对话示例

演示 per-request Agent 工厂模式下的多轮对话（session resume）。

## 原理

每次 HTTP 请求都会创建一个全新的 Agent，请求结束后销毁。会话连续性通过 `sessionId` 实现：

1. 第一次请求不传 `sessionId` → Agent 创建新 session → 响应中返回 `sessionId`
2. 后续请求传入该 `sessionId` → Agent 用 `resume` 恢复历史消息 → 上下文连续

## 启动

```bash
node --import tsx src/index.ts --config examples/multi-turn
```

## 环境变量

```bash
export OPENAGENT_API_KEY=sk-xxx
export OPENAGENT_BASE_URL=https://xxx
export OPENAGENT_MODEL=kimi-k2.5
export OPENAGENT_API_TYPE=anthropic-messages
```

## 测试

### 自动化脚本

```bash
bash examples/multi-turn/test.sh
```

脚本会自动完成三轮对话并验证 sessionId 一致性。

### 手动测试

```bash
# 第一轮：新会话，不传 sessionId
curl -X POST http://localhost:3000/v1/agents/chatbot/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫小明，请记住我的名字","stream":false}'

# 记下响应中的 sessionId，比如 "abc-123"

# 第二轮：传入 sessionId resume
curl -X POST http://localhost:3000/v1/agents/chatbot/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫什么名字？","stream":false,"sessionId":"abc-123"}'
# 应该回答"小明"

# 第三轮：继续同一会话
curl -X POST http://localhost:3000/v1/agents/chatbot/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"我们之前聊了什么？","stream":false,"sessionId":"abc-123"}'
# 应该提到之前关于名字的对话
```

### SSE 流式多轮

```bash
# 第一轮（流式）
curl -N -X POST http://localhost:3000/v1/agents/chatbot/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"你好，我是小红"}'
# 从 SSE 事件的 system.init 中获取 session_id

# 第二轮（流式 + resume）
curl -N -X POST http://localhost:3000/v1/agents/chatbot/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"我叫什么？","sessionId":"上一步的session_id"}'
```

## 文件结构

```
multi-turn/
├── agents.yaml     # Agent 定义（单 agent，inline systemPrompt）
├── test.sh         # 自动化测试脚本
└── README.md
```

## 关键点

- 每次 `/runs` 请求创建独立 Agent，请求结束自动销毁
- `sessionId` 是唯一的会话标识，由 SDK 管理，持久化到 `~/.openagent/sessions/`
- 不传 `sessionId` = 新会话，传了 `sessionId` = resume 已有会话
- 响应中始终包含当前 `sessionId`，客户端应保存用于后续请求
