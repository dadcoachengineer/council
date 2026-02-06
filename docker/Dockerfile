FROM node:22-slim AS base
RUN corepack enable pnpm

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod=false

# Build
COPY tsconfig.json tsup.config.ts vite.config.ts ./
COPY src/ src/
RUN pnpm build:server && pnpm build:web

# Production image
FROM node:22-slim AS production
RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

COPY --from=base /app/dist/ dist/

# Create data directory for SQLite
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/council.db

EXPOSE 3000

VOLUME ["/app/data", "/app/config"]

CMD ["node", "dist/server/index.js"]
