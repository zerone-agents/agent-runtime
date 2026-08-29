# Code-Driven — 代码驱动示例

用 TypeScript 代码定义 Agent 配置，或直接用 SDK API 编程启动。

## 两种运行方式

### 方式一：agent.config.ts（声明式配置）

```bash
node --import tsx src/index.ts --config examples/code-driven
```

Runtime 自动检测 `agent.config.ts` 并加载。适合纯配置场景（模型、提示词、工具白名单等）。

> **注意：** `agent.config.ts` 经过 Zod schema 验证，只接受可序列化字段。自定义 `ToolDefinition` 无法通过配置文件传递，需使用方式二。

### 方式二：直接运行脚本（编程式，推荐用于自定义工具）

```bash
npx tsx examples/code-driven/index.ts
```

纯 SDK 编程模式，支持自定义工具、Hook 等全部能力。适合需要完全控制 Agent 创建过程的场景。

## 文件结构

```
code-driven/
├── agent.config.ts    # 声明式配置（无自定义工具）
├── index.ts           # 编程式启动（自定义工具 + Hook）
```

## index.ts 说明

展示了 SDK + Runtime 编程式用法：

| 能力 | 说明 |
|---|---|
| `defineTool()` | JSON Schema 风格自定义工具（GetWeather） |
| `tool()` + `sdkToolToToolDefinition()` | Zod 风格自定义工具（Calculator） |
| `hooks` | PreToolUse / PostToolUse 日志 |
| `host.agents.register()` | 手动注册代码构建的 Agent（覆盖 config 中同 id 条目） |
| `createRuntime()` | 组装 Host 并托管生命周期（`start()` 先于 listen，`stop()` 优雅停机） |

## 环境变量

环境变量优先级高于配置文件（`agent.config.ts` 和 `index.ts` 均生效）：

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
# 查看已注册的 Agent
curl http://localhost:3000/v1/agents

# 测试自定义天气工具
curl -N -X POST http://localhost:3000/v1/agents/smart/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"北京和上海今天天气怎么样？","stream":"block"}'

# 测试自定义计算器工具
curl -N -X POST http://localhost:3000/v1/agents/smart/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我算一下 2^10 * 3","stream":"block"}'
```

## 关键点

- `agent.config.ts` 适合纯声明式配置（无自定义工具），优先级高于 `agents.yaml`
- `index.ts` 展示完整 SDK 模式：`createRuntime()` → `host.agents.register()` → `host.start()` → `serve()`，SIGINT/SIGTERM 时优雅停机
- `tool()` 返回 `SdkMcpToolDefinition`，需用 `sdkToolToToolDefinition()` 转换后才能传入 `createAgent`
- `defineTool()` 直接返回 `ToolDefinition`，无需转换
- `host.stop()` 优雅停机：排水进行中的 runs、停止 cron 调度（若启用）并关闭所有 agents
