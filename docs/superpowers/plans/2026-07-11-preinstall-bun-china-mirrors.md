# Dockerfile 预装 Bun + apt/Bun 国内源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 production 镜像预装 Bun 运行时，并把 apt 源（builder + production 两阶段）和 Bun 包源统一切到阿里云国内镜像。

**Architecture:** 仅改 `Dockerfile` 单文件、共 4 处插入。apt 源用 `sed` 原地替换 host（保留 http scheme 避免 CA bootstrap 死锁）；Bun 用 `npm install -g bun` 复用已配好的 npmmirror；Bun 运行时包源用 `/root/.bunfig.toml` 全局配置。

**Tech Stack:** Docker multi-stage build, ubuntu:26.04 base (deb822 apt sources), npm, Bun。

## Global Constraints

- **只改** `Dockerfile` 一个文件，不新增文件、不动 package.json、不动配置层
- apt 镜像统一 `mirrors.aliyun.com`，npm/Bun 包源统一 `registry.npmmirror.com`（与现有配置一致）
- apt sed **保留 `http` scheme**（base 镜像未必带 ca-certificates，走 https 会导致首个 apt-get update 失败）
- sed 必须同时覆盖 `/etc/apt/sources.list.d/ubuntu.sources`（deb822）和 `/etc/apt/sources.list`（classic），缺失文件用 `2>/dev/null || true` 容忍
- Bun 只装 production 阶段，builder 不装
- Bun 版本不锁，装 latest
- 无传统单元测试可写（infra 改动）——验证手段是 `docker build` 成功 + `docker run` 烟测命令
- 提交信息用 `feat(docker): ...` 前缀（与最近 docker 相关提交 `9a67abe feat(docker): ...` 一致）

---

## File Structure

| 文件 | 操作 | 责任 |
|---|---|---|
| `Dockerfile` | Modify | 4 处插入：builder apt sed、production apt sed、production Bun 安装、production bunfig.toml |

无新增文件。

---

### Task 1: apt 源切阿里云（builder + production 两阶段）

**Files:**
- Modify: `Dockerfile`（builder 阶段在 line 15 的 `RUN apt-get update` 前插入；production 阶段在 line 53 的 `RUN apt-get update` 前插入）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: builder 和 production 两阶段的 apt 包全部从 `mirrors.aliyun.com` 拉取，后续 Task 2 的 `npm install -g bun` 间接受益（builder stage 仍是 npmmirror，不变）

- [ ] **Step 1: 在 builder 阶段插入 apt 源 sed**

在 `Dockerfile` 的 builder 阶段，`ENV DEBIAN_FRONTEND=noninteractive`（line 11）之后、`RUN apt-get update ...`（line 15）之前，插入一条 sed。用 Edit 工具，`old_string` 取 builder 注释块到 apt-get 的衔接处：

old_string:
```
# Node.js 22.22.1 + npm 9.2.0 from Ubuntu repo; npm upgraded to 10.x below.
# python3 is installed in case any dependency needs node-gyp during `npm ci`.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        python3 \
    && rm -rf /var/lib/apt/lists*
```

new_string:
```
# Node.js 22.22.1 + npm 9.2.0 from Ubuntu repo; npm upgraded to 10.x below.
# python3 is installed in case any dependency needs node-gyp during `npm ci`.
# Switch apt to Alibaba Cloud mirror (http scheme: ca-certificates not yet installed).
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        python3 \
    && rm -rf /var/lib/apt/lists/*
```

- [ ] **Step 2: 在 production 阶段插入 apt 源 sed**

在 production 阶段的注释块之后、其 `RUN apt-get update`（line 53）之前插入同样的 sed。注意 production 的注释文本与 builder 不同（`# Runtime: Node.js 22 ...`），用于唯一定位。

old_string:
```
# Runtime: Node.js 22 + Python 3 + pip.
# This image is a general-purpose agent runtime, so agents can `npm install`
# and `pip install` packages on the fly at runtime.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists*
```

new_string:
```
# Runtime: Node.js 22 + Python 3 + pip.
# This image is a general-purpose agent runtime, so agents can `npm install`
# and `pip install` packages on the fly at runtime.
# Switch apt to Alibaba Cloud mirror (http scheme: ca-certificates not yet installed).
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list 2>/dev/null || true

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists*
```

- [ ] **Step 3: 构建镜像，确认 apt 走阿里云**

Run: `docker build -t oar-test:apt-mirror .`
Expected: 构建成功。构建日志中两处 `apt-get update` 的 `Get:` 行 host 均为 `mirrors.aliyun.com`（而非 `archive.ubuntu.com`）。

若构建日志不便肉眼检查，改用：
Run: `docker build --no-cache --progress=plain -t oar-test:apt-mirror . 2>&1 | grep -E "Get:[0-9]+ +http"`
Expected: 输出全部含 `mirrors.aliyun.com`，无 `archive.ubuntu.com` 或 `security.ubuntu.com`。

- [ ] **Step 4: 烟测 production 阶段 apt 源持久化**

Run: `docker run --rm oar-test:apt-mirror sh -c "apt-get update 2>&1 | head -8"`
Expected: 输出含 `Get:1 http://mirrors.aliyun.com ...`，证明源已固化进镜像（不是只对构建期生效）。

- [ ] **Step 5: 提交**

```bash
git add Dockerfile
git commit -m "feat(docker): switch apt sources to Alibaba Cloud mirror"
```

---

### Task 2: 预装 Bun + 配置 Bun 国内包源（production 阶段）

**Files:**
- Modify: `Dockerfile`（production 阶段：在 `npm install -g npm@10` 后加 Bun 安装；在 `pip config set` 后加 bunfig.toml）

**Interfaces:**
- Consumes: Task 1 的 production apt 源已切阿里云（使本任务构建更快，但非功能依赖）
- Produces: 镜像内 `/usr/bin/bun` 可用；`/root/.bunfig.toml` 让 agent 运行时 `bun install` 走 npmmirror

- [ ] **Step 1: 在 production 阶段加 Bun 安装**

在 production 阶段的 `RUN npm install -g npm@10`（line 66）之后插入 Bun 安装。`npm install -g npm@10` 这条在 builder 和 production 都出现，需用更长的上下文唯一定位 production 那条（其后紧跟 `WORKDIR /workdir`）。

old_string:
```
# Upgrade npm to v10 to match builder.
RUN npm install -g npm@10

WORKDIR /workdir
```

new_string:
```
# Upgrade npm to v10 to match builder.
RUN npm install -g npm@10

# Preinstall Bun for agents that use it at runtime.
# Reuses the npmmirror registry configured above, so the bun package and its
# platform-specific binary optionalDependencies all download domestically.
RUN npm install -g bun

WORKDIR /workdir
```

- [ ] **Step 2: 在 production 阶段加 bunfig.toml（Bun 运行时包源）**

在 production 阶段的 pip 配置（line 71）之后插入 bunfig.toml 写入。

old_string:
```
# Use Alibaba Cloud PyPI mirror for faster Python package installs.
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/
```

new_string:
```
# Use Alibaba Cloud PyPI mirror for faster Python package installs.
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/

# Configure Bun to use the npmmirror registry globally so agents' `bun install`
# / `bun add` at runtime resolve from the domestic mirror. Bun reads ~/.bunfig.toml.
RUN printf '[install]\nregistry = "https://registry.npmmirror.com"\n' > /root/.bunfig.toml
```

- [ ] **Step 3: 重新构建镜像**

Run: `docker build -t oar-test:bun .`
Expected: 构建成功，production 阶段能看到 `npm install -g bun` 从 npmmirror 拉取。

- [ ] **Step 4: 烟测 bun 可用**

Run: `docker run --rm oar-test:bun bun --version`
Expected: 输出 Bun 版本号（如 `1.2.x`），退出码 0。

- [ ] **Step 5: 烟测 bunfig.toml 内容**

Run: `docker run --rm oar-test:bun cat /root/.bunfig.toml`
Expected 输出（逐字）：
```
[install]
registry = "https://registry.npmmirror.com"
```

- [ ] **Step 6: 烟测 bun install 走 npmmirror**

Run: `docker run --rm oar-test:bun sh -c "cd /tmp && bun add cowsay 2>&1 | grep -i npmmirror | head -2"`
Expected: 至少一行含 `npmmirror.com`，证明 bunfig 生效、解析走国内源。

（若 grep 无输出，回退用 `bun add cowsay 2>&1 | tail -5` 肉眼确认无海外 URL 错误。）

- [ ] **Step 7: 回归 — node 启动行为不变**

Run: `docker run --rm oar-test:bun node -e "fetch('http://localhost:3000/health').then(r=>console.log(r.status)).catch(e=>console.log('no server', e.message))"`
Expected: 输出 `no server ...`（容器内无配置起不了服务，这正常）——关键是 node 本身可执行、fetch 可用，证明 npm/node 路径未受影响。

- [ ] **Step 8: 提交**

```bash
git add Dockerfile
git commit -m "feat(docker): preinstall Bun and point its registry at npmmirror"
```

---

## Self-Review

**Spec coverage 核对：**
- spec §1「apt 源换阿里云（两阶段）」→ Task 1 Step 1+2 ✓
- spec §2「安装 Bun（仅 production）」→ Task 2 Step 1 ✓
- spec §3「Bun 运行时源 bunfig.toml」→ Task 2 Step 2 ✓
- spec「保留 http scheme」→ Global Constraints + Task 1 注释 ✓
- spec「不锁版本」→ Task 2 用 `bun` 不带版本号 ✓
- spec「不改 npm/pip」→ 两 Task 均未触及 ✓

**Placeholder 扫描：** 无 TBD/TODO，所有 Edit 都给了精确 old_string/new_string，所有验证给了具体命令与期望输出。

**一致性：** sed 表达式在 Task 1 两处完全一致；bunfig.toml 内容与 spec §3 逐字一致（`[install]\nregistry = "https://registry.npmmirror.com"\n`）；镜像 tag 命名 `oar-test:<feature>` 统一。

无问题，计划可执行。
