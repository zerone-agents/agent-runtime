# Agent Datasets（知识库）配置设计

## 背景

`agents.yaml` 需要支持为每个 agent 配置一组知识库（datasets），并在创建 Agent 时将这些知识库信息注入到系统提示词中，供模型在回答或执行任务时参考。

## 目标

- 在 `AgentDefinition` 中新增可选的 `datasets` 字段，结构为 `Record<string, string>`（`dataset-id: description`）。
- 当配置了 `datasets` 时，将其格式化为固定 XML 标签块追加到系统提示词中。
- 即使 agent 没有原始 `systemPrompt`，只要配置了 `datasets` 也要注入。
- 保持子 agent（`SubagentDefinition`）不变，不加入 `datasets` 支持。

## 设计

### 配置格式示例

```yaml
agents:
  - id: coder
    name: coder
    systemPrompt: You are a coding assistant.
    datasets:
      dataset-1: Primary dataset for code generation
      dataset-2: Secondary dataset for testing
```

### 系统提示词注入格式

当 `datasets` 存在时，追加以下内容：

```
<datasets>
 - dataset-1: Primary dataset for code generation
 - dataset-2: Secondary dataset for testing
</datasets>
```

### 合并规则

`resolveSystemPrompt(agent, configDir)` 的行为：

1. 取得基础 prompt（`systemPrompt` 或 `systemPromptFile` 内容），可能为 `undefined`。
2. 若 `agent.datasets` 已配置（包括空对象 `{}`），生成 datasets 格式化块。
3. 合并：
   - 基础 prompt 存在 → 在末尾追加 `\n\n` + datasets 块。
   - 基础 prompt 不存在 → 直接返回 datasets 块。
4. 若两者都不存在，返回 `undefined`。

## 实现范围

### 修改文件

- `src/config.ts`
  - `AgentDefinitionSchema` 新增 `datasets: z.record(z.string()).optional()`。
  - `resolveSystemPrompt()` 内部调用新的 `formatDatasets()` 辅助函数并追加。
  - 新增 `formatDatasets()`：将 `Record<string, string>` 渲染为 `<datasets>` 标签块。
- `src/__tests__/config.test.ts`
  - 新增解析与 `resolveSystemPrompt` 的测试用例。

### 不修改的文件

- `src/registry.ts`：继续复用 `resolveSystemPrompt()`，不感知 datasets 格式。
- `src/router/`、HTTP API、认证逻辑：无变化。
- `SubagentDefinitionSchema`：不扩展 `datasets`。

## 测试策略

新增以下测试：

1. `RuntimeConfigSchema` 接受带 `datasets` 的完整配置。
2. `resolveSystemPrompt` 在 `systemPrompt` 后追加 datasets 块。
3. `resolveSystemPrompt` 在无 `systemPrompt` 时返回纯 datasets 块。
4. `resolveSystemPrompt` 在 `datasets` 为空对象时仍返回空的 `<datasets>` 块。
5. `resolveSystemPrompt` 在无 `datasets` 时保持原行为不变。

## 兼容性

- 外部 HTTP API 与配置挂载契约不变。
- 不配置 `datasets` 的 agent 行为完全不变。
- `AgentDefinition` 类型自动导出新增的 `datasets` 字段。

## 分支

`feat/datasets`
