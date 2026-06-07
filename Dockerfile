FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY dist/ ./dist/
COPY agents.yaml runtime.yaml ./

EXPOSE 3000

CMD ["node", "dist/index.js"]
