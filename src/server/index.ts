import { createServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { nanoid } from 'nanoid';

import { loadConfigFile, parseConfig } from '../engine/config-loader.js';
import { OrchestratorRegistry } from '../engine/orchestrator-registry.js';
import type { OrchestratorEntry } from '../engine/orchestrator-registry.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { createDb, DbStore } from './db.js';
import { UserStore } from './user-store.js';
import { createMcpRouter } from './mcp-server.js';
import { createUserMcpRouter } from './mcp-user-server.js';
import { createWebhookRouter } from './webhooks.js';
import { createApiRouter } from './api.js';
import { createAdminRouter } from './admin-api.js';
import { setupWebSocket } from './ws.js';
import { createAuth } from './auth.js';
import type { CouncilConfig } from '../shared/types.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './data/council.db';
const CONFIG_PATH = process.env.CONFIG_PATH;
const MULTI_CONFIG_DIR = process.env.MULTI_CONFIG_DIR;
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? `http://localhost:${PORT}/mcp`;

// ── createApp factory ──

export interface CreateAppOptions {
  dbPath: string;
  /** Single config — wrapped into a single-entry registry. */
  config?: CouncilConfig;
  /** Multiple configs — each gets its own orchestrator. */
  configs?: Array<{ councilId?: string; config: CouncilConfig }>;
  councilId?: string;
  mcpBaseUrl?: string;
}

export interface CouncilApp {
  app: Express;
  httpServer: HttpServer;
  /** Default orchestrator (first registered). For backward compat. */
  orchestrator: Orchestrator;
  registry: OrchestratorRegistry;
  store: DbStore;
  userStore: UserStore;
  /** Default council ID. */
  councilId: string;
  close: () => Promise<void>;
}

export function createApp(opts: CreateAppOptions): CouncilApp {
  const { db, sqlite } = createDb(opts.dbPath);
  const store = new DbStore(db);
  const userStore = new UserStore(db);
  const mcpBaseUrl = opts.mcpBaseUrl ?? 'http://localhost:3000/mcp';

  const registry = new OrchestratorRegistry();

  // Build the list of configs to register
  let configEntries: Array<{ councilId: string; config: CouncilConfig }>;

  if (opts.configs && opts.configs.length > 0) {
    configEntries = opts.configs.map(c => ({
      councilId: c.councilId ?? nanoid(),
      config: c.config,
    }));
  } else if (opts.config) {
    configEntries = [{ councilId: opts.councilId ?? nanoid(), config: opts.config }];
  } else {
    throw new Error('createApp requires either config or configs option');
  }

  // Create orchestrators for each config
  for (const { councilId, config } of configEntries) {
    // Persist council in DB
    if (!store.getCouncil(councilId)) {
      store.saveCouncil({
        id: councilId,
        name: config.council.name,
        description: config.council.description,
        config,
        createdAt: new Date().toISOString(),
      });
    }

    registry.create(councilId, config, store, mcpBaseUrl);
  }

  // ── Express ──
  const app = express();

  // Webhook routes get a JSON parser that captures raw bytes for HMAC verification
  app.use('/webhooks', express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }), createWebhookRouter(registry));

  // All other routes use standard JSON parser
  app.use(express.json({ limit: '1mb' }));

  // User MCP endpoint (Bearer API key auth)
  const { router: userMcpRouter } = createUserMcpRouter(registry, userStore);
  app.use('/mcp/user', userMcpRouter);

  // Agent MCP endpoint (no auth — agents use their own token-based auth)
  const { router: mcpRouter, notifyAgent } = createMcpRouter(registry);
  app.use('/mcp', mcpRouter);

  // Wire persistent agent notification callback and load tokens for all councils
  for (const { councilId, entry } of registry.list()) {
    entry.orchestrator.setNotifyPersistentAgent(notifyAgent);

    // Load persistent tokens from DB
    const persistentTokens = store.listPersistentTokens(councilId);
    for (const { agentId, token } of persistentTokens) {
      entry.agentRegistry.setPersistentToken(agentId, token);
    }
  }

  // ── Auth ──
  const auth = createAuth(userStore);

  // Global authenticate middleware (non-blocking — sets req.user)
  app.use(auth.authenticate);

  // Auth routes
  app.use('/auth', auth.router);

  // Health endpoint — always public
  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
  });

  // Admin routes (require admin role)
  app.use('/api/admin', auth.protect, auth.requireAdmin, createAdminRouter(userStore, store, registry));

  // ── HTTP + WebSocket ──
  const httpServer = createServer(app);
  const { addCouncil: wsAddCouncil } = setupWebSocket(httpServer, registry);

  // REST API (protected) — with callbacks for dynamic council management
  const apiRouter = createApiRouter(registry, store, {
    onCouncilCreated: (councilId: string, entry: OrchestratorEntry) => {
      // Wire persistent agent notification
      entry.orchestrator.setNotifyPersistentAgent(notifyAgent);

      // Load persistent tokens
      const tokens = store.listPersistentTokens(councilId);
      for (const { agentId, token } of tokens) {
        entry.agentRegistry.setPersistentToken(agentId, token);
      }

      // Subscribe WebSocket to new council
      wsAddCouncil(councilId, entry.orchestrator);
    },
  });

  app.use('/api', auth.protect, apiRouter);

  const defaultId = registry.getDefaultId()!;
  const defaultEntry = registry.getDefault()!;

  const close = (): Promise<void> => {
    return new Promise((resolvePromise, reject) => {
      httpServer.close((err) => {
        sqlite.close();
        if (err) reject(err);
        else resolvePromise();
      });
    });
  };

  return {
    app,
    httpServer,
    orchestrator: defaultEntry.orchestrator,
    registry,
    store,
    userStore,
    councilId: defaultId,
    close,
  };
}

// ── main ──

async function main() {
  console.log('[COUNCIL] Starting Council server...');

  // ── Database directory ──
  const dbDir = resolve(DB_PATH, '..');
  if (!existsSync(dbDir)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbDir, { recursive: true });
  }

  // ── Config ──
  let configs: Array<{ councilId?: string; config: CouncilConfig }> = [];

  if (MULTI_CONFIG_DIR) {
    // Load all YAML files from the directory
    if (!existsSync(MULTI_CONFIG_DIR)) {
      console.error(`[COUNCIL] MULTI_CONFIG_DIR not found: ${MULTI_CONFIG_DIR}`);
      process.exit(1);
    }

    const yamlFiles = readdirSync(MULTI_CONFIG_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();

    if (yamlFiles.length === 0) {
      console.error(`[COUNCIL] No YAML files found in ${MULTI_CONFIG_DIR}`);
      process.exit(1);
    }

    // Pre-scan for existing councils to reuse IDs
    const { db: tmpDb, sqlite: sqliteTemp } = createDb(DB_PATH);
    const tmpStore = new DbStore(tmpDb);
    const existingCouncils = tmpStore.listCouncils();
    sqliteTemp.close();

    for (const file of yamlFiles) {
      const filePath = resolve(MULTI_CONFIG_DIR, file);
      const config = loadConfigFile(filePath);
      const match = existingCouncils.find(c => c.name === config.council.name);
      configs.push({
        councilId: match?.id,
        config,
      });
      console.log(`[COUNCIL] Loaded config: "${config.council.name}" from ${file}${match ? ` (existing: ${match.id})` : ''}`);
    }
  } else if (CONFIG_PATH) {
    const config = loadConfigFile(CONFIG_PATH);
    console.log(`[COUNCIL] Loaded config from ${CONFIG_PATH}: "${config.council.name}"`);

    // Check if this council already exists (by name) so we reuse its ID
    const { db: tmpDb, sqlite: sqliteTemp } = createDb(DB_PATH);
    const tmpStore = new DbStore(tmpDb);
    const existing = tmpStore.listCouncils();
    const match = existing.find((c) => c.name === config.council.name);
    sqliteTemp.close();

    configs.push({
      councilId: match?.id,
      config,
    });

    if (match) {
      console.log(`[COUNCIL] Using existing council: ${match.id}`);
    }
  } else {
    // Default minimal config for development
    const defaultYaml = `
version: "1"
council:
  name: "Development Council"
  description: "Default development council"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
  agents:
    - id: dev
      name: "Dev Agent"
      role: "Developer"
      system_prompt: "You are a development agent."
  event_routing: []
`;
    configs.push({ config: parseConfig(defaultYaml) });
    console.log('[COUNCIL] Using default development config');
  }

  const council = createApp({
    dbPath: DB_PATH,
    configs,
    mcpBaseUrl: MCP_BASE_URL,
  });

  console.log(`[COUNCIL] Default council: ${council.councilId}`);
  console.log(`[COUNCIL] Total councils: ${council.registry.size}`);
  for (const { councilId, entry } of council.registry.list()) {
    console.log(`[COUNCIL]   ${councilId}: "${entry.config.council.name}" (${entry.config.council.agents.length} agents)`);
  }

  // Serve web UI static files (production) — only in main(), not in createApp()
  const webDistPath = resolve(import.meta.dirname ?? '.', '../../dist/web');
  if (existsSync(webDistPath)) {
    council.app.use(express.static(webDistPath));
    // SPA fallback
    council.app.get('{*path}', (_req, res) => {
      res.sendFile(resolve(webDistPath, 'index.html'));
    });
    console.log(`[COUNCIL] Serving web UI from ${webDistPath}`);
  }

  council.httpServer.listen(PORT, HOST, () => {
    console.log(`[COUNCIL] Server listening on http://${HOST}:${PORT}`);
    console.log(`[COUNCIL] MCP endpoint (agents): http://${HOST}:${PORT}/mcp`);
    console.log(`[COUNCIL] MCP endpoint (users): http://${HOST}:${PORT}/mcp/user`);
    console.log(`[COUNCIL] Webhooks: http://${HOST}:${PORT}/webhooks/github, /webhooks/ingest`);
    console.log(`[COUNCIL] REST API: http://${HOST}:${PORT}/api`);
    console.log(`[COUNCIL] WebSocket: ws://${HOST}:${PORT}/ws`);
  });
}

// Only run main() when this file is the entry point (not when imported by tests)
const isEntryPoint =
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1]?.endsWith('/dist/server/index.js');

if (isEntryPoint) {
  main().catch((err) => {
    console.error('[COUNCIL] Fatal error:', err);
    process.exit(1);
  });
}
