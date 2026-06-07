# Code-Driven — 代码驱动示例

用 TypeScript 代码定义 Agent 配置，支持自定义工具、Hook 等全部 SDK 能力。

## 两种运行方式

### 方式一：agent.config.ts（推荐）

```bash
node --import tsx src/index.ts --config examples/code-driven
```

Runtime 自动检测 `agent.config.ts` 并加载。配置文件中可以使用 SDK 的全部 API（`defineTool`、`tool`、`zod` 等）。

### 方式二：直接运行脚本

```bash
npx tsx examples/code-driven/index.ts
```

纯 SDK 编程模式，不依赖配置文件加载。适合需要完全控制 Agent 创建过程的场景。

## 文件结构

```
code-driven/
├── agent.config.ts    # 声明式配置（defineConfig + 自定义工具）
├── index.ts           # 编程式启动（直接调 SDK API）
```

## agent.config.ts 说明

```ts
import { defineConfig } from "@zerone-agent/open-agent-runtime"
import { defineTool, tool } from "@zerone-agent/open-agent-sdk"

const weatherTool = defineTool({ ... })  // 自定义工具
const calcTool = tool("Calculator", ...) // Zod 风格工具

export default defineConfig({
  server: { port: 3000 },
  agents: [{ id: "smart", ... }],
})
```

## 测试

```bash
# 查看已注册的 Agent
curl http://localhost:3000/v1/agents

# 测试自定义天气工具
curl -N -X POST http://localhost:3000/v1/agents/smart/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"北京和上海今天天气怎么样？"}'

# 测试自定义计算器工具
curl -N -X POST http://localhost:3000/v1/agents/smart/runs \
  -H "Content-Type: application/json" \
  -d '{"message":"帮我算一下 2^10 * 3"}'
```

## 关键点

- `agent.config.ts` 优先级高于 `agents.yaml`，适合需要自定义工具和复杂逻辑的场景
- `defineConfig` 提供完整类型提示，IDE 会自动补全所有配置项
- `index.ts` 展示了纯 SDK 模式：手动创建 Agent → `registry.register()` → `createApp()` → `serve()`
- 自定义工具有两种定义方式：`defineTool()`（JSON Schema）和 `tool()`（Zod）
