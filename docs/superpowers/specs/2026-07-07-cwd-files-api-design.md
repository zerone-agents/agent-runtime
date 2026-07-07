# cwd 文件列表与下载接口

**Date**: 2026-07-07
**Status**: Approved, ready for implementation plan
**Topic**: 新增 `/v1/files` 系列端点，对外暴露 cwd 下的文件清单和单文件下载

## 背景与动机

`open-agent-runtime` 启动后，agent 的"工作区"（cwd）里散落着各种对调试有用的文件：`agents.yaml` 配置、`systemPromptFile` 指向的 prompt 文件、agent 写入的 `outputs/`、技能扫描能看到的 `.openagent/skills/` 等。

目前外部客户端（前端控制台、运维面板）想看这些文件，只能 SSH 上去 `cat`，或者让 agent 在对话里调 `Read` 工具回显——两条路都别扭。需要一组 HTTP 接口直接把 cwd 下的文件结构和内容暴露出来，作为"工作区透视镜"。

## 目标

提供两个端点，覆盖"看有什么"和"拿内容"：

1. `GET /v1/files` — 列出 cwd 下的文件和目录，支持顶层/子目录/递归
2. `GET /v1/files/content` — 单文件流式下载，支持 HTTP Range

## 非目标

- **不做**文件上传 / 写入 / 删除（调试场景只读）
- **不做**文件搜索 / glob / 过滤（调用方自己拉列表客户端过滤）
- **不做**目录打包 / tar / zip 下载
- **不做**文件 watch / 变更通知
- **不做**内容脱敏（信任鉴权边界）
- **不做**多根目录（cwd 是唯一根）
- **不引入**新的运行时依赖（自写）

## 信任模型与安全边界

### 信任前提

- 调用方为**外部调试客户端**（前端控制台、运维面板），通过 `x-api-key` 鉴权
- 凡是持有有效 API key 的调用方，**等价于拥有 cwd 完整读权限**——包括 `agents.yaml` 里的密钥、`.env`、MCP server 配置等所有文件
- 这是用户在设计阶段明确选择的安全姿态，与"完全信任鉴权"的现有约定一致

### 安全底线（实现层必须保证）

即便信任调用方，以下属于**底层 bug 而非策略**，必须防御：

1. **路径遍历（path traversal）**：禁止通过 `../` 逃逸出 cwd
2. **绝对路径注入**：禁止 `path=/etc/passwd` 这类输入
3. **symlink 逃逸**：cwd 内的符号链接若指向 cwd 外，必须拒绝（防止调用方在 cwd 内放 symlink 偷系统文件）
4. **null byte 注入**：`path` 含 `\0` 一律拒绝

详见 [路径安全](#路径安全) 一节。

### 启用条件

- 端点挂在 `/v1/files` 下，**自动继承** `/v1/*` 的 `x-api-key` 鉴权
- 与现有 `/v1/agents`、`/v1/sessions` 一致，无需新代码
- 不配置 key 时所有 `/v1/*` 路由开放——与现状一致，本地开发友好

## 数据契约

### 端点 1：列表 `GET /v1/files`

**Query 参数：**

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `path` | string | `""`（cwd 根） | 相对 cwd 的子目录路径 |
| `recursive` | boolean | `false` | 是否递归整棵子树 |
| `depth` | number | — | 限制递归深度（仅 `recursive=true` 时生效；不填=无限） |

**响应（200）：**

```json
{
  "path": "",
  "entries": [
    {
      "name": "agents.yaml",
      "type": "file",
      "size": 482,
      "mtime": "2026-07-07T10:00:00.000Z",
      "mime": "text/yaml"
    },
    {
      "name": "src",
      "type": "directory",
      "size": 0,
      "mtime": "2026-07-07T09:30:00.000Z"
    },
    {
      "name": "link-to-outputs",
      "type": "symlink",
      "target": "outputs",
      "size": 0,
      "mtime": "2026-07-07T09:30:00.000Z"
    }
  ]
}
```

**递归模式（`?path=src&recursive=true&depth=2`）：**

```json
{
  "path": "src",
  "entries": [
    { "name": "src/index.ts", "type": "file", "size": 2048, "mtime": "...", "mime": "text/typescript" },
    { "name": "src/router/agent.ts", "type": "file", "size": 1843, "mtime": "...", "mime": "text/typescript" }
  ]
}
```

递归模式下 `name` 是相对 cwd 的完整路径（带子目录前缀），方便前端直接拼下载 URL。

### Entry 字段

| 字段 | 类型 | 必返回 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 顶层模式=文件名；递归模式=相对 cwd 的路径 |
| `type` | `"file"` \| `"directory"` \| `"symlink"` \| `"other"` | ✅ | `other` 用于 FIFO、socket 等非常规类型；`symlink` 的 target 解析失败时 type 仍为 `symlink` 但省略 `target` 字段 |
| `size` | number | ✅ | 字节数；目录与 broken symlink 为 `0` |
| `mtime` | string (ISO 8601) | ✅ | 最后修改时间 |
| `mime` | string | 仅 file | 由扩展名推断（不读内容）；目录/链接不返回此字段 |
| `target` | string | 仅 symlink 且可解析 | 链接指向的相对路径；指向 cwd 外时不返回此字段 |

### 排序规则

entries 数组排序稳定：**目录优先 → 名字字典序（区分大小写）**。保证前端渲染可缓存、可预测。

### 错误响应

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法（绝对路径、`..` 逃逸、含 null byte、path 是文件不是目录） | `{ "error": "Invalid path" }` 或 `{ "error": "Not a directory" }` |
| 404 | `path` 指向的目录不存在 | `{ "error": "Directory not found" }` |

### 端点 2：下载 `GET /v1/files/content`

```bash
GET /v1/files/content?path=reports/july.json
```

**成功响应头（200）：**

```
Content-Type: application/json              # 由扩展名推断
Content-Disposition: attachment; filename="july.json"
Content-Length: 482
Accept-Ranges: bytes
Last-Modified: Tue, 07 Jul 2026 10:00:00 GMT
```

**Range 请求（`Range: bytes=0-1023`）：**

```
HTTP/1.1 206 Partial Content
Content-Type: application/json
Content-Length: 1024
Content-Range: bytes 0-1023/48200
Accept-Ranges: bytes
```

支持单段 Range。多段（`bytes=0-100,200-300`）回退为 200 全文件返回（与业界常见做法一致）。

**实现要点：**

- **流式**：`fs.createReadStream(absPath)` → 通过 Hono 的 `c.body()` 或 `c.header()` + `stream()` 返回。**绝不**用 `readFile` 整体加载到内存
- **不设大小上限**：与"完全信任鉴权"一致；流式保证内存占用恒定
- **HEAD 方法支持**：`HEAD /v1/files/content?path=...` 返回与 GET 相同的响应头，无 body。用于下载前预查 Content-Length / Content-Type
- ** mime 推断**：自写一张 ~30 项的小表，未知扩展名 → `application/octet-stream`（强制下载，避免浏览器误渲染）

**错误响应：**

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法、path 指向目录 | `{ "error": "Invalid path" }` 或 `{ "error": "Not a file" }` |
| 404 | 文件不存在 | `{ "error": "File not found" }` |
| 416 | Range 不可满足（start >= size） | `{ "error": "Range not satisfiable" }` + `Content-Range: bytes */<size>` |

## 路径安全

所有端点拿到 `path` 参数后，先过统一函数 `safeResolve`：

```ts
function safeResolve(cwd: string, rel: string): string | null {
  // 1. 禁 null byte
  if (rel.includes("\0")) return null
  // 2. 禁绝对路径
  if (path.isAbsolute(rel)) return null
  // 3. 解析后必须仍在 cwd 之内
  const abs = path.resolve(cwd, rel)
  const relBack = path.relative(cwd, abs)
  if (relBack === ".." || relBack.startsWith("../")) return null
  // relBack === "" 表示 abs === cwd 本身，是合法的（列表根）
  return abs
}
```

### symlink 处理

`safeResolve` 只防"路径字符串层面的逃逸"。symlink 是文件系统层面的另一种逃逸，必须单独处理：

1. **列表端点**：使用 `readdir({ withFileTypes: true })` 拿到 `Dirent`，对每个 `entry.isSymbolicLink()` 的项用 `fs.realpath()` 解析
2. **解析后路径**再次走 `safeResolve` 检查；逃出 cwd 的 symlink **不返回 `target` 字段**，但 `type` 仍标为 `symlink`（让前端知道它存在但不能跟）
3. **下载端点**：`fs.realpath()` 解析后必须仍在 cwd 内；否则 400 拒绝（即便调用方有 API key，也不能通过 cwd 内的 symlink 读 cwd 外文件——这与"信任调用方"无关，是底层一致性约束）

### 为什么 realpath 而不是 stat

`fs.lstat` 看到的是链接本身，`fs.stat` 跟随链接。`fs.realpath` 给出最终绝对路径，便于和 cwd 做前缀比较。三者各有用途：

- 列表时 `lstat` → 拿到 symlink 的 mtime/size（链接本身的，不是目标的）
- 列表时 `realpath` → 判断是否逃出 cwd，决定是否填 `target`
- 下载时 `stat` → 拿到目标文件的实际 size（用于 Content-Length）

## 代码组织

### 新增 `src/files.ts`

不挂在 `src/router/` 下，因为这只是工具函数层，不含路由定义。导出：

```ts
export interface FileEntry {
  name: string
  type: "file" | "directory" | "symlink" | "other"
  size: number
  mtime: string
  mime?: string
  target?: string
}

export function safeResolve(cwd: string, rel: string): string | null
export async function listDir(
  cwd: string,
  opts: { path?: string; recursive?: boolean; depth?: number }
): Promise<{ path: string; entries: FileEntry[] }>
export function lookupMimeType(filename: string): string
```

### 新增 `src/router/files.ts`

定义 `createFilesRouter()` 工厂，返回 Hono 子路由：

```ts
import { Hono } from "hono"
import { stat, createReadStream } from "node:fs"
import { createReadStreamFromRange /* ... */ } from "../files.js"

export function createFilesRouter() {
  const router = new Hono()
  const cwd = process.cwd()

  router.get("/", async (c) => { /* 列表 */ })
  router.get("/content", (c) => { /* 下载 + Range */ })
  router.head("/content", (c) => { /* 仅响应头 */ })

  return router
}
```

### 修改 `src/router/index.ts`

在现有挂载基础上加一行：

```ts
import { createFilesRouter } from "./files.js"
// ...
app.route("/v1/files", createFilesRouter())
```

放在 `app.use("/v1/*", createAuthMiddleware(apiKey))` 之后，自动受鉴权保护。

### MIME 表

约 30 项，覆盖常见类型，放在 `src/files.ts` 内部（不导出，纯查表）：

```ts
const MIME_TABLE: Record<string, string> = {
  ".ts": "text/typescript", ".tsx": "text/typescript", ".js": "text/javascript",
  ".mjs": "text/javascript", ".cjs": "text/javascript", ".jsx": "text/javascript",
  ".json": "application/json", ".md": "text/markdown",
  ".yaml": "text/yaml", ".yml": "text/yaml",
  ".html": "text/html", ".htm": "text/html", ".css": "text/css",
  ".txt": "text/plain", ".log": "text/plain", ".csv": "text/csv",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".pdf": "application/pdf", ".zip": "application/zip", ".gz": "application/gzip",
  ".xml": "application/xml", ".sh": "application/x-sh",
  // 未知 → fallback "application/octet-stream"
}
```

## 测试

沿用现有 vitest 风格。新增 `src/__tests__/files.test.ts`。

### 测试组织

- 路径安全 / MIME / safeResolve 等纯函数 → 直接对 `src/files.ts` 单元测试
- 路由层 → 用 Hono 的 `app.request()` 风格（与现有 `registry.test.ts` 一致）
- 文件系统 → 用 `node:os.tmpdir()` 下创建临时目录，每个测试用例独立 setup/teardown，不污染真实 cwd

### 测试用例

**路径安全（`safeResolve`）：**

| 用例 | 期望 |
|---|---|
| 空字符串 | 返回 cwd |
| `subdir/file.txt` | 返回 cwd + path |
| `..` 单独 | `null` |
| `../etc/passwd` | `null` |
| `/etc/passwd` 绝对路径 | `null` |
| `subdir/../subdir/file` 规范化后仍合法 | 返回 cwd + 规范路径 |
| 含 null byte `file\0.txt` | `null` |

**MIME 表：**

| 用例 | 期望 |
|---|---|
| 已知扩展名（`.ts`、`.json`、`.md`） | 对应 MIME |
| 大小写（`.TS`、`.Json`） | 对应 MIME（大小写不敏感） |
| 无扩展名 | `application/octet-stream` |
| 未知扩展名 | `application/octet-stream` |

**列表端点：**

| 用例 | 验证点 |
|---|---|
| 顶层列表 | 返回 entries 数组，含 file/directory |
| `?path=subdir` | entries 来自子目录 |
| `?recursive=true` | 嵌套路径以相对 cwd 完整路径表达 |
| `?recursive=true&depth=1` | 深度限制生效，只到一层 |
| 不存在的 path | 404 |
| path 指向文件而非目录 | 400 |
| symlink 在 cwd 内 | type=`symlink`，`target` 字段存在且为相对路径 |
| symlink 逃出 cwd | type=`symlink`，`target` 字段不存在 |
| 排序：目录优先 + 字典序 | entries 顺序确定 |

**下载端点：**

| 用例 | 验证点 |
|---|---|
| 小文件 GET | 200，Content-Length 匹配，body 字节匹配 |
| HEAD 请求 | 200，响应头与 GET 一致，body 为空 |
| Range `bytes=0-99` | 206，Content-Length=100，Content-Range 正确 |
| Range 超出文件大小 | 416 + Content-Range: `bytes */<size>` |
| 多段 Range | 回退为 200 全文件 |
| 目录请求 | 400 `{ error: "Not a file" }` |
| 不存在 | 404 |
| 路径遍历 `../../etc/passwd` | 400 |
| 绝对路径 | 400 |
| null byte | 400 |
| symlink 逃出 cwd | 400 |
| broken symlink | 404（realpath 失败） |

**鉴权集成：**

| 用例 | 验证点 |
|---|---|
| 配置了 API key + 不带 header | 401 |
| 配置了 API key + 错误 key | 401 |
| 配置了 API key + 正确 key | 正常响应 |
| 未配置 key | 路由开放 |

## 兼容性

### 与现有路由的关系

- 新增三个端点，**不修改**任何现有端点
- 鉴权机制不变：自动继承 `/v1/*` 的 `x-api-key` 中间件保护
- `/health` 仍不受保护（不变）

### 与现有依赖的关系

- **不引入**新的运行时依赖
- `node:fs`、`node:path` 是 Node 内置
- Hono 已是依赖

### 前端消费方影响

纯新增能力，无破坏性变更。

## 风险评估

### 中等

- **敏感文件暴露**：调用方持 API key 即可读 cwd 全部内容，包括 `agents.yaml` 的 `auth.apiKey`、`.env`、MCP server 凭证。这是设计选择，需在 README 与 API 文档显眼处加安全提示——部署到生产前必须配置 `OPENAGENT_HTTP_API_KEY`，否则 `/v1/files` 会与现有 `/v1/*` 一样开放

### 低

- **路径遍历 / symlink 逃逸**：通过统一的 `safeResolve` + `realpath` 二次检查防御
- **大文件内存**：流式响应保证内存占用恒定，与文件大小无关
- **大量 entries 的 JSON 序列化**：默认顶层列表克制；递归模式由调用方主动开启，并可通过 `depth` 限制

## 注意事项（实现时关注）

1. **`safeResolve` 单点出口**：所有路径参数必须先过 `safeResolve`，没有任何"快路径"可以绕过。代码审查重点看这一条
2. **`realpath` 性能**：递归列表时大量 symlink 会触发多次 `realpath` 系统调用。在测试套件里造一个有 100+ symlink 的目录验证延迟可接受（< 100ms）
3. **`depth` 语义**：`depth=1` 表示"只展开一层"——即顶层 + 它的直接子目录的内容。明确定义避免实现时摇摆
4. **MIME 大小写**：表是 lowercase key，查询前 `ext.toLowerCase()`
5. **Hono 流式响应**：参考 `src/sse.ts` 现有写法，用 `c.body(readable)` 把 Node stream 包成 Web Stream
6. **Content-Disposition filename**：用 RFC 5987 编码处理中文文件名（`filename*=UTF-8''<percent-encoded>`），避免乱码
7. **路径分隔符**：Windows 上 `path.relative` 返回 `\`；返回 JSON 时统一替换为 `/`（URL 友好）

## 未来扩展（本期不做）

- **`GET /v1/files/stream?path=<dir>`**：tar 流式打包整个目录下载（用 `tar-stream` 库）
- **`POST /v1/files`**：上传文件到 cwd（需要配套配额、白名单目录等机制，安全模型更重）
- **`GET /v1/files/search?q=...`**：文件名或内容搜索
- **变更 watch + SSE 推送**：让前端实时刷新
- **`@hono/node-server/serve-static` 集成**：如果未来需要 SPA 静态资源服务，可考虑切换到官方中间件

## 相关

- 调研记录：见本 brainstorming 会话（`@enk0ded/serve-index` 因维护活跃度问题被否决；`@hono/node-server/serve-static` 因不支持目录列表被否决）
- 同类设计参考：`docs/superpowers/specs/2026-07-06-agent-detail-endpoint-design.md`（同样是只读端点，无破坏性新增）
- 鉴权基础：`docs/superpowers/specs/2026-06-17-x-api-key-auth-design.md`
