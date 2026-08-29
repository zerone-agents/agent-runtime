# Docker 使用说明

项目已提供 Dockerfile，可将 agent-runtime 打包为容器镜像运行。

## 镜像运行时环境

镜像基于 **ubuntu:26.04**，内置 Node.js 与 Python 双运行时，方便 Agent 在容器内直接执行脚本、处理文档或进行数据分析。

| 组件 | 版本（来自 ubuntu:26.04 仓库） | 说明 |
|---|---|---|
| Ubuntu | 26.04 LTS (Resolute Raccoon) | 基础镜像，glibc |
| Node.js | 22.22.1 | 与原 `node:22-alpine` 大版本一致 |
| npm | 10.x | apt 自带 9.2.0，Dockerfile 中已升级到 10 |
| Python | 3.14.x | 系统自带，无需额外安装 |
| pip | 25.x | 支持 Agent 运行时 `pip install` 临时库 |

构建阶段与运行阶段共用 ubuntu:26.04（同为 glibc），避免 musl/glibc 二进制不兼容问题；Agent 可在运行时自由使用 `npm install` 与 `pip install`。

## 构建镜像

在项目根目录执行：

```bash
docker build -t agent-runtime .
```

## 准备配置

创建一个目录存放配置文件，例如 `./config`：

```bash
mkdir config
cat > config/agents.yaml << 'EOF'
agents:
  - id: "assistant"
    description: "通用助手"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a helpful assistant."
    maxTurns: 10
EOF
```

## 运行容器

```bash
docker run -d \
  --name zerone-agent \
  -p 3000:3000 \
  -v "$(pwd)/config:/app/config" \
  agent-runtime
```

容器会读取 `/app/config` 目录下的 `agents.yaml` 或 `agent.config.ts`。

## 覆盖端口

```bash
docker run -d \
  --name zerone-agent \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  agent-runtime
```

注意：默认命令使用 `--config /app/config`，端口由配置文件或环境变量决定。如需显式指定端口，可覆盖 CMD：

```bash
docker run -d \
  --name zerone-agent \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  agent-runtime node /app/dist/index.js --config /app/config --port 8080
```

## 环境变量

可通过 `-e` 传递 SDK 环境变量：

```bash
docker run -d \
  --name zerone-agent \
  -p 3000:3000 \
  -v "$(pwd)/config:/app/config" \
  -e ZERONE_AGENT_API_KEY=your-api-key \
  -e ZERONE_AGENT_MODEL=claude-sonnet-4-6 \
  agent-runtime
```

常用环境变量：

| 变量 | 说明 |
|---|---|
| `ZERONE_AGENT_API_KEY` | LLM API Key |
| `ZERONE_AGENT_BASE_URL` | API Base URL |
| `ZERONE_AGENT_MODEL` | 默认模型 |
| `ZERONE_AGENT_API_TYPE` | API 类型 |
| `ZERONE_AGENT_HTTP_API_KEY` | HTTP 服务认证 Key |

### Cron persistence

When `cron.enabled: true`, mount the resolved cron data directory
(`<configDir>/<dataRoot>`) — the directory that contains `<dataRoot>/cron/`.
With the image's default `--config /app/config` and the default
`dataRoot: .zerone`, that path is `/app/config/.zerone`:

```bash
docker run -v /host/cron-data:/app/config/.zerone ...
```

Without the volume mount, container recreation loses all cron tasks and
execution history (they live only in the container filesystem under dataRoot).

## 健康检查

Dockerfile 已内置 `HEALTHCHECK`，会每 30 秒访问 `/health` 端点检查服务状态。
