import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '@/engine/config-loader.js';
import { createApp, type CouncilApp } from '@/server/index.js';

const CONFIG_YAML = `
version: "1"
council:
  name: "Persistent Agent Test Council"
  description: "Tests persistent agent connections"
  spawner:
    type: log
  rules:
    quorum: 2
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
    enable_refinement: false
    escalation: []
  agents:
    - id: persistent-lead
      name: "Persistent Lead"
      role: "Lead"
      system_prompt: "You are a persistent lead agent."
      persistent: true
    - id: ephemeral-reviewer
      name: "Ephemeral Reviewer"
      role: "Reviewer"
      system_prompt: "You are an ephemeral reviewer."
  event_routing:
    - match:
        source: generic
        type: test.event
      assign:
        lead: persistent-lead
        consult: [ephemeral-reviewer]
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

let council: CouncilApp;
let baseUrl: string;
let tmpDir: string;
let sessionCookie: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-persistent-'));
  const config = parseConfig(CONFIG_YAML);

  council = createApp({
    dbPath: join(tmpDir, 'test.db'),
    config,
    mcpBaseUrl: 'http://localhost:0/mcp',
  });

  await new Promise<void>((resolve) => {
    council.httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = council.httpServer.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Bootstrap admin user
  const setupRes = await fetch(`${baseUrl}/auth/setup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'admin@test.com',
      displayName: 'Test Admin',
      password: 'testpassword123',
    }),
  });
  expect(setupRes.status).toBe(201);

  const setCookie = setupRes.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/council_session=([^;]+)/);
  sessionCookie = match ? `council_session=${match[1]}` : '';
});

afterAll(async () => {
  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Cookie: sessionCookie,
    },
  });
}

describe('Persistent agent lifecycle', () => {
  it('persistent agent gets a stable persistent token', () => {
    const registry = council.orchestrator.getAgentRegistry();
    const token1 = registry.generateToken('persistent-lead');
    const token2 = registry.generateToken('persistent-lead');
    expect(token1).toBe(token2);
    expect(token1).toMatch(/^council_persistent_/);
  });

  it('ephemeral agent gets fresh tokens', () => {
    const registry = council.orchestrator.getAgentRegistry();
    const token1 = registry.generateToken('ephemeral-reviewer');
    const token2 = registry.generateToken('ephemeral-reviewer');
    expect(token1).not.toBe(token2);
  });

  it('persistent agent is marked as persistent in registry', () => {
    const registry = council.orchestrator.getAgentRegistry();
    expect(registry.isPersistent('persistent-lead')).toBe(true);
    expect(registry.isPersistent('ephemeral-reviewer')).toBe(false);
  });

  it('agent statuses include connectionMode', async () => {
    const res = await authFetch(`${baseUrl}/api/agents`);
    expect(res.status).toBe(200);
    const agents = await res.json();

    const persistent = agents.find((a: { id: string }) => a.id === 'persistent-lead');
    expect(persistent.connectionMode).toBe('persistent');

    const ephemeral = agents.find((a: { id: string }) => a.id === 'ephemeral-reviewer');
    expect(ephemeral.connectionMode).toBe('per_session');
  });

  it('webhook assigns session to persistent agent', async () => {
    const res = await fetch(`${baseUrl}/webhooks/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Type': 'test.event',
      },
      body: JSON.stringify({ title: 'First event', priority: 'high' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    const sessionId = body.sessionId;

    // Persistent agent should have the session tracked
    const registry = council.orchestrator.getAgentRegistry();
    const activeSessions = registry.getActiveSessions('persistent-lead');
    expect(activeSessions).toContain(sessionId);
  });

  it('persistent token is saved and loadable from DB', () => {
    const registry = council.orchestrator.getAgentRegistry();
    const token = registry.generatePersistentToken('persistent-lead');

    // Save to DB
    council.store.savePersistentToken('persistent-lead', council.councilId, token);

    // Load from DB
    const stored = council.store.getPersistentToken('persistent-lead');
    expect(stored).not.toBeNull();
    expect(stored!.token).toBe(token);

    // Update last used
    council.store.updateTokenLastUsed('persistent-lead');
    const updated = council.store.getPersistentToken('persistent-lead');
    expect(updated!.lastUsedAt).not.toBeNull();

    // List tokens
    const tokens = council.store.listPersistentTokens(council.councilId);
    expect(tokens).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: 'persistent-lead', token }),
      ]),
    );

    // Delete
    council.store.deletePersistentToken('persistent-lead');
    expect(council.store.getPersistentToken('persistent-lead')).toBeNull();
  });

  it('mixed mode: persistent + ephemeral agents coexist', async () => {
    // Create two sessions via webhook
    const res1 = await fetch(`${baseUrl}/webhooks/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Type': 'test.event',
      },
      body: JSON.stringify({ title: 'Session A' }),
    });
    expect(res1.status).toBe(201);
    const sessionA = (await res1.json()).sessionId;

    const res2 = await fetch(`${baseUrl}/webhooks/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Type': 'test.event',
      },
      body: JSON.stringify({ title: 'Session B' }),
    });
    expect(res2.status).toBe(201);
    const sessionB = (await res2.json()).sessionId;

    // Persistent agent should be assigned to both sessions
    const registry = council.orchestrator.getAgentRegistry();
    const sessions = registry.getActiveSessions('persistent-lead');
    expect(sessions).toContain(sessionA);
    expect(sessions).toContain(sessionB);

    // Both sessions should exist
    const sessionObjA = council.orchestrator.getSession(sessionA);
    const sessionObjB = council.orchestrator.getSession(sessionB);
    expect(sessionObjA).not.toBeNull();
    expect(sessionObjB).not.toBeNull();
    expect(sessionObjA!.leadAgentId).toBe('persistent-lead');
    expect(sessionObjB!.leadAgentId).toBe('persistent-lead');
  });
});
