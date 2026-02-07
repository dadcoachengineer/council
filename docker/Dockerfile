# ── Build stage: full node image has build tools for native modules ──
FROM node:22 AS build
RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY tsconfig.json tsup.config.ts vite.config.ts ./
COPY src/ src/
RUN pnpm build:server && pnpm build:web

# ── Production dependencies: rebuild native modules in slim image ──
FROM node:22-slim AS deps
RUN apt-get update && apt-get install -y python3 make g++ && rm -rf /var/lib/apt/lists/*
RUN corepack enable pnpm

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# ── Production image ──
FROM node:22-slim AS production

WORKDIR /app

COPY --from=deps /app/node_modules/ node_modules/
COPY --from=build /app/dist/ dist/
COPY package.json ./

RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DB_PATH=/app/data/council.db

EXPOSE 3000

VOLUME ["/app/data", "/app/config"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3000/api/health').then(r=>{if(!r.ok)throw 1}).catch(()=>process.exit(1))"

CMD ["node", "dist/server/index.js"]
