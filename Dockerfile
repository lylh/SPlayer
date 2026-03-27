# build
FROM node:22-alpine AS builder

# install pnpm
RUN npm install -g pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./

# skip postinstall
RUN pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# add .env.example to .env
RUN [ ! -e ".env" ] && cp .env.example .env || true

# skip native build for web deployment
ENV SKIP_NATIVE_BUILD=true
RUN npx electron-vite build

# 将独立服务入口打包为单个自包含 CJS 文件（不依赖 Electron 运行时）
# pnpm --ignore-scripts 未安装 esbuild 平台二进制，用 npm 单独装到临时目录后打包
RUN npm install --prefix /tmp/esbuild-bin esbuild \
    && /tmp/esbuild-bin/node_modules/.bin/esbuild \
      electron/server/standalone-server.ts \
      --bundle \
      --platform=node \
      --target=node22 \
      --format=cjs \
      --outfile=out/standalone-server.js

# nginx
FROM nginx:1.27-alpine-slim AS app

COPY --from=builder /app/out/renderer /usr/share/nginx/html

COPY --from=builder /app/out/standalone-server.js /app/standalone-server.js

COPY --from=builder /app/nginx.conf /etc/nginx/conf.d/default.conf

COPY --from=builder /app/docker-entrypoint.sh /docker-entrypoint.sh

RUN apk add --no-cache nodejs npm python3 \
    && npm install -g @unblockneteasemusic/server @neteasecloudmusicapienhanced/api \
    && sed -i 's/\r$//' /docker-entrypoint.sh \
    && chmod +x /docker-entrypoint.sh

ENV NODE_TLS_REJECT_UNAUTHORIZED=0

ENTRYPOINT ["/docker-entrypoint.sh"]

CMD ["npx", "@neteasecloudmusicapienhanced/api"]