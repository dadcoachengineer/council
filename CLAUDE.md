# Council — AI/Developer Guide

## Project Overview

Multi-agent MCP orchestrator modeled as a corporate governance board. Single-package TypeScript project with clear internal module boundaries.

## Architecture

```
src/
  engine/    # Pure logic, no HTTP. Orchestrator, voting, escalation, spawner, message bus.
  server/    # HTTP layer. Express 5 routes, MCP server, WebSocket, auth, DB.
  web/       # Preact + Vite frontend. Components in src/web/components/.
  shared/    # Types, Zod schemas, event definitions. Imported by all layers.
```

**Rule**: Engine must never import from server or web. Shared must never import from engine, server, or web.

## Tech Stack

- **Runtime**: Node 22+, TypeScript 5.7+
- **Server**: Express 5
- **Frontend**: Preact + Vite
- **Database**: SQLite via better-sqlite3 + Drizzle ORM
- **MCP**: @modelcontextprotocol/sdk v1.26+
- **Testing**: Vitest
- **Build**: tsup (server) → `dist/server/`, vite (web) → `dist/web/`

## Commands

| Command | Purpose |
|---------|---------|
| `pnpm dev` | Start dev server (tsx watch) |
| `pnpm build` | Build server (tsup) + web (vite) |
| `pnpm start` | Run production build |
| `pnpm test` | Run vitest |
| `npx vitest run` | Run tests once (CI) |
| `npx tsc --noEmit` | Type check without emitting |

## Known Gotchas

### MCP SDK v1.26 Import Paths

```typescript
// CORRECT
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

// WRONG — will fail
import { McpServer } from '@modelcontextprotocol/sdk/server/index.js';
```

Tool registration uses: `server.registerTool(name, {inputSchema: {key: z.schema()}}, handler)`

### Express 5

`req.params.id` returns `string | string[]` — always cast with `String(req.params.id)` for type safety.

## Database

### Schema

Tables defined in `src/server/db.ts` using Drizzle ORM: `councils`, `sessions`, `messages`, `votes`, `decisions`, `events`, `escalation_events`, `users`, `user_sessions`, `agent_tokens`.

### Adding New Columns

1. Add the column to the Drizzle schema definition at the top of `src/server/db.ts`
2. Add the column to the `CREATE TABLE IF NOT EXISTS` SQL in `createDb()`
3. Add a migration entry to the `MIGRATIONS` array in `runMigrations()`:
   ```typescript
   { table: 'table_name', column: 'column_name', type: 'TEXT' }
   ```
4. The migration runs on startup, using `PRAGMA table_info()` to detect missing columns and `ALTER TABLE ADD COLUMN` to add them

### Adding New Tables

Add `CREATE TABLE IF NOT EXISTS` and any indexes in the `sqlite.exec()` block in `createDb()`. No migration entry needed — `CREATE TABLE IF NOT EXISTS` handles it.

## Server Factory

`src/server/index.ts` exports a `createApp()` factory for programmatic use and testing:

```typescript
import { createApp, type CreateAppOptions, type CouncilApp } from '@/server/index.js';

const council = createApp({
  dbPath: '/path/to/db',
  config,                    // Parsed CouncilConfig
  councilId: 'optional-id',  // Auto-generated if omitted
  mcpBaseUrl: 'http://...',
  password: 'optional',
});

// council.app         — Express app
// council.httpServer   — HTTP server (call .listen() yourself)
// council.orchestrator — Orchestrator instance
// council.store        — DbStore instance
// council.userStore    — UserStore instance
// council.councilId    — Resolved council ID
// council.close()      — Shuts down HTTP server + SQLite
```

`createApp()` does NOT call `listen()` — the caller controls the lifecycle. `main()` is guarded by entry-point detection so importing `createApp` from tests won't auto-start the server.

`createDb()` returns `{ db, sqlite }` — the Drizzle client and raw better-sqlite3 instance. `DbClient` type is `ReturnType<typeof drizzle>`.

## Testing

- Test files live in `test/` mirroring `src/` structure (e.g., `test/engine/`, `test/server/`, `test/integration/`)
- Uses `@/` path alias for imports (e.g., `import { runMigrations } from '@/server/db.js'`)
- Vitest config in `vitest.config.ts`
- Use in-memory or temp-dir SQLite databases for DB tests
- Integration tests use `createApp()` with ephemeral ports (`listen(0)`) and temp directories
- 231 tests: unit (engine, shared), server (auth, webhooks, migrations, user-store), and e2e integration

## Configuration

Council YAML config is validated by Zod schemas in `src/shared/schemas.ts`. Types in `src/shared/types.ts`.

Key config sections: `agents`, `rules` (including `voting_scheme`, `escalation`, refinement settings), `event_routing`, `communication_graph`, `spawner`.

### Persistent Agents

Agents can be configured with `persistent: true` in YAML. Persistent agents:
- Receive a stable token (`council_persistent_<agentId>_<random>`) stored in `agent_tokens` table
- Stay connected across multiple sessions — the orchestrator notifies them of new assignments via MCP logging messages instead of re-spawning
- Track active sessions in `AgentRegistry.activeSessions`
- Can poll for assignments using the `council_get_assignments` MCP tool

The `createMcpRouter()` return type is `{ router, notifyAgent }` — the `notifyAgent` callback is wired into the orchestrator via `orchestrator.setNotifyPersistentAgent()`.

### Authentication

Multi-user auth with session cookies and optional TOTP 2FA. Key files:
- `src/server/auth.ts` — cookie-based session auth, `/auth/*` routes, `protect` / `requireAdmin` middleware
- `src/server/user-store.ts` — `UserStore` class for user CRUD, password hashing (bcrypt), TOTP secret management
- `src/server/admin-api.ts` — admin-only user management routes (`/api/admin/users`)

First user created via `POST /auth/setup` becomes admin. Subsequent users are created by admins. The MCP endpoint (`/mcp`) is exempt from auth — agents authenticate via their own token header (`x-agent-token`).

## CI / Docker

- GitHub Actions workflow in `.github/workflows/ci.yml`
- CI runs on push to main and PRs: lint, typecheck, test
- Docker images published to `ghcr.io/dadcoachengineer/council` on push to main and version tags
- Dockerfile at `docker/Dockerfile` (multi-stage: build → deps → production)
- Docker Compose at `docker/docker-compose.yml`
- Container volumes: `/app/data` (SQLite DB), `/app/config` (YAML configs)

## Git Workflow

- **New features**: Create a feature branch, open a PR with `gh pr create`
- **Bugs**: File a GitHub issue with `gh issue create`, reference in fix commit/PR
- Never commit directly to main for features
