# Dockerfile 预装 Bun + apt/Bun 国内源

**Date**: 2026-07-11
**Status**: Approved, ready for implementation plan
**Topic**: 在 production 镜像预装 Bun 运行时，并把 apt 源（builder + production 两阶段）和 Bun 包源统一切到阿里云国内镜像

## 背景与动机

当前 `Dockerfile` 已经把 npm（`registry.npmmirror.com`）和 pip（`mirrors.aliyun.com/pypi/simple/`）切到了国内镜像，但还有两处缺口：

1. **apt 源仍是默认 Ubuntu archive**（`archive.ubuntu.com` / `security.ubuntu.com`）。builder 和 production 两阶段的 `apt-get install` 都从海外拉包，国内构建慢、偶发超时。
2. **没有 Bun**。这个 runtime 定位是通用 agent 运行时——agent 在运行时可能用 Bun 跑脚本、装包。目前 agent 想 `bun install` 会直接失败（系统里没有 bun），且即便装上，Bun 默认走 npm 官方源也是海外。

## 目标

1. **apt 源换阿里云**：builder 和 production 两阶段的 `apt-get` 全部走 `mirrors.aliyun.com`。
2. **预装 Bun**（仅 production 阶段）：`bun` 命令开箱即用。
3. **Bun 包源切国内**：agent 运行时执行 `bun install` / `bun add` 自动走 `registry.npmmirror.com`。

## 非目标

- **不锁** Bun 具体版本（装 `latest`，跟随上游滚动）
- **不参数化**镜像选择（不加 `--build-arg APT_MIRROR=...`，纯国内场景 YAGNI）
- **不**在 builder 阶段装 Bun（构建流程不依赖 Bun）
- **不**改 npm / pip 镜像配置（已是阿里云/npmmirror）
- **不**新增运行时依赖或配置文件层（仅改 Dockerfile 单文件）

## 设计

### 决策汇总

| 决策点 | 选择 | 理由 |
|---|---|---|
| apt 源替换方式 | `sed` 原地替换 host | 自动适配 codename 与 deb822/classic 两种格式，最少硬编码 |
| apt 镜像 | `mirrors.aliyun.com` | 与现有 npm/pip 镜像统一 |
| apt scheme | 保留 `http` | 避免 base 镜像未带 ca-certificates 时走 https 的 bootstrap 死锁 |
| Bun 安装方式 | `npm install -g bun` | 复用已配好的 npmmirror，平台二进制 optionalDependencies 全程国内下载 |
| Bun 版本策略 | `latest`（不锁） | 跟随上游，与现有 node/npm 不锁补丁版本的风格一致 |
| Bun 阶段 | 仅 production | builder 不需要 Bun |
| Bun 运行时源 | `/root/.bunfig.toml` 配 registry | Bun 读 `~/.bunfig.toml`，容器以 root 运行 |

### 1. apt 源换阿里云（builder + production 两阶段）

在**每个阶段的首个 `apt-get update` 之前**插入一条 `sed`：

```dockerfile
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g' \
        /etc/apt/sources.list.d/ubuntu.sources /etc/apt/sources.list 2>/dev/null || true
```

**要点**：

- **保留 `http` scheme**：base 镜像（`ubuntu:26.04`）未必预装 `ca-certificates`，而它是 apt 包列表里才装的。若先把源切成 https，首个 `apt-get update` 会因无法校验 TLS 证书而失败——经典的 chicken-and-egg。保留 http 绕开此问题，阿里云 http 镜像完全可用。
- **只替换 host，不改 path/codename**：deb822（26.04 默认）里 `URIs: http://archive.ubuntu.com/ubuntu/` 变成 `http://mirrors.aliyun.com/ubuntu/`，`Suites: resilient ...` 原样保留，无需硬编码 codename。
- **同时覆盖两种格式**：`ubuntu.sources`（deb822）和 `sources.list`（classic）都传入 sed。ubuntu:26.04 实际只有前者，`/etc/apt/sources.list` 不存在时 `2>/dev/null || true` 容忍缺失。
- **`|| true` 的语义边界**：只容忍"目标文件不存在"，sed 自身若有语法错也会被吞掉——对受控的固定 sed 表达式可接受。

### 2. 安装 Bun（仅 production 阶段）

紧跟现有 `npm install -g npm@10` 之后加一行：

```dockerfile
RUN npm install -g bun
```

**要点**：

- 此时 npm registry 已在前面设为 `registry.npmmirror.com`，`bun` 这个 npm 包及其平台二进制 optionalDependencies（如 `bun-linux-x64`）全部从 npmmirror 解析下载，**全程国内、无需任何额外镜像配置**。
- 安装后 `bun` 落在系统 npm 的全局 bin 目录（Ubuntu 系统 npm 即 `/usr/bin/bun`），已在默认 PATH 上，agent 直接 `bun --version` 可用。
- 不设 `BUN_INSTALL` 或 `~/.bun` 目录——`npm install -g` 路径不依赖 Bun 自身的 install script 布局。

### 3. Bun 运行时源（让 agent 的 bun install 走国内）

production 阶段，pip 镜像配置之后加一条：

```dockerfile
RUN printf '[install]\nregistry = "https://registry.npmmirror.com"\n' > /root/.bunfig.toml
```

**要点**：

- Bun 查找配置的顺序是：当前目录 → 逐级父目录 → `$BUN_CONFIG` → `~/.bunfig.toml`。容器以 root 运行，写 `/root/.bunfig.toml` 即作为全局默认，覆盖 agent 在任意 cwd 下发起的 `bun install` / `bun add`。
- 这里走 **https** npmmirror 没问题——此时 ca-certificates 已装，且这是 Bun 连 npm registry（不是 apt）。
- 注意 Bun 的 bunfig 语法是 `[install]` 表下的 `registry` 键，与 npm 的 `.npmrc` 是两套配置，互不影响。

## 改动范围

仅 `Dockerfile` 单文件，共 4 处插入（builder 阶段 1 处 sed；production 阶段 1 处 sed + 1 处 npm install bun + 1 处 bunfig.toml）。无新增文件、无 package.json 变化、无配置层调整。

## 验证

构建后验证（手动 / CI）：

1. **apt 走阿里云**：构建日志里 `apt-get update` 的 `Get:1 http://mirrors.aliyun.com ...` 而非 `archive.ubuntu.com`。
2. **bun 可用**：`docker run <image> bun --version` 输出版本号。
3. **bunfig 生效**：`docker run <image> cat /root/.bunfig.toml` 含 npmmirror registry；`docker run <image> sh -c 'cd /tmp && bun add cowsay'` 的解析请求走 npmmirror（可在日志或 `bun install --verbose` 里确认）。
4. **回归**：现有 `npm` / `pip` / node 启动行为不变，`/health` 健康检查通过。
