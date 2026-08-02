# Files API

`GET /v1/files` 系列 —— 对外暴露 runtime 工作目录（cwd）下的文件清单和单文件下载。

用于运维 / 调试 / 控制台展示——让外部客户端通过 HTTP 浏览 agent 的工作区，无需 SSH。

> **安全提示**：任何持有有效 API key 的调用方都可以读取 cwd 下的**全部**内容，包括 `agents.yaml`、`.env`、MCP server 凭证。生产部署前必须配置 `ZERONE_AGENT_HTTP_API_KEY`。

---

## 端点一览

| 方法 | 路径 | 用途 |
|---|---|---|
| `GET` | `/v1/files` | 列出 cwd 下的文件与目录 |
| `GET` | `/v1/files/content` | 单文件流式下载（支持 Range） |
| `HEAD` | `/v1/files/content` | 单文件元数据（响应头，无 body） |

所有端点：
- 受 `/v1/*` 的 `x-api-key` 鉴权保护（如配置）
- 路径参数 `path` 是相对 cwd 的子路径，禁止 `..` 逃逸、绝对路径、null byte
- cwd 内的 symlink 若解析后逃出 cwd，会返回 400 拒绝

---

## `GET /v1/files`

### Query 参数

| 参数 | 类型 | 默认 | 作用 |
|---|---|---|---|
| `path` | string | `""`（cwd 根） | 相对 cwd 的子目录路径 |
| `recursive` | `"true"` \| `"false"` | `false` | 是否递归整棵子树 |
| `depth` | number | 不限 | 限制递归深度（仅 `recursive=true` 时生效）；`depth=N` 表示展开 N 层子目录 |

### 响应（200）

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
      "name": "outputs-link",
      "type": "symlink",
      "size": 0,
      "mtime": "2026-07-07T09:30:00.000Z",
      "target": "outputs"
    }
  ]
}
```

### Entry 字段

| 字段 | 类型 | 必返回 | 说明 |
|---|---|---|---|
| `name` | string | ✅ | 顶层模式=文件名；递归模式=相对 cwd 的路径（用 `/` 分隔） |
| `type` | `"file"` \| `"directory"` \| `"symlink"` \| `"other"` | ✅ | `other` 用于 FIFO/socket 等非常规类型 |
| `size` | number | ✅ | 字节数；目录与 broken symlink 为 `0` |
| `mtime` | string (ISO 8601) | ✅ | 最后修改时间 |
| `mime` | string | 仅 file | 由扩展名推断 |
| `target` | string | 仅 symlink 且 target 解析后仍在 cwd 内 | 链接目标的相对路径 |

### 排序规则

entries 数组排序稳定：**directory 优先 → name 字典序（区分大小写）**。

### 错误响应

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法（绝对路径、`..` 逃逸、null byte） | `{ "error": "Invalid path" }` |
| 400 | `path` 指向文件而非目录 | `{ "error": "Not a directory" }` |
| 400 | `depth` 不是非负整数 | `{ "error": "Invalid depth parameter" }` |
| 404 | `path` 不存在 | `{ "error": "Directory not found" }` |

### curl 示例

```bash
# 顶层
curl -H "x-api-key: $KEY" http://localhost:3000/v1/files

# 子目录
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?path=src"

# 递归整棵树
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?recursive=true"

# 限制深度（顶层 + 1 层子目录）
curl -H "x-api-key: $KEY" "http://localhost:3000/v1/files?recursive=true&depth=1"
```

---

## `GET /v1/files/content`

单文件流式下载，支持 HTTP Range。

### Query 参数

| 参数 | 类型 | 必填 | 作用 |
|---|---|---|---|
| `path` | string | ✅ | 相对 cwd 的文件路径 |

### 成功响应（200）

响应头：

```
Content-Type: <由扩展名推断>
Content-Disposition: attachment; filename*=UTF-8''<percent-encoded>
Content-Length: <文件字节数>
Accept-Ranges: bytes
Last-Modified: <RFC 1123 格式>
```

不设大小上限——任何大小的文件都会被流式返回（`fs.createReadStream` + Web ReadableStream）。

### Range 请求

支持单段 Range：

```bash
curl -H "Range: bytes=0-99" \
     -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=logs/app.log"
```

返回 206 Partial Content：

```
HTTP/1.1 206 Partial Content
Content-Type: text/plain
Content-Length: 100
Content-Range: bytes 0-99/48200
Accept-Ranges: bytes
```

支持的 Range 格式：

| 格式 | 含义 |
|---|---|
| `bytes=0-99` | 第 0 到 99 字节 |
| `bytes=100-` | 第 100 字节到文件末尾 |
| `bytes=-100` | 最后 100 字节 |

多段 Range（`bytes=0-99,200-299`）回退为 200 全文件返回。

### 错误响应

| 状态 | 触发 | 响应体 |
|---|---|---|
| 400 | 路径非法、path 指向目录、symlink 逃出 cwd | `{ "error": "Invalid path" }` 或 `{ "error": "Not a file" }` |
| 404 | 文件不存在 | `{ "error": "File not found" }` |
| 416 | Range 不可满足（start ≥ size） | `{ "error": "Range not satisfiable" }` + `Content-Range: bytes */<size>` |

### curl 示例

```bash
# 全文下载
curl -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=outputs/report.json" \
     -o report.json

# Range 下载（前 1KB）
curl -H "x-api-key: $KEY" \
     -H "Range: bytes=0-1023" \
     "http://localhost:3000/v1/files/content?path=logs/app.log" \
     -o partial.log
```

---

## `HEAD /v1/files/content`

与 `GET` 相同的 query 参数和响应头，但**没有响应体**。

用于下载前预查 `Content-Length` / `Content-Type`，或验证文件是否存在（404 ↔ 200）。

### curl 示例

```bash
curl -I -H "x-api-key: $KEY" \
     "http://localhost:3000/v1/files/content?path=outputs/report.json"
```

输出：

```
HTTP/1.1 200 OK
Content-Type: application/json
Content-Disposition: attachment; filename*=UTF-8''report.json
Content-Length: 482
Accept-Ranges: bytes
Last-Modified: Tue, 07 Jul 2026 10:00:00 GMT
```

---

## 路径安全

所有 `path` 参数都会经过统一的 `safeResolve` 检查：

1. **拒绝 null byte**：`path` 含 `\0` → 400
2. **拒绝绝对路径**：`/etc/passwd` → 400
3. **拒绝路径遍历**：`../`、`sub/../../` → 400
4. **拒绝 symlink 逃逸**：cwd 内的符号链接若解析后指向 cwd 外，下载时返回 400；列表时 `target` 字段省略

这些是底层一致性约束，与是否配置鉴权无关。

---

## 不做的事（YAGNI）

- 文件上传 / 写入 / 删除（只读）
- 文件搜索 / glob
- 目录打包（tar/zip）
- 文件变更通知
- 内容脱敏
- 多根目录（cwd 是唯一根）

---

## 相关

- Agent 详情端点（同类只读 API）：[`docs/api/agent-detail.md`](agent-detail.md)
