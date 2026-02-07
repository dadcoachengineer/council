import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import express from 'express';
import { nanoid } from 'nanoid';

import { loadConfigFile, parseConfig } from '../engine/config-loader.js';
import { EventRouter } from '../engine/event-router.js';
import { MessageBus } from '../engine/message-bus.js';
import { AgentRegistry } from '../engine/agent-registry.js';
import { createSpawner } from '../engine/spawner.js';
import { Orchestrator } from '../engine/orchestrator.js';
import { createDb, DbStore } from './db.js';
import { createMcpRouter } from './mcp-server.js';
import { createWebhookRouter } from './webhooks.js';
import { createApiRouter } from './api.js';
import { setupWebSocket } from './ws.js';
import { createAuth } from './auth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DB_PATH = process.env.DB_PATH ?? './data/council.db';
const CONFIG_PATH = process.env.CONFIG_PATH;
const MCP_BASE_URL = process.env.MCP_BASE_URL ?? `http://localhost:${PORT}/mcp`;
const COUNCIL_PASSWORD = process.env.COUNCIL_PASSWORD;

async function main() {
  console.log('[COUNCIL] Starting Council server...');

  // ── Database ──
  const dbDir = resolve(DB_PATH, '..');
  if (!existsSync(dbDir)) {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dbDir, { recursive: true });
  }
  const db = createDb(DB_PATH);
  const store = new DbStore(db);
  console.log(`[COUNCIL] Database initialized at ${DB_PATH}`);

  // ── Config ──
  let councilId: string;
  let config;

  if (CONFIG_PATH) {
    config = loadConfigFile(CONFIG_PATH);
    console.log(`[COUNCIL] Loaded config from ${CONFIG_PATH}: "${config.council.name}"`);

    // Check if this council already exists
    const existing = store.listCouncils();
    const match = existing.find((c) => c.name === config!.council.name);
    if (match) {
      councilId = match.id;
      console.log(`[COUNCIL] Using existing council: ${councilId}`);
    } else {
      councilId = nanoid();
      store.saveCouncil({
        id: councilId,
        name: config.council.name,
        description: config.council.description,
        config,
        createdAt: new Date().toISOString(),
      });
      console.log(`[COUNCIL] Created council: ${councilId}`);
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
    config = parseConfig(defaultYaml);
    councilId = nanoid();
    store.saveCouncil({
      id: councilId,
      name: config.council.name,
      description: config.council.description,
      config,
      createdAt: new Date().toISOString(),
    });
    console.log(`[COUNCIL] Using default development config (council: ${councilId})`);
  }

  // ── Engine ──
  const eventRouter = new EventRouter(config.council.event_routing);
  const messageBus = new MessageBus(config.council.communication_graph);
  const agentRegistry = new AgentRegistry();
  agentRegistry.loadAgents(config.council.agents);
  const spawner = createSpawner(config.council.spawner);

  const orchestrator = new Orchestrator({
    config,
    councilId,
    eventRouter,
    messageBus,
    agentRegistry,
    spawner,
    store,
    mcpBaseUrl: MCP_BASE_URL,
  });

  console.log(`[COUNCIL] Orchestrator initialized with ${config.council.agents.length} agent(s)`);

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

  // ── Auth (optional, enabled by COUNCIL_PASSWORD env var) ──
  const auth = createAuth(COUNCIL_PASSWORD);
  if (auth) {
    // Public auth endpoints
    app.post('/auth/login', auth.login);
    app.post('/auth/logout', auth.logout);
    // Check auth status (returns 200 if authed, used by frontend)
    app.get('/auth/check', auth.protect, (_req, res) => {
      res.json({ authenticated: true });
    });
    console.log('[COUNCIL] Password auth enabled (set COUNCIL_PASSWORD)');
  }

  // REST API (protected if auth enabled)
  if (auth) {
    // Health endpoint stays public for Docker healthcheck
    app.get('/api/health', (_req, res, next) => next());
    app.use('/api', auth.protect);
  }
  app.use('/api', createApiRouter(orchestrator, store));

  // Serve web UI static files (production)
  const webDistPath = resolve(import.meta.dirname ?? '.', '../../dist/web');
  if (existsSync(webDistPath)) {
    app.use(express.static(webDistPath));
    // SPA fallback
    app.get('*', (_req, res) => {
      res.sendFile(resolve(webDistPath, 'index.html'));
    });
    console.log(`[COUNCIL] Serving web UI from ${webDistPath}`);
  }

  // ── HTTP + WebSocket ──
  const httpServer = createServer(app);
  setupWebSocket(httpServer, orchestrator);

  httpServer.listen(PORT, HOST, () => {
    console.log(`[COUNCIL] Server listening on http://${HOST}:${PORT}`);
    console.log(`[COUNCIL] MCP endpoint: http://${HOST}:${PORT}/mcp`);
    console.log(`[COUNCIL] Webhooks: http://${HOST}:${PORT}/webhooks/github, /webhooks/ingest`);
    console.log(`[COUNCIL] REST API: http://${HOST}:${PORT}/api`);
    console.log(`[COUNCIL] WebSocket: ws://${HOST}:${PORT}/ws`);
  });
}

main().catch((err) => {
  console.error('[COUNCIL] Fatal error:', err);
  process.exit(1);
});
