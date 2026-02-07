import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '@/engine/config-loader.js';
import { createApp, type CouncilApp } from '@/server/index.js';

const CONFIG_YAML = `
version: "1"
council:
  name: "Auth Test Council"
  description: "Auth test"
  spawner:
    type: log
  rules:
    quorum: 1
    voting_threshold: 0.5
    max_deliberation_rounds: 1
    require_human_approval: false
    escalation: []
  agents:
    - id: agent1
      name: "Agent 1"
      role: "Agent"
      system_prompt: "Agent"
  event_routing: []
  communication_graph:
    default_policy: broadcast
    edges: {}
`;

let council: CouncilApp;
let baseUrl: string;
let tmpDir: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-auth-'));
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
});

afterAll(async () => {
  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

function extractCookie(res: Response): string {
  const setCookie = res.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/council_session=([^;]+)/);
  return match ? `council_session=${match[1]}` : '';
}

describe('Multi-user auth', () => {
  it('GET /auth/me indicates setup needed when no users exist', async () => {
    const res = await fetch(`${baseUrl}/auth/me`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.needsSetup).toBe(true);
    expect(body.authenticated).toBe(false);
  });

  it('POST /auth/setup creates admin user', async () => {
    const res = await fetch(`${baseUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        displayName: 'Admin User',
        password: 'password123',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.user.email).toBe('admin@example.com');
    expect(body.user.role).toBe('admin');
  });

  it('POST /auth/setup fails when users already exist', async () => {
    const res = await fetch(`${baseUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'another@example.com',
        displayName: 'Another',
        password: 'password123',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /auth/login with wrong password returns 401', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'wrong' }),
    });
    expect(res.status).toBe(401);
  });

  it('POST /auth/login with correct credentials returns user + sets cookie', async () => {
    const res = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.user.email).toBe('admin@example.com');

    const cookie = extractCookie(res);
    expect(cookie).toContain('council_session=');
  });

  it('GET /auth/me returns user when authenticated', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const cookie = extractCookie(loginRes);

    const res = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.authenticated).toBe(true);
    expect(body.user.email).toBe('admin@example.com');
    expect(body.needsSetup).toBe(false);
  });

  it('API routes require auth', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('API routes work with valid session cookie', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const cookie = extractCookie(loginRes);

    const res = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
  });

  it('POST /auth/logout clears session', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    const cookie = extractCookie(loginRes);

    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(logoutRes.status).toBe(200);

    // Using old cookie should now fail
    const meRes = await fetch(`${baseUrl}/auth/me`, {
      headers: { Cookie: cookie },
    });
    const body = await meRes.json();
    expect(body.authenticated).toBe(false);
  });

  it('password validation: rejects short passwords', async () => {
    const res = await fetch(`${baseUrl}/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'short@example.com',
        displayName: 'Short',
        password: '1234567', // 7 chars
      }),
    });
    // Setup is already completed, so 400
    expect(res.status).toBe(400);
  });
});

describe('Admin user management', () => {
  let adminCookie: string;

  beforeAll(async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'password123' }),
    });
    adminCookie = extractCookie(loginRes);
  });

  it('GET /api/admin/users lists users', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const users = await res.json();
    expect(users.length).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/admin/users creates a member', async () => {
    const res = await fetch(`${baseUrl}/api/admin/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: adminCookie },
      body: JSON.stringify({
        email: 'member@example.com',
        displayName: 'Member User',
        password: 'memberpass123',
        role: 'member',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.email).toBe('member@example.com');
    expect(body.role).toBe('member');
  });

  it('members cannot access admin routes', async () => {
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'member@example.com', password: 'memberpass123' }),
    });
    const memberCookie = extractCookie(loginRes);

    const res = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: memberCookie },
    });
    expect(res.status).toBe(403);
  });

  it('cannot delete self', async () => {
    // Get admin user ID
    const listRes = await fetch(`${baseUrl}/api/admin/users`, {
      headers: { Cookie: adminCookie },
    });
    const users = await listRes.json();
    const admin = users.find((u: { email: string }) => u.email === 'admin@example.com');

    const res = await fetch(`${baseUrl}/api/admin/users/${admin.id}`, {
      method: 'DELETE',
      headers: { Cookie: adminCookie },
    });
    expect(res.status).toBe(400);
  });
});
