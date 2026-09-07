# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
# Base image switched from ubuntu:26.04 (manual apt nodejs + npm) to
# node:22-bookworm-slim — official Node 22 + npm 10, glibc (same libc family
# as the production stage: native addons compiled here load at runtime).
# Issue #4: shaves the apt nodejs/libnode layer (~120MB) off both stages.
FROM node:22-bookworm-slim AS builder

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# GitHub Actions runner 位于美国：build 期间一律走官方源（apt/npm），
# 跨太平洋访问国内镜像反而是减速项。国内镜像配置只在 production stage
# 末尾写入镜像，供国内服务器运行时使用。
# python3 is installed in case any dependency needs node-gyp during `npm ci`.
# (Official node:22 images already ship npm 10.x — no global npm upgrade.)
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install all dependencies (incl. dev) for building
COPY package*.json ./
RUN npm ci

# Copy source and build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Prune dev dependencies for production image
RUN npm prune --omit=dev

# -----------------------------------------------------------------------------
# Production stage
# -----------------------------------------------------------------------------
FROM node:22-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

# Runtime: Node.js 22 + Python 3 + pip.
# This image is a general-purpose agent runtime, so agents can `npm install`
# and `pip install` packages on the fly at runtime.
# 安装阶段走官方源（GitHub Actions runner 在美国，官方 apt/npm 最快）；
# 依赖装完后再切国内镜像，供国内服务器运行时使用。
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        python3 \
        python3-pip \
    && rm -rf /var/lib/apt/lists/*

# ca-certificates 已就位，apt 切阿里云镜像（可用 https）。
# Debian bookworm 官方镜像（debuerreotype）的源是 deb822 格式的
# /etc/apt/sources.list.d/debian.sources（URIs: http://deb.debian.org/debian），
# 传统 /etc/apt/sources.list 仅在老式镜像存在，作兜底一并替换。
# 替换规则必须匹配完整 "http://deb.debian.org/debian"（含尾 /debian）：
# 否则 deb822 的 URIs 行会被追加成 .../debian/debian；/debian-security 长串先替换。
# 切源后用 apt-get update 真实验证新源可用——失败即构建失败，杜绝静默失效。
RUN sed -i 's|http://deb.debian.org/debian-security|https://mirrors.aliyun.com/debian-security|g; s|http://deb.debian.org/debian|https://mirrors.aliyun.com/debian|g' \
        /etc/apt/sources.list.d/debian.sources \
        /etc/apt/sources.list 2>/dev/null || true \
    && grep -q 'mirrors.aliyun.com' /etc/apt/sources.list.d/debian.sources \
    && apt-get update \
    && rm -rf /var/lib/apt/lists/*

# bun 的下载（含 bun 平台二进制 optionalDependencies）先走官方 registry——
# GitHub runner 侧快；npmmirror 配置放最后，只影响运行时安装。
# Issue #4 (plan B): npm cache cleaned right after, so the ~/.npm cache
# (~40-80MB) does not land in the image.
RUN npm install -g bun && npm cache clean --force && rm -rf /root/.npm

# Use Alibaba Cloud npm mirror for faster installs in China (runtime only).
RUN npm config set registry https://registry.npmmirror.com

WORKDIR /workdir

# Use Alibaba Cloud PyPI mirror for faster Python package installs.
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/

# Configure Bun to use the npmmirror registry globally so agents' `bun install`
# / `bun add` at runtime resolve from the domestic mirror. Bun reads ~/.bunfig.toml.
RUN printf '[install]\nregistry = "https://registry.npmmirror.com"\n' > /root/.bunfig.toml

# Copy production dependencies and built artifacts from builder
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/dist /app/dist
COPY --from=builder /app/package.json /app/package.json

# Expose the default port
EXPOSE 3000

# Health check (uses Node's built-in fetch, no curl dependency)
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/health').then(r => r.ok ? process.exit(0) : process.exit(1)).catch(() => process.exit(1))"

# Default command
# Users should mount their config directory to /app/config
CMD ["node", "/app/dist/index.js", "--config", "/app/config"]