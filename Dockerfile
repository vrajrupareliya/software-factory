# Stage 1: Build & Prune
FROM node:22-slim AS builder

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable && corepack prepare pnpm@10.33.2 --activate

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm run build
RUN pnpm prune --prod

# Stage 2: Production Runner
FROM node:22-slim AS runner

WORKDIR /app
ENV NODE_ENV=production

# Pre-create output and data directories with proper node ownership
RUN mkdir -p /app/runs /app/bench && chown -R node:node /app

COPY --chown=node:node --from=builder /app/package.json ./
COPY --chown=node:node --from=builder /app/node_modules ./node_modules
COPY --chown=node:node --from=builder /app/dist ./dist
COPY --chown=node:node bench ./bench

USER node

VOLUME ["/app/runs", "/app/bench"]

ENTRYPOINT ["node", "dist/index.js"]
