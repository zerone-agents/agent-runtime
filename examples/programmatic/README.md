# Programmatic — SDK + Runtime 组件组合示例

用代码驱动方式组合 agent-sdk 和 agent-runtime 的全部能力。

## 启动

```bash
npx tsx examples/programmatic/index.ts
```

## 展示了什么

| 能力 | 代码位置 |
|---|---|
| 自定义工具 `defineTool` | `stockTool` — 查询股票价格 |
| 自定义工具 `tool()` (Zod) | `noteTool` — 保存笔记 |
| Hook 系统 | `createLoggingHooks()` — PreToolUse/PostToolUse 日志 |
| 多 Agent + 工具隔离 | analyst（搜索+文件）、ops（Bash+读写编辑） |
| `AgentRegistry.register()` | 手动注册已创建的 Agent |
| `createApp()` | 组装 Hono 路由 |
| 自定义扩展路由 | `GET /custom/status` — 运行时状态 |

## 环境变量

环境变量优先级高于代码中的默认值：

| 变量 | 说明 |
|---|---|
| `ZERONE_AGENT_MODEL` | 模型名称（如 `claude-sonnet-4-6`、`kimi-k2.5`） |
| `ZERONE_AGENT_API_KEY` | API Key |
| `ZERONE_AGENT_BASE_URL` | API Base URL |
| `ZERONE_AGENT_API_TYPE` | API 类型（`anthropic-messages` / `openai-completions`） |

```bash
export ZERONE_AGENT_API_KEY=sk-xxx
export ZERONE_AGENT_BASE_URL=https://xxx
export ZERONE_AGENT_MODEL=kimi-k2.5
export ZERONE_AGENT_API_TYPE=anthropic-messages
```

## 测试

```bash
# 运行状态
curl http://localhost:3000/custom/status

# 金融分析助手
curl -N -X POST http://localhost:3000/v1/agents/analyst/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"查一下 AAPL 和 TSLA 的股价","stream":"block"}'

# 运维助手
curl -N -X POST http://localhost:3000/v1/agents/ops/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"读一下根目录的 package.json","stream":"block"}'
```

## 文件结构

```
programmatic/
├── index.ts     # 完整示例（单文件，可直接运行）
└── README.md
```

与 `code-driven/` 的区别：
- `code-driven/` 使用 `agent.config.ts` 声明式配置，由 Runtime 自动加载
- `programmatic/` 纯代码控制，从 `createAgent` 到 `serve` 全部手写，适合需要最大灵活性的场景
