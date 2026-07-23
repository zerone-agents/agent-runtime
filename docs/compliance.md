# AIGC 内容标识合规设计文档

> **状态**：草案，待内部评审
> **适用法规**：《人工智能生成合成内容标识办法》（2025-09-01 施行）
> **适用国标**：GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》
> **配套指南**：《网络安全标准实践指南——人工智能生成合成内容标识 服务提供者编码规则》（网安秘字〔2025〕29 号）
> **最后更新**：2026-07-23

---

## 0. 文档目的

明确本仓库（`@zerone-agent/open-agent-runtime`，线上对应域名 `runtime.currantmind.cn`）作为 AI 生成合成服务提供者的法定义务，给出技术改造方案、合规取证清单和上下游协议要求，供工程团队、法务、产品联合评审。

---

## 1. 角色定位（必须先对齐的事实）

### 1.1 为什么本仓库是"生成合成服务提供者"

《标识办法》第五条 + GB 45438-2025 实践指南明确定义：

> **生成合成服务提供者**：利用人工智能技术（包括**通过提供可编程接口等方式**）向公众提供生成合成文本、图片、音频、视频、虚拟场景等内容服务的组织、个人。

本仓库对外暴露 HTTP API（`POST /v1/agents/:id/runs`），调用大模型并对外返回 AI 生成的文本内容。**符合"通过可编程接口向公众提供生成合成内容服务"的定义，属于法律意义上的"生成合成服务提供者"。**

### 1.2 责任链条

| 主体 | 角色 | 核心义务 |
|------|------|----------|
| 智谱 GLM 模型方 | 上游模型提供者 | 模型备案、训练数据合规（《生成式 AI 暂行办法》） |
| **本仓库（open-agent-runtime）** | **生成合成服务提供者** | **打显式 + 隐式标识、保留反查日志、出具有关材料** |
| 下游 AgentHub / 业务方 | 内容传播服务提供者 | 核验元数据、添加显著提示标识、回填传播字段 |
| 应用市场 / 分发平台 | — | 上架审核时核验本仓库输出的标识材料 |

### 1.3 之前那份分析的偏差修正

> "第三方大模型服务提供方只有一个：智谱 currantmind。隐式标识的法定义务方是智谱 currantmind，不是你们项目。"

**此结论不准确。** 备案义务确实在模型方（智谱），但**标识义务**（在输出内容上嵌入隐式标识）落在"直接向调用方提供 AI 内容"的那一层，即本仓库。下游无法核验未嵌入的元数据；事后"截图取证"是举证手段，不等于履行义务。

---

## 2. 现状分析

### 2.1 数据流

```
Client
  ↓ POST /v1/agents/:id/runs
Hono Router (src/router/agent.ts)
  ↓
AgentRegistry → SDK Agent
  ↓ AsyncGenerator<SDKMessage>
SSE Bridge (src/sse.ts)
  ↓ SSE 事件流
Client
```

### 2.2 输出形态

| 通道 | 文件 | 形态 |
|------|------|------|
| SSE 默认流（`stream: true`） | `src/sse.ts` | 文本 token 流（`partial_message`/`assistant`/`result`） |
| SSE block 流（`stream: "block"`） | 同上 | 整条消息粒度 |
| Blocking JSON（`stream: false`） | `src/router/agent.ts` | `{ text, usage, numTurns, durationMs }` |
| 文件浏览 `/v1/files` | `src/router/files.ts` | 只读浏览 cwd，**不产生 AI 文件** |

### 2.3 关键事实

- 本仓库**不直接产生**图片/音频/视频/虚拟场景文件
- 所有 AI 输出均为**文本**，通过 HTTP/SSE 传递
- 因此**无需**实现 EXIF/XMP/JUMBF 等二进制元数据嵌入方案
- 文本类内容的隐式标识，可通过**响应信封（envelope）的结构化字段**承载

---

## 3. 合规改造方案

### 3.1 设计原则

1. **协议增量不破坏**：仅向响应中添加字段，不修改既有字段语义
2. **流首尾双锚点**：在 SSE 的 `system` init 和 `result` 事件中均带标识，应对中途断流
3. **可反查**：每次生成分配全局唯一 `ProduceID`，落库以便协查
4. **可配置**：`ContentProducer` 编码、是否签名、是否追加显式提示等均通过配置/环境变量控制
5. **零默认开箱**：本地开发不强制开标识；生产部署通过配置开启

### 3.2 隐式标识字段结构（符合 GB 45438-2025）

```jsonc
{
  "Label": "1",                              // 必填。1=属于AI生成；2=可能；3=疑似
  "ContentProducer": "001191320118MAK93FC72D10001", // 必填。currant.cn 的 27 位服务提供者编码（位 1-23 为主体段，24-27 为模型码）
  "ProduceID": "20260723103000-a1b2c3d4-e5f6",   // 必填。每次 run 的全局唯一编号
  "ReservedCode1": "",                          // 可选。SHA-256(metadata) 用于防篡改
  "ContentPropagator": "",                      // 内容传播时必填，由下游回填
  "PropagateID": "",                            // 同上
  "ReservedCode2": ""                           // 可选
}
```

### 3.3 `ContentProducer` 编码规则（27 位）

依据《服务提供者编码规则》实践指南：

| 位段 | 长度 | 含义 | 取值 |
|------|------|------|------|
| 1–2 | 2 | 标识格式定义码 | 固定 `00` |
| 3 | 1 | 主体类型 | `1`=组织 |
| 4 | 1 | 主体绑定方式 | `1`=统一社会信用代码 |
| 5–22 | 18 | 主体代码 | **运营本服务的主体（currant.cn）的统一社会信用代码** |
| 23 | 1 | 服务类型 | `1`=生成合成服务 |
| 24–27 | 4 | 模型/应用码 | currant.cn 自行分配，按模型区分（见下表） |

#### 3.3.1 关键判定：为什么是 currant.cn 的代码，不是上游模型方

GB 45438-2025 实践指南对"生成合成服务提供者"的定义是"利用人工智能技术（**包括通过提供可编程接口等方式**）向公众提供生成合成内容服务的组织"——**判定要素是"谁通过 API 对外提供 AI 内容"，而非"谁的模型"**。

在本架构中：

| 主体 | 角色 | 是否本服务的"生成合成服务提供者" |
|------|------|-----------------------------------|
| 智谱（GLM）/ aliyun（Qwen）等 | 上游模型供应商 | 否（它们对自己的直连 API 客户才是） |
| **currant.cn（运营 runtime.currantmind.cn 的主体）** | **直接对调用方暴露 `/v1/agents/:id/runs`** | **是** |

因此 `ContentProducer` 的 5–22 位**必须用 currant.cn 自己的统一社会信用代码**。上游模型方的代码不参与本字段，只在合规材料中作为"上游模型已备案"的旁证。

#### 3.3.2 模型/应用码（位 24–27）内部映射表

`ContentProducer` 绑的是主体（不变），模型信息走 24–27 位区分。建议建立内部映射表，由配置注入：

| 代码 | 模型 |
|------|------|
| `0001` | 智谱 GLM-4.5 |
| `0002` | 通义千问 Qwen-Max |
| `0003` | DeepSeek-V3 |
| `0004` | Claude Sonnet 4 |
| `0005` | GPT-4o |
| …… | 自行扩展 |

切换上游模型 = 改 4 位字符；主体段（位 1–23）**永远不变**。ProduceID 反查日志通过这 4 位即可识别上游模型。

#### 3.3.3 27 位编码完整示例

```
00              1   1   91320118MAK93FC72D   1   0001
└─版本(固定)─┘ └主体┘ └绑定方式┘ └─信用代码(18位)─┘ └服务┘ └模型码┘
                                                (currant.cn)        (GLM-4.5)

完整 27 位: 001191320118MAK93FC72D10001
```

> 📌 **待法务提供**：
> - currant.cn 运营主体的统一社会信用代码
> - currant.cn 是否已在网信办完成"生成合成服务"备案（如未备案需尽快启动）

### 3.4 `ProduceID` 生成规则

格式：`YYYYMMDDHHmmss-<UUIDv4 前 12 位>`

- 时间戳保证人眼可读
- UUID 段保证全局唯一
- 示例：`20260723103000-a1b2c3d4e5f6`

落库字段（最小集）：

| 字段 | 说明 |
|------|------|
| `produceId` | 主键 |
| `createdAt` | 生成时间 |
| `agentId` | 哪个 agent |
| `sessionId` | 会话 ID |
| `model` | 模型名 |
| `callerId` | 调用方标识（从 API Key 或 header 推断） |
| `usage` | token 用量 |
| `contentHash` | 输出文本 SHA-256（用于事后比对） |

### 3.5 注入点（三处）

#### a) SSE `system` init 事件（流首）

```jsonc
event: system
data: {
  "type": "system", "subtype": "init",
  "sessionId": "...",
  "agentId": "...",
  "aigc": { /* 隐式标识 JSON */ }
}
```

#### b) SSE `result` 事件（流尾，最关键取证锚点）

```jsonc
event: result
data: {
  "type": "result", "subtype": "success",
  "text": "...",
  "usage": {...},
  "aigc": { /* 同一份隐式标识 JSON */ }
}
```

#### c) Blocking JSON 响应（`src/router/agent.ts:57` 附近）

```jsonc
{
  "sessionId": "...",
  "text": "...",
  "usage": {...},
  "numTurns": 3,
  "durationMs": 1234,
  "aigc": { /* 同一份隐式标识 JSON */ }
}
```

### 3.6 显式标识（强烈建议同时做）

不污染正文文本，改用结构化提示：

```jsonc
"aigcExplicitHint": true
```

下游消费方据此在 UI 渲染"AI 生成"角标或文末提示。

> 文末追加 `\n\n〔本内容由 AI 生成〕` 的方案会破坏工具调用、代码块等结构化输出，**不推荐**。

### 3.7 配置 schema（YAML）

```yaml
aigc:
  enabled: true                                  # 默认 false（本地开发友好）
  contentProducer: "001191320118MAK93FC72D10001" # currant.cn 完整 27 位编码（位 1-23 为主体段，位 24-27 为模型码；切换模型只改最后 4 位）
  label: "1"                                     # 默认 "1"
  serviceName: "open-agent-runtime"              # 用于日志
  produceIdPrefix: ""                            # 可选，多实例部署区分
  signingKey: ""                                 # 可选，填了会对 metadata 做 SHA-256 HMAC 写入 ReservedCode1
  explicitHint: true                             # 是否输出 aigcExplicitHint
  # 模型 → 服务扩展码（位 24-27）的映射，用于在 ProduceID 反查日志中识别上游模型
  modelCodes:
    "claude-sonnet-4-6": "0004"
    "glm-4.5": "0001"
    "qwen-max": "0002"
    "deepseek-chat": "0003"
```

环境变量等价：`OPENAGENT_AIGC_ENABLED`、`OPENAGENT_AIGC_CONTENT_PRODUCER` 等。

**切换上游模型时**：仅需在 agent 配置中改 `model` 字段，runtime 会自动根据 `modelCodes` 映射刷新 `ContentProducer` 的 24–27 位；主体段保持稳定，不影响下游识别本服务。

### 3.8 文件输出兜底（架构预留，本期不实现）

当前 `/v1/files` 只读浏览，不会产生 AI 文件。但若将来 Agent 通过 `Write` 工具落地图片/音频/视频，需在 SDK 的 `PostToolUse` hook 里按文件类型嵌入元数据：

| 文件类型 | 嵌入方式 |
|---------|----------|
| PNG/JPEG | XMP `AIGC` 字段（参考腾讯云数据万象 `imageMogr2/AIGCMetadata` 实现） |
| MP3/WAV/MP4 | ID3/盒装 metadata |
| 文本类文件 | 文件头/尾插入 AIGC JSON 注释 + 同名 `.aigc.json` sidecar |

本仓库职责仅限**预留 hook 接口**，实际嵌入逻辑可下沉至 SDK 或单独工具库。

---

## 4. 代码改造清单

| 模块 | 文件 | 改动 | 估行数 |
|------|------|------|--------|
| 配置 schema | `src/config.ts` | 新增 `aigc` 段；环境变量映射 | ~30 |
| 标识构造 | 新增 `src/aigc.ts` | `buildAigcLabel()`、`signLabel()`、`generateProduceId()` | ~80 |
| ProduceID 落库 | 新增 `src/audit-log.ts`（或 `src/metrics.ts` 增段） | `recordRun(produceId, meta)` | ~50 |
| SSE 注入 | `src/sse.ts` | 包装 `system`/`result` 事件，注入 `aigc` | ~30 |
| Blocking 注入 | `src/router/agent.ts` | 在第 57 行附近 JSON 响应加 `aigc` | ~10 |
| 显式标识字段 | 同上两处 | `aigcExplicitHint: true` | ~5 |
| 单测 | 新增 `src/__tests__/aigc.test.ts` | 字段结构、ProduceID 唯一性、签名、配置关闭时不输出 | ~100 |
| 集成测试 | `src/__tests__/router-agent.test.ts` | 在 blocking/SSE 用例里断言 `aigc` 字段存在 | ~30 |
| 类型导出 | `src/index.ts` | `AigcLabel`、`buildAigcLabel` 等 | ~5 |

### 4.1 代码示例（评审参考）

```ts
// src/aigc.ts
import { createHash, randomUUID } from "node:crypto"

export interface AigcLabel {
  Label: "1" | "2" | "3"
  ContentProducer: string
  ProduceID: string
  ReservedCode1?: string
  ContentPropagator?: string
  PropagateID?: string
  ReservedCode2?: string
}

export interface AigcConfig {
  enabled: boolean
  contentProducer: string
  label?: "1" | "2" | "3"
  signingKey?: string
  produceIdPrefix?: string
}

export function generateProduceId(prefix = ""): string {
  const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)
  const uuid = randomUUID().replace(/-/g, "").slice(0, 12)
  return `${prefix}${ts}-${uuid}`
}

export function buildAigcLabel(
  cfg: AigcConfig,
  produceId: string = generateProduceId(cfg.produceIdPrefix),
): AigcLabel {
  const label: AigcLabel = {
    Label: cfg.label ?? "1",
    ContentProducer: cfg.contentProducer,
    ProduceID: produceId,
  }
  if (cfg.signingKey) {
    label.ReservedCode1 = signLabel(label, cfg.signingKey)
  }
  return label
}

export function signLabel(label: AigcLabel, key: string): string {
  const payload = `${label.Label}|${label.ContentProducer}|${label.ProduceID}`
  return createHash("sha256").update(payload + "|" + key).digest("hex")
}
```

---

## 5. 取证材料清单（出应用市场 / 监管核查用）

依据小米/华为/OPPO 等应用市场的《人工智能生成合成内容标识材料要求》模板：

| # | 材料 | 内容 | 负责方 |
|---|------|------|--------|
| 1 | 显式标识方案 | 字段定义、位置说明、UI 示例图 | 产品 + 前端（下游 AgentHub） |
| 2 | 显式标识位置示例图 | 下游 UI 截图 | 下游 AgentHub |
| 3 | 隐式标识技术说明文档 | 字段结构、嵌入位置、ContentProducer 编码、ProduceID 反查机制 | 本仓库团队 |
| 4 | 隐式标识内容截图 | Postman/curl 调用 `/v1/agents/:id/runs` 的响应截图，圈出 `aigc` 字段 | 本仓库团队 |
| 5 | 算法备案凭证 | 上游模型方（如智谱 GLM / aliyun Qwen）的生成式 AI 服务备案号 | 上游模型方 |
| 6 | 安全评估报告 | 《生成式 AI 服务安全基本要求》合规自评 | 法务 + 安全 |
| 7 | 承诺函（公章） | 标准模板，承诺材料真实、备案合规 | 法务 |

---

## 6. 上下游协议要求

### 6.1 给下游 AgentHub 的接入须知

下游必须：

1. **核验**响应中的 `aigc` 字段存在且 `Label="1"`
2. 在用户可见界面添加**显著提示标识**（"AI 生成"角标或文末提示）
3. 若再分发内容，需**回填** `ContentPropagator`（下游平台编码）和 `PropagateID`（下游内容编号）
4. 保留日志至少 6 个月（《互联网信息服务深度合成管理规定》要求）

### 6.2 给上游模型方（智谱 / aliyun / 其他）的对齐点

- 确认上游模型已完成《生成式 AI 服务管理暂行办法》**备案**，索取备案号
- 上游模型方的主体信息（统一社会信用代码等）**不进入本服务的 `ContentProducer` 字段**，仅作为合规旁证材料留档
- 若上游模型方在自身响应中下发了任何元数据，本服务**统一重新打标**（用 currant.cn 的编码），便于本层反查与责任边界清晰
- 切换或新增上游模型时，仅需更新 `aigc.modelCodes` 映射表与合规旁证材料，**无需变更主体段编码**

---

## 7. 风险与未决问题

| # | 问题 | 处理建议 |
|---|------|----------|
| 1 | 27 位 `ContentProducer` 编码需要网信办备案后才能拿到正式段位 | 上线前必须完成；测试期可用占位编码，但生产禁用 |
| 2 | currant.cn 运营主体的统一社会信用代码需法务确认 | 内部法务 |
| 3 | ProduceID 反查日志的存储介质（DB / 文件 / 日志系统）未定 | 本设计预留接口；首期可用文件日志 + 日志中心 |
| 4 | 多实例部署的 ProduceID 全局唯一性 | UUIDv4 已保证；可选加 `produceIdPrefix` 区分实例 |
| 5 | 流式输出中途断流，客户端拿不到尾部 `result` 的标识 | 流首 `system` init 也注入一份，双锚点兜底 |
| 6 | Agent 调用 `Write` 工具产生 AI 文件，未走隐式标识 | 本期不实现，预留 `PostToolUse` hook，后续工具库下沉 |
| 7 | 已有客户端不解析新字段，标识"丢失" | 协议层是增量；需推动下游升级并写进接入合规要求 |
| 8 | 切换或同时使用多个上游模型（如同时跑 GLM + Qwen） | 通过 `aigc.modelCodes` 映射表区分；ContentProducer 主体段不变，仅模型码位（24-27）切换 |

---

## 8. 实施时间表（建议）

| 阶段 | 工作 | 依赖 |
|------|------|------|
| W1 | 法务确认 currant.cn 运营主体的统一社会信用代码；启动/核对网信办生成合成服务备案 | 外部 |
| W1 | 本文档评审通过 | 内部 |
| W2 | 代码改造（配置/aigc.ts/注入/测试） | 文档定稿 |
| W2 | ProduceID 反查日志接入现网日志系统 | 运维 |
| W3 | 下游 AgentHub 联调（核验 + 回填 + 显式标识 UI） | 下游团队 |
| W3 | 生产灰度（先打开 `aigc.enabled`，观察响应大小与性能） | — |
| W4 | 出具备证材料（含上游模型方备案旁证），提交应用市场 / 留档 | 法务 + 产品 |

---

## 9. 参考资料

- 《人工智能生成合成内容标识办法》（网信办、工信部、公安部、广电总局，2025-03-14 发布，2025-09-01 施行）：https://www.cac.gov.cn/2025-03/14/c_1743654684782215.htm
- GB 45438-2025《网络安全技术 人工智能生成合成内容标识方法》：https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=F32EA2A561F1886CD8D606513512D547
- 《网络安全标准实践指南——人工智能生成合成内容标识 服务提供者编码规则》（网安秘字〔2025〕29 号）
- 《互联网信息服务深度合成管理规定》第十六条、第十七条
- 《生成式人工智能服务管理暂行办法》
- 小米澎湃 OS 开发者平台《人工智能生成合成内容标识材料要求》：https://dev.mi.com/xiaomihyperos/documentation/detail?pId=2110
- 腾讯云数据万象 AIGC 元数据接入示例（图片 XMP 嵌入参考）：https://cloud.tencent.com.cn/document/product/460/122024
