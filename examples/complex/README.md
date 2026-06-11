# Complex — 多 Agent 示例

三个专业 Agent 各司其职：研究助手、编程助手、写作助手。

## 启动

```bash
node --import tsx src/index.ts --config examples/complex
```

## 文件结构

```
complex/
├── runtime.yaml            # 服务器配置
└── agents.yaml             # 3 个 Agent 定义（内联 systemPrompt）
```

## Agent 说明

| ID | 名称 | 可用工具 | 用途 |
|---|---|---|---|
| `researcher` | 研究助手 | WebSearch, WebFetch, Read, Glob, Grep | 搜索信息、分析资料 |
| `coder` | 编程助手 | Bash, Read, Write, Edit, Glob, Grep, LSP, TaskTool | 编写/修改/调试代码 |
| `writer` | 写作助手 | Read, Write, Edit, WebSearch | 撰写/编辑文本 |

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
# 列出所有 Agent
curl http://localhost:3000/v1/agents

# 研究助手 — 搜索信息
curl -N -X POST http://localhost:3000/v1/agents/researcher/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"搜索一下 TypeScript 5.8 的新特性"}'

# 编程助手 — 写代码
curl -N -X POST http://localhost:3000/v1/agents/coder/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我写一个 fibonacci 函数到 /tmp/fib.ts"}'

# 写作助手 — 写文案
curl -N -X POST http://localhost:3000/v1/agents/writer/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我写一段产品发布邮件"}'
```

## 关键点

- 多 Agent 通过 `allowedTools` 做工具隔离，每个 Agent 只能用指定的工具
- `permissionMode: acceptEdits` 让编程助手自动执行文件编辑，无需人工确认
- `systemPrompt` 内联在 yaml 中，也支持用 `systemPromptFile` 引用外部文件
