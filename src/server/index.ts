import { createServer, type Server as HttpServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import { nanoid } from 'nanoid';

import { loadConfigFile, parseConfig } from '../engine/config-loader.js';
import { EventRouter } from '../engine/event-router.js';
import { MessageBus } from '../engine/message-bus.js';
import { AgentRegistry } from '../engine/agent-registry.js';
import { createSpawner } from '../engine/spawner.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { EscalationEngine } from '../engine/escalation-engine.js';
import { createDb, DbStore } from './db.js';
import { UserStore } from './user-store.js';
import { createMcpRouter } from './mcp-server.js';
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
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? `http://localhost:${PORT}/mcp`;

// ── createApp factory ──

export interface CreateAppOptions {
  dbPath: string;
  config: CouncilConfig;
  councilId?: string;
  mcpBaseUrl?: string;
}

export interface CouncilApp {
  app: Express;
  httpServer: HttpServer;
  orchestrator: Orchestrator;
  store: DbStore;
  userStore: UserStore;
  councilId: string;
  close: () => Promise<void>;
}

export function createApp(opts: CreateAppOptions): CouncilApp {
  const { db, sqlite } = createDb(opts.dbPath);
  const store = new DbStore(db);
  const userStore = new UserStore(db);
  const config = opts.config;
  const councilId = opts.councilId ?? nanoid();
  const mcpBaseUrl = opts.mcpBaseUrl ?? 'http://localhost:3000/mcp';

  // Persist council
  if (!store.getCouncil(councilId)) {
    store.saveCouncil({
      id: councilId,
      name: config.council.name,
      description: config.council.description,
      config,
      createdAt: new Date().toISOString(),
    });
  }

  // ── Engine ──
  const eventRouter = new EventRouter(config.council.event_routing);
  const messageBus = new MessageBus(config.council.communication_graph);
  const agentRegistry = new AgentRegistry();
  agentRegistry.loadAgents(config.council.agents);
  const spawner = createSpawner(config.council.spawner, agentRegistry);

  const orchestrator = new Orchestrator({
    config,
    councilId,
    eventRouter,
    messageBus,
    agentRegistry,
    spawner,
    store,
    mcpBaseUrl,
  });

  // ── Escalation Engine ──
  if (config.council.rules.escalation.length > 0) {
    const escalationEngine = new EscalationEngine(config, orchestrator);
    orchestrator.setEscalationEngine(escalationEngine);
    escalationEngine.start();
  }

  // ── Express ──
  const app = express();

  // Webhook routes get a JSON parser that captures raw bytes for HMAC verification
  app.use('/webhooks', express.json({
    limit: '1mb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }), createWebhookRouter(orchestrator, config.council.github));

  // All other routes use standard JSON parser
  app.use(express.json({ limit: '1mb' }));

  // MCP endpoint (no auth — agents use their own token-based auth)
  app.use('/mcp', createMcpRouter(orchestrator));

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
  app.use('/api/admin', auth.protect, auth.requireAdmin, createAdminRouter(userStore));

  // REST API (protected)
  app.use('/api', auth.protect, createApiRouter(orchestrator, store));

  // ── HTTP + WebSocket ──
  const httpServer = createServer(app);
  setupWebSocket(httpServer, orchestrator);

  const close = (): Promise<void> => {
    return new Promise((resolvePromise, reject) => {
      httpServer.close((err) => {
        sqlite.close();
        if (err) reject(err);
        else resolvePromise();
      });
    });
  };

  return { app, httpServer, orchestrator, store, userStore, councilId, close };
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
  let config: CouncilConfig;
  let councilId: string | undefined;

  if (CONFIG_PATH) {
    config = loadConfigFile(CONFIG_PATH);
    console.log(`[COUNCIL] Loaded config from ${CONFIG_PATH}: "${config.council.name}"`);

    // Check if this council already exists (by name) so we reuse its ID
    const { db, sqlite: sqliteTemp } = createDb(DB_PATH);
    const tmpStore = new DbStore(db);
    const existing = tmpStore.listCouncils();
    const match = existing.find((c) => c.name === config.council.name);
    if (match) {
      councilId = match.id;
      console.log(`[COUNCIL] Using existing council: ${councilId}`);
    }
    sqliteTemp.close();
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
    config = parseConfig(defaultYaml);
    console.log('[COUNCIL] Using default development config');
  }

  const council = createApp({
    dbPath: DB_PATH,
    config,
    councilId,
    mcpBaseUrl: MCP_BASE_URL,
  });

  console.log(`[COUNCIL] Council: ${council.councilId}`);
  console.log(`[COUNCIL] Orchestrator initialized with ${config.council.agents.length} agent(s)`);

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
    console.log(`[COUNCIL] MCP endpoint: http://${HOST}:${PORT}/mcp`);
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
