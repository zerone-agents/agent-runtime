# Docker 使用说明

项目已提供 Dockerfile，可将 open-agent-runtime 打包为容器镜像运行。

## 构建镜像

在项目根目录执行：

```bash
docker build -t open-agent-runtime .
```

## 准备配置

创建一个目录存放配置文件，例如 `./config`：

```bash
mkdir config
cat > config/agents.yaml << 'EOF'
agents:
  - id: "assistant"
    model: "claude-sonnet-4-6"
    systemPrompt: "You are a helpful assistant."
    maxTurns: 10
EOF
```

## 运行容器

```bash
docker run -d \
  --name open-agent \
  -p 3000:3000 \
  -v "$(pwd)/config:/app/config" \
  open-agent-runtime
```

容器会读取 `/app/config` 目录下的 `agents.yaml` 或 `agent.config.ts`。

## 覆盖端口

```bash
docker run -d \
  --name open-agent \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  open-agent-runtime
```

注意：默认命令使用 `--config /app/config`，端口由配置文件或环境变量决定。如需显式指定端口，可覆盖 CMD：

```bash
docker run -d \
  --name open-agent \
  -p 8080:8080 \
  -v "$(pwd)/config:/app/config" \
  open-agent-runtime node dist/index.js --config /app/config --port 8080
```

## 环境变量

可通过 `-e` 传递 SDK 环境变量：

```bash
docker run -d \
  --name open-agent \
  -p 3000:3000 \
  -v "$(pwd)/config:/app/config" \
  -e OPENAGENT_API_KEY=your-api-key \
  -e OPENAGENT_MODEL=claude-sonnet-4-6 \
  open-agent-runtime
```

常用环境变量：

| 变量 | 说明 |
|---|---|
| `OPENAGENT_API_KEY` | LLM API Key |
| `OPENAGENT_BASE_URL` | API Base URL |
| `OPENAGENT_MODEL` | 默认模型 |
| `OPENAGENT_API_TYPE` | API 类型 |
| `OPENAGENT_HTTP_API_KEY` | HTTP 服务认证 Key |

## 健康检查

Dockerfile 已内置 `HEALTHCHECK`，会每 30 秒访问 `/health` 端点检查服务状态。
