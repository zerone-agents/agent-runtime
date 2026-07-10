# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Build stage
# -----------------------------------------------------------------------------
# Base image switched from node:22-alpine (musl) to ubuntu:26.04 (glibc).
# Builder and production stages MUST share the same libc family, otherwise
# native addons compiled in builder (musl) won't load at runtime (glibc).
FROM ubuntu:26.04 AS builder

ENV DEBIAN_FRONTEND=noninteractive

# Node.js 22.22.1 + npm 9.2.0 from Ubuntu repo; npm upgraded to 10.x below.
# python3 is installed in case any dependency needs node-gyp during `npm ci`.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        nodejs \
        npm \
        python3 \
    && rm -rf /var/lib/apt/lists/*

# Use Alibaba Cloud npm mirror for faster installs in China.
RUN npm config set registry https://registry.npmmirror.com

# Upgrade npm to v10 to match the previous node:22-alpine baseline.
RUN npm install -g npm@10

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
FROM ubuntu:26.04

ENV DEBIAN_FRONTEND=noninteractive

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
    && rm -rf /var/lib/apt/lists/*

# Use Alibaba Cloud npm mirror for faster installs in China.
RUN npm config set registry https://registry.npmmirror.com

# Upgrade npm to v10 to match builder.
RUN npm install -g npm@10

WORKDIR /workdir

# Use Alibaba Cloud PyPI mirror for faster Python package installs.
RUN pip config set global.index-url https://mirrors.aliyun.com/pypi/simple/

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
