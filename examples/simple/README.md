# Simple — 单 Agent 示例

一个通用助手，支持文件读写、命令执行等内置工具。

## 启动

```bash
node --import tsx src/index.ts --config examples/simple
```

## 文件结构

```
simple/
├── runtime.yaml        # 服务器配置（端口、CORS）
├── agents.yaml         # Agent 定义
└── prompts/
    └── assistant.md    # 系统提示词
```

## 环境变量

环境变量优先级高于配置文件：

| 变量 | 说明 |
|---|---|
| `OPENAGENT_MODEL` | 模型名称（如 `claude-sonnet-4-6`、`kimi-k2.5`） |
| `OPENAGENT_API_KEY` | API Key |
| `OPENAGENT_BASE_URL` | API Base URL |
| `OPENAGENT_API_TYPE` | API 类型（`anthropic-messages` / `openai-completions`） |

```bash
export OPENAGENT_API_KEY=sk-xxx
export OPENAGENT_BASE_URL=https://xxx
export OPENAGENT_MODEL=kimi-k2.5
export OPENAGENT_API_TYPE=anthropic-messages
```

## 测试

```bash
# 查看已注册的 Agent
curl http://localhost:3000/v1/agents

# SSE 流式对话（raw，逐 token）
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"读一下 package.json 告诉我项目名和版本号"}'

# SSE 流式对话（block，按完整消息分块）
curl -N -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"读一下 package.json 告诉我项目名和版本号","stream":"block"}'

# 阻塞式对话
curl -X POST http://localhost:3000/v1/agents/assistant/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"你好","stream":false}'
```

## 关键点

- 最小配置：只需 `agents.yaml`，`runtime.yaml` 可省略（使用默认端口 3000）
- `systemPromptFile` 引用外部 `.md` 文件，提示词长时推荐使用
- 不指定 `allowedTools` 时默认使用 SDK 全部内置工具
