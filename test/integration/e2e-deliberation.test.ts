import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseConfig } from '@/engine/config-loader.js';
import { createApp, type CouncilApp } from '@/server/index.js';

const CONFIG_YAML = `
version: "1"
council:
  name: "E2E Test Council"
  description: "Integration test council"
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
let sessionCookie: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-e2e-'));
  const config = parseConfig(CONFIG_YAML);

  council = createApp({
    dbPath: join(tmpDir, 'test.db'),
    config,
    mcpBaseUrl: 'http://localhost:0/mcp',
  });

  // Listen on port 0 to get an ephemeral port
  await new Promise<void>((resolve) => {
    council.httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const addr = council.httpServer.address();
  if (typeof addr === 'object' && addr) {
    baseUrl = `http://127.0.0.1:${addr.port}`;
  }

  // Bootstrap admin user for auth
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

  // Extract session cookie
  const setCookie = setupRes.headers.get('set-cookie') ?? '';
  const match = setCookie.match(/council_session=([^;]+)/);
  sessionCookie = match ? `council_session=${match[1]}` : '';
});

afterAll(async () => {
  await council.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Helper to make authenticated requests */
function authFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, {
    ...init,
    headers: {
      ...init?.headers,
      Cookie: sessionCookie,
    },
  });
}

describe('E2E deliberation flow', () => {
  let sessionId: string;

  it('health check returns 200', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
  });

  it('unauthenticated API request returns 401', async () => {
    const res = await fetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(401);
  });

  it('webhook ingestion creates a session in investigation phase', async () => {
    const res = await fetch(`${baseUrl}/webhooks/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Event-Type': 'test.event',
      },
      body: JSON.stringify({ title: 'Test event payload', priority: 'high' }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.status).toBe('session_created');
    expect(body.sessionId).toBeDefined();
    sessionId = body.sessionId;

    // Verify session was created in investigation phase with correct lead
    const session = council.orchestrator.getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.phase).toBe('investigation');
    expect(session!.leadAgentId).toBe('lead-agent');
  });

  it('submitFindings + createProposal transitions to discussion', () => {
    // Lead agent submits findings
    const finding = council.orchestrator.submitFindings(
      sessionId,
      'lead-agent',
      'Investigation complete: the test event indicates high priority.',
    );
    expect(finding.messageType).toBe('finding');

    // Lead agent creates a proposal (auto-transitions investigation → proposal → discussion)
    const proposal = council.orchestrator.createProposal(
      sessionId,
      'lead-agent',
      'Proposal: address the high-priority test event immediately.',
    );
    expect(proposal.messageType).toBe('proposal');

    // Verify session is now in discussion phase
    const session = council.orchestrator.getSession(sessionId);
    expect(session!.phase).toBe('discussion');
    expect(session!.deliberationRound).toBe(1);

    // Verify all 3 messages are stored (finding + proposal + the messages from bus)
    const messages = council.orchestrator.getMessages(sessionId);
    expect(messages.length).toBe(2);
    expect(messages.map((m) => m.messageType)).toContain('finding');
    expect(messages.map((m) => m.messageType)).toContain('proposal');
  });

  it('voting with both agents approving moves to review', () => {
    // Transition to voting
    council.orchestrator.transitionPhase(sessionId, 'voting');

    const session1 = council.orchestrator.getSession(sessionId);
    expect(session1!.phase).toBe('voting');

    // Both agents vote approve
    council.orchestrator.castVote(sessionId, 'lead-agent', 'approve', 'Looks good.');
    council.orchestrator.castVote(sessionId, 'reviewer-agent', 'approve', 'Agreed, approve.');

    // With require_human_approval: true, voting → review
    const session2 = council.orchestrator.getSession(sessionId);
    expect(session2!.phase).toBe('review');

    // Verify decision exists with approved outcome
    const decision = council.orchestrator.getDecision(sessionId);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });

  it('human review approves and concludes to decided', () => {
    council.orchestrator.submitReview(sessionId, 'approve', 'test-human', 'LGTM');

    const session = council.orchestrator.getSession(sessionId);
    expect(session!.phase).toBe('decided');
  });

  it('REST API returns complete session data', async () => {
    const res = await authFetch(`${baseUrl}/api/sessions/${sessionId}`);
    expect(res.status).toBe(200);

    const body = await res.json();

    // Session
    expect(body.session.id).toBe(sessionId);
    expect(body.session.phase).toBe('decided');
    expect(body.session.leadAgentId).toBe('lead-agent');

    // Messages
    expect(body.messages.length).toBe(2);

    // Votes
    expect(body.votes.length).toBe(2);
    expect(body.votes.map((v: { agentId: string }) => v.agentId).sort()).toEqual(
      ['lead-agent', 'reviewer-agent'],
    );

    // Decision
    expect(body.decision).not.toBeNull();
    expect(body.decision.outcome).toBe('approved');
  });

  it('GET /api/sessions lists the session', async () => {
    const res = await authFetch(`${baseUrl}/api/sessions`);
    expect(res.status).toBe(200);

    const sessions = await res.json();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s: { id: string }) => s.id === sessionId)).toBe(true);
  });

  it('GET /api/events lists the ingested event', async () => {
    const res = await authFetch(`${baseUrl}/api/events`);
    expect(res.status).toBe(200);

    const events = await res.json();
    expect(events.length).toBeGreaterThanOrEqual(1);

    const testEvent = events.find((e: { eventType: string }) => e.eventType === 'test.event');
    expect(testEvent).toBeDefined();
    expect(testEvent.source).toBe('generic');
    expect(testEvent.sessionId).toBe(sessionId);
  });
});
