import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '@/engine/config-loader.js';
import { createApp, type CouncilApp } from '@/server/index.js';

const YAML_ALPHA = `
version: "1"
council:
  name: "Alpha Council"
  description: "First test council"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
    escalation: []
  agents:
    - id: alpha-lead
      name: "Alpha Lead"
      role: "Lead"
      system_prompt: "You are the alpha lead."
  event_routing:
    - match:
        source: generic
        type: alpha.event
      assign:
        lead: alpha-lead
        consult: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

const YAML_BETA = `
version: "1"
council:
  name: "Beta Council"
  description: "Second test council"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 3
    require_human_approval: true
    escalation: []
  agents:
    - id: beta-lead
      name: "Beta Lead"
      role: "Lead"
      system_prompt: "You are the beta lead."
  event_routing:
    - match:
        source: generic
        type: beta.event
      assign:
        lead: beta-lead
        consult: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

let council: CouncilApp;
let baseUrl: string;
let tmpDir: string;
let sessionCookie: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-multi-'));
  const configAlpha = parseConfig(YAML_ALPHA);
  const configBeta = parseConfig(YAML_BETA);

  council = createApp({
    dbPath: join(tmpDir, 'test.db'),
    configs: [
      { councilId: 'alpha-id', config: configAlpha },
      { councilId: 'beta-id', config: configBeta },
    ],
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
    body: JSON.stringify({ email: 'admin@test.com', displayName: 'Admin', password: 'testpassword' }),
  });
  expect(setupRes.ok).toBe(true);
  sessionCookie = setupRes.headers.getSetCookie()?.[0]?.split(';')[0] ?? '';
});

afterAll(async () => {
  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { Cookie: sessionCookie, 'Content-Type': 'application/json', ...extra };
}

describe('Multi-council app setup', () => {
  it('creates app with multiple councils', () => {
    expect(council.registry.size).toBe(2);
    expect(council.councilId).toBe('alpha-id');
    expect(council.orchestrator).toBeDefined();
  });

  it('lists both councils via API', async () => {
    const res = await fetch(`${baseUrl}/api/councils`, { headers: authHeaders() });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data.map((c: any) => c.name).sort()).toEqual(['Alpha Council', 'Beta Council']);
  });

  it('default council is the first registered', () => {
    expect(council.registry.getDefaultId()).toBe('alpha-id');
  });
});

describe('Session isolation', () => {
  it('creates sessions in specific councils via nested routes', async () => {
    const resA = await fetch(`${baseUrl}/api/councils/alpha-id/sessions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Alpha Session' }),
    });
    expect(resA.status).toBe(201);
    const sessionA = await resA.json();
    expect(sessionA.councilId).toBe('alpha-id');

    const resB = await fetch(`${baseUrl}/api/councils/beta-id/sessions`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ title: 'Beta Session' }),
    });
    expect(resB.status).toBe(201);
    const sessionB = await resB.json();
    expect(sessionB.councilId).toBe('beta-id');
  });

  it('flat sessions route uses default council', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`, { headers: authHeaders() });
    expect(res.ok).toBe(true);
    const sessions = await res.json();
    // Should only show alpha sessions (default council)
    for (const s of sessions) {
      expect(s.councilId).toBe('alpha-id');
    }
  });

  it('flat sessions route supports ?councilId filter', async () => {
    const res = await fetch(`${baseUrl}/api/sessions?councilId=beta-id`, { headers: authHeaders() });
    expect(res.ok).toBe(true);
    const sessions = await res.json();
    for (const s of sessions) {
      expect(s.councilId).toBe('beta-id');
    }
  });

  it('council-scoped sessions are isolated', async () => {
    const resA = await fetch(`${baseUrl}/api/councils/alpha-id/sessions`, { headers: authHeaders() });
    const sessionsA = await resA.json();

    const resB = await fetch(`${baseUrl}/api/councils/beta-id/sessions`, { headers: authHeaders() });
    const sessionsB = await resB.json();

    // No overlap in session IDs
    const idsA = new Set(sessionsA.map((s: any) => s.id));
    const idsB = new Set(sessionsB.map((s: any) => s.id));
    for (const id of idsA) {
      expect(idsB.has(id)).toBe(false);
    }
  });
});

describe('Agent isolation', () => {
  it('shows agents for specific council via nested route', async () => {
    const resA = await fetch(`${baseUrl}/api/councils/alpha-id/agents`, { headers: authHeaders() });
    expect(resA.ok).toBe(true);
    const agentsA = await resA.json();
    expect(agentsA).toHaveLength(1);
    expect(agentsA[0].id).toBe('alpha-lead');

    const resB = await fetch(`${baseUrl}/api/councils/beta-id/agents`, { headers: authHeaders() });
    expect(resB.ok).toBe(true);
    const agentsB = await resB.json();
    expect(agentsB).toHaveLength(1);
    expect(agentsB[0].id).toBe('beta-lead');
  });

  it('flat agents route uses default council', async () => {
    const res = await fetch(`${baseUrl}/api/agents`, { headers: authHeaders() });
    expect(res.ok).toBe(true);
    const agents = await res.json();
    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('alpha-lead');
  });
});

describe('Webhook dispatch', () => {
  it('routes generic event to correct council via ?councilId', async () => {
    // Beta council has routing for beta.event
    const res = await fetch(`${baseUrl}/webhooks/ingest?councilId=beta-id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Type': 'beta.event' },
      body: JSON.stringify({ title: 'Beta webhook event' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('session_created');
    expect(data.councilId).toBe('beta-id');
  });

  it('broadcasts to all councils when no councilId specified', async () => {
    const res = await fetch(`${baseUrl}/webhooks/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Type': 'alpha.event' },
      body: JSON.stringify({ title: 'Alpha broadcast event' }),
    });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.status).toBe('session_created');
    expect(data.councilId).toBe('alpha-id');
  });

  it('returns 404 for unknown council in webhook', async () => {
    const res = await fetch(`${baseUrl}/webhooks/ingest?councilId=nonexistent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Type': 'test.event' },
      body: JSON.stringify({ data: 'test' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('Council management', () => {
  it('gets council details with agent statuses', async () => {
    const res = await fetch(`${baseUrl}/api/councils/alpha-id`, { headers: authHeaders() });
    expect(res.ok).toBe(true);
    const data = await res.json();
    expect(data.name).toBe('Alpha Council');
    expect(data.agents).toBeDefined();
    expect(data.active).toBe(true);
  });

  it('returns 404 for unknown council', async () => {
    const res = await fetch(`${baseUrl}/api/councils/nonexistent`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });

  it('returns 404 for scoped routes with unknown council', async () => {
    const res = await fetch(`${baseUrl}/api/councils/nonexistent/sessions`, { headers: authHeaders() });
    expect(res.status).toBe(404);
  });
});

describe('Event isolation', () => {
  it('shows events scoped to council', async () => {
    const resA = await fetch(`${baseUrl}/api/councils/alpha-id/events`, { headers: authHeaders() });
    expect(resA.ok).toBe(true);
    const eventsA = await resA.json();

    const resB = await fetch(`${baseUrl}/api/councils/beta-id/events`, { headers: authHeaders() });
    expect(resB.ok).toBe(true);
    const eventsB = await resB.json();

    // Events should be council-scoped (no cross-contamination)
    for (const e of eventsA) {
      expect(e.councilId).toBe('alpha-id');
    }
    for (const e of eventsB) {
      expect(e.councilId).toBe('beta-id');
    }
  });
});
