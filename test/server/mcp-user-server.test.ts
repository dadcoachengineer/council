import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '@/engine/config-loader.js';
import { createApp, type CouncilApp } from '@/server/index.js';

const CONFIG_YAML = `
version: "1"
council:
  name: "User MCP Test Council"
  description: "Tests for user-facing MCP endpoint"
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
    - id: lead-agent
      name: "Lead Agent"
      role: "Lead"
      system_prompt: "You are the lead agent."
    - id: reviewer-agent
      name: "Reviewer Agent"
      role: "Reviewer"
      system_prompt: "You are a reviewer agent."
  event_routing:
    - match:
        source: generic
        type: test.event
      assign:
        lead: lead-agent
        consult: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

let council: CouncilApp;
let baseUrl: string;
let tmpDir: string;
let apiKey: string;
let adminUserId: string;
let sessionCookie: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-user-mcp-'));
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

  // Extract session cookie for admin API calls
  const setCookie = setupRes.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/council_session=([^;]+)/);
  sessionCookie = match ? `council_session=${match[1]}` : '';

  // Get admin user ID
  const user = council.userStore.getUserByEmail('admin@test.com');
  adminUserId = user!.id;

  // Create an API key
  const result = await council.userStore.createApiKey(adminUserId, 'test-key');
  apiKey = result.key;
});

afterAll(async () => {
  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper for authenticated admin API requests */
function adminFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Cookie: sessionCookie,
    },
  });
}

/**
 * Helper to make a JSON-RPC request to the user MCP endpoint.
 * Handles session init + subsequent requests.
 */
async function mcpRequest(
  method: string,
  params: Record<string, unknown> = {},
  mcpSessionId?: string,
): Promise<{ status: number; body: unknown; sessionId?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${apiKey}`,
  };
  if (mcpSessionId) {
    headers['mcp-session-id'] = mcpSessionId;
  }

  const res = await fetch(`${baseUrl}/mcp/user`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method,
      params,
    }),
  });

  const newSessionId = res.headers.get('mcp-session-id') ?? undefined;
  const text = await res.text();

  // MCP may return SSE-formatted responses
  let body: unknown;
  if (text.startsWith('event:')) {
    // Parse SSE format
    const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
    if (dataLine) {
      body = JSON.parse(dataLine.slice(5).trim());
    } else {
      body = text;
    }
  } else if (text.trim()) {
    body = JSON.parse(text);
  } else {
    body = null;
  }

  return { status: res.status, body, sessionId: newSessionId };
}

/**
 * Helper to init an MCP session and return the session ID.
 */
async function initMcpSession(): Promise<string> {
  const { sessionId } = await mcpRequest('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '0.1.0' },
  });
  expect(sessionId).toBeDefined();

  // Send initialized notification
  await fetch(`${baseUrl}/mcp/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${apiKey}`,
      'mcp-session-id': sessionId!,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/initialized',
    }),
  });

  return sessionId!;
}

describe('User MCP endpoint auth', () => {
  it('rejects requests without Bearer token', async () => {
    const res = await fetch(`${baseUrl}/mcp/user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects requests with invalid token', async () => {
    const res = await fetch(`${baseUrl}/mcp/user`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: 'Bearer ck_invalidtoken123',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test', version: '0.1.0' },
        },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('successfully initializes with valid API key', async () => {
    const { status, sessionId } = await mcpRequest('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test-client', version: '0.1.0' },
    });
    expect(status).toBe(200);
    expect(sessionId).toBeDefined();
  });
});

describe('User MCP tools', () => {
  let mcpSession: string;

  beforeAll(async () => {
    mcpSession = await initMcpSession();
  });

  it('list_sessions returns empty array initially', async () => {
    const { body } = await mcpRequest(
      'tools/call',
      { name: 'council_user_list_sessions', arguments: {} },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const sessions = JSON.parse(result.result!.content[0].text);
    expect(Array.isArray(sessions)).toBe(true);
  });

  it('create_session creates a new session', async () => {
    const { body } = await mcpRequest(
      'tools/call',
      { name: 'council_user_create_session', arguments: { title: 'Test MCP Session' } },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(result.result!.content[0].text);
    expect(parsed.status).toBe('created');
    expect(parsed.sessionId).toBeDefined();
  });

  it('get_session returns session details', async () => {
    // First create a session
    const sessions = council.orchestrator.listSessions();
    const session = sessions[0];

    const { body } = await mcpRequest(
      'tools/call',
      { name: 'council_user_get_session', arguments: { session_id: session.id } },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(result.result!.content[0].text);
    expect(parsed.session.id).toBe(session.id);
    expect(parsed.session.title).toBe('Test MCP Session');
  });

  it('get_agents returns agent statuses', async () => {
    const { body } = await mcpRequest(
      'tools/call',
      { name: 'council_user_get_agents', arguments: {} },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const agents = JSON.parse(result.result!.content[0].text);
    expect(agents.length).toBe(2);
    expect(agents.map((a: { id: string }) => a.id).sort()).toEqual(['lead-agent', 'reviewer-agent']);
  });

  it('list_pending_decisions returns decisions', async () => {
    const { body } = await mcpRequest(
      'tools/call',
      { name: 'council_user_list_pending_decisions', arguments: {} },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const decisions = JSON.parse(result.result!.content[0].text);
    expect(Array.isArray(decisions)).toBe(true);
  });

  it('ingest_event triggers session creation', async () => {
    const { body } = await mcpRequest(
      'tools/call',
      {
        name: 'council_user_ingest_event',
        arguments: { event_type: 'test.event', payload: { title: 'Ingested via MCP', priority: 'low' } },
      },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(result.result!.content[0].text);
    expect(parsed.status).toBe('session_created');
    expect(parsed.sessionId).toBeDefined();
  });

  it('submit_review works for a session in review phase', async () => {
    // Create a session and drive it to review phase
    const session = council.orchestrator.createSession({
      title: 'Review Test Session',
      leadAgentId: 'lead-agent',
    });
    council.orchestrator.createProposal(session.id, 'lead-agent', 'Test proposal');
    council.orchestrator.transitionPhase(session.id, 'voting');
    council.orchestrator.castVote(session.id, 'lead-agent', 'approve', 'Yes');
    council.orchestrator.castVote(session.id, 'reviewer-agent', 'approve', 'Agreed');

    // Should now be in review phase
    const reviewSession = council.orchestrator.getSession(session.id);
    expect(reviewSession!.phase).toBe('review');

    const { body } = await mcpRequest(
      'tools/call',
      {
        name: 'council_user_submit_review',
        arguments: { session_id: session.id, action: 'approve', notes: 'LGTM via MCP' },
      },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(result.result!.content[0].text);
    expect(parsed.status).toBe('review_submitted');
    expect(parsed.reviewedBy).toBe('Test Admin');

    // Session should be decided
    const decidedSession = council.orchestrator.getSession(session.id);
    expect(decidedSession!.phase).toBe('decided');
  });

  it('transition_phase works', async () => {
    const session = council.orchestrator.createSession({
      title: 'Transition Test',
      leadAgentId: 'lead-agent',
    });

    const { body } = await mcpRequest(
      'tools/call',
      {
        name: 'council_user_transition_phase',
        arguments: { session_id: session.id, phase: 'discussion' },
      },
      mcpSession,
    );
    const result = body as { result?: { content: Array<{ text: string }> } };
    const parsed = JSON.parse(result.result!.content[0].text);
    expect(parsed.status).toBe('transitioned');
    expect(parsed.phase).toBe('discussion');

    const updated = council.orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('discussion');
  });
});

describe('API key admin endpoints', () => {
  it('POST /api/admin/api-keys creates a key', async () => {
    const res = await adminFetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: adminUserId, name: 'admin-key-2' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toBeDefined();
    expect(body.key.startsWith('ck_')).toBe(true);
    expect(body.keyPrefix).toBeDefined();
    expect(body.name).toBe('admin-key-2');
    expect(body.id).toBeDefined();
  });

  it('GET /api/admin/api-keys lists keys', async () => {
    const res = await adminFetch(`${baseUrl}/api/admin/api-keys?userId=${adminUserId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body)).toBe(true);
    // Should have at least 2 keys (test-key + admin-key-2)
    expect(body.length).toBeGreaterThanOrEqual(2);
    // Keys should not expose hashes
    for (const key of body) {
      expect(key.keyPrefix).toBeDefined();
      expect(key.name).toBeDefined();
      expect(key.keyHash).toBeUndefined();
    }
  });

  it('DELETE /api/admin/api-keys/:id revokes a key', async () => {
    // Create a key to delete
    const result = await council.userStore.createApiKey(adminUserId, 'to-delete');
    const deleteRes = await adminFetch(`${baseUrl}/api/admin/api-keys/${result.id}`, {
      method: 'DELETE',
    });
    expect(deleteRes.status).toBe(200);
    const body = await deleteRes.json();
    expect(body.status).toBe('deleted');

    // Verify key is gone
    const keys = council.userStore.listApiKeys(adminUserId);
    expect(keys.find((k) => k.id === result.id)).toBeUndefined();
  });

  it('POST /api/admin/api-keys rejects missing fields', async () => {
    const res = await adminFetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'no-user-id' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/admin/api-keys rejects non-existent user', async () => {
    const res = await adminFetch(`${baseUrl}/api/admin/api-keys`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: 'nonexistent', name: 'bad-key' }),
    });
    expect(res.status).toBe(404);
  });
});

describe('API key verification', () => {
  it('verifyApiKey returns user for valid key', async () => {
    const user = await council.userStore.verifyApiKey(apiKey);
    expect(user).not.toBeNull();
    expect(user!.email).toBe('admin@test.com');
  });

  it('verifyApiKey returns null for invalid key', async () => {
    const user = await council.userStore.verifyApiKey('ck_invalidkey12345678901234567890');
    expect(user).toBeNull();
  });

  it('verifyApiKey returns null for non-ck prefixed key', async () => {
    const user = await council.userStore.verifyApiKey('invalid_key');
    expect(user).toBeNull();
  });

  it('verifyApiKey updates lastUsedAt', async () => {
    const keysBefore = council.userStore.listApiKeys(adminUserId);
    const testKey = keysBefore.find((k) => k.name === 'test-key')!;
    const lastUsedBefore = testKey.lastUsedAt;

    // Verify the key to trigger lastUsedAt update
    await council.userStore.verifyApiKey(apiKey);

    const keysAfter = council.userStore.listApiKeys(adminUserId);
    const testKeyAfter = keysAfter.find((k) => k.name === 'test-key')!;
    // lastUsedAt should be set (was null before or has changed)
    expect(testKeyAfter.lastUsedAt).not.toBeNull();
    if (lastUsedBefore) {
      expect(new Date(testKeyAfter.lastUsedAt!).getTime())
        .toBeGreaterThanOrEqual(new Date(lastUsedBefore).getTime());
    }
  });

  it('deleteUser also deletes API keys', async () => {
    // Create a temp user with a key
    const user = await council.userStore.createUser('temp@test.com', 'Temp', 'password123', 'member');
    await council.userStore.createApiKey(user.id, 'temp-key');
    expect(council.userStore.listApiKeys(user.id).length).toBe(1);

    council.userStore.deleteUser(user.id);
    expect(council.userStore.listApiKeys(user.id).length).toBe(0);
  });
});
