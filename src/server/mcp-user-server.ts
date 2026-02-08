import { randomUUID } from 'node:crypto';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Router, Request, Response } from 'express';
import { Router as createRouter } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { OrchestratorRegistry } from '../engine/orchestrator-registry.js';
import type { UserStore, UserRow } from './user-store.js';
import type { PublicUser } from '../shared/types.js';

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role as PublicUser['role'],
    totpEnabled: row.totpVerified === 1,
    createdAt: row.createdAt,
  };
}

/**
 * Register user-facing tools on an McpServer instance.
 * Tools are prefixed with `council_user_` to avoid collision with agent tools.
 */
function registerUserTools(
  server: McpServer,
  registry: OrchestratorRegistry,
  sessionUsers: Map<string, PublicUser>,
): void {
  // Helper to get user from session
  function getUser(extra: { sessionId?: string }): PublicUser | null {
    if (!extra.sessionId) return null;
    return sessionUsers.get(extra.sessionId) ?? null;
  }

  // Helper to resolve orchestrator from optional council_id, falling back to default
  function resolveOrchestrator(councilId?: string): { orchestrator: Orchestrator; councilId: string } | null {
    if (councilId) {
      const entry = registry.get(councilId);
      if (!entry) return null;
      return { orchestrator: entry.orchestrator, councilId };
    }
    const defaultEntry = registry.getDefault();
    const defaultId = registry.getDefaultId();
    if (!defaultEntry || !defaultId) return null;
    return { orchestrator: defaultEntry.orchestrator, councilId: defaultId };
  }

  // ── Tool: council_user_list_councils ──
  server.registerTool(
    'council_user_list_councils',
    {
      description: 'List all available councils',
      inputSchema: {},
    },
    async (_args, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const allCouncils = registry.list().map(({ councilId, entry }) => ({
        id: councilId,
        name: entry.config.council.name,
        description: entry.config.council.description,
        agentCount: entry.config.council.agents.length,
      }));
      return {
        content: [{ type: 'text', text: JSON.stringify(allCouncils, null, 2) }],
      };
    },
  );

  // ── Tool: council_user_list_sessions ──
  server.registerTool(
    'council_user_list_sessions',
    {
      description: 'List deliberation sessions with optional phase filter',
      inputSchema: {
        phase: z.enum([
          'investigation', 'proposal', 'discussion', 'refinement',
          'voting', 'review', 'decided', 'closed',
        ]).optional().describe('Filter by session phase'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ phase, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      const sessions = resolved.orchestrator.listSessions(phase);
      return {
        content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }],
      };
    },
  );

  // ── Tool: council_user_get_session ──
  server.registerTool(
    'council_user_get_session',
    {
      description: 'Get full session details including messages, votes, and decision',
      inputSchema: {
        session_id: z.string().describe('The session ID to retrieve'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ session_id, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      const session = resolved.orchestrator.getSession(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: 'Error: Session not found' }], isError: true };
      }
      const messages = resolved.orchestrator.getMessages(session_id);
      const votes = resolved.orchestrator.getVotes(session_id);
      const decision = resolved.orchestrator.getDecision(session_id);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ session, messages, votes, decision }, null, 2),
        }],
      };
    },
  );

  // ── Tool: council_user_create_session ──
  server.registerTool(
    'council_user_create_session',
    {
      description: 'Create a new deliberation session',
      inputSchema: {
        title: z.string().describe('Session title/topic'),
        lead_agent_id: z.string().optional().describe('Lead agent ID (optional)'),
        topics: z.array(z.string()).optional().describe('Expertise tags for dynamic voting weights (optional)'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ title, lead_agent_id, topics, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      try {
        const session = resolved.orchestrator.createSession({
          title,
          leadAgentId: lead_agent_id ?? null,
          topics,
        });
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ sessionId: session.id, status: 'created', phase: session.phase }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_user_submit_review ──
  server.registerTool(
    'council_user_submit_review',
    {
      description: 'Submit a human review for a decision (approve, reject, or send back)',
      inputSchema: {
        session_id: z.string().describe('The session ID'),
        action: z.enum(['approve', 'reject', 'send_back']).describe('Review action'),
        notes: z.string().optional().describe('Review notes'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ session_id, action, notes, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      try {
        resolved.orchestrator.submitReview(session_id, action, user.displayName, notes);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ sessionId: session_id, action, reviewedBy: user.displayName, status: 'review_submitted' }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_user_list_pending_decisions ──
  server.registerTool(
    'council_user_list_pending_decisions',
    {
      description: 'List decisions awaiting human review',
      inputSchema: {
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      const decisions = resolved.orchestrator.listPendingDecisions();
      return {
        content: [{ type: 'text', text: JSON.stringify(decisions, null, 2) }],
      };
    },
  );

  // ── Tool: council_user_get_agents ──
  server.registerTool(
    'council_user_get_agents',
    {
      description: 'Get agent statuses',
      inputSchema: {
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      const agents = resolved.orchestrator.getAgentRegistry().getStatuses();
      return {
        content: [{ type: 'text', text: JSON.stringify(agents, null, 2) }],
      };
    },
  );

  // ── Tool: council_user_transition_phase ──
  server.registerTool(
    'council_user_transition_phase',
    {
      description: 'Manually transition a session to a new phase',
      inputSchema: {
        session_id: z.string().describe('The session ID'),
        phase: z.enum([
          'investigation', 'proposal', 'discussion', 'refinement',
          'voting', 'review', 'decided', 'closed',
        ]).describe('Target phase'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ session_id, phase, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      try {
        resolved.orchestrator.transitionPhase(session_id, phase);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ sessionId: session_id, phase, status: 'transitioned' }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_user_ingest_event ──
  server.registerTool(
    'council_user_ingest_event',
    {
      description: 'Ingest a generic event to trigger routing and session creation',
      inputSchema: {
        event_type: z.string().describe('Event type (e.g. "test.event")'),
        payload: z.record(z.unknown()).describe('Event payload'),
        council_id: z.string().optional().describe('Council ID (uses default if omitted)'),
      },
    },
    async ({ event_type, payload, council_id }, extra) => {
      const user = getUser(extra);
      if (!user) {
        return { content: [{ type: 'text', text: 'Error: Not authenticated' }], isError: true };
      }
      const resolved = resolveOrchestrator(council_id);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Council not found' }], isError: true };
      }
      try {
        const session = await resolved.orchestrator.handleWebhookEvent({
          source: 'generic',
          eventType: event_type,
          payload,
        });
        if (session) {
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'session_created', sessionId: session.id }),
            }],
          };
        }
        return {
          content: [{ type: 'text', text: JSON.stringify({ status: 'no_matching_rule' }) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );
}

/**
 * Register user-facing resources on an McpServer instance.
 */
function registerResources(
  server: McpServer,
  registry: OrchestratorRegistry,
): void {
  // Helper: get default orchestrator for backward-compatible resources
  function getDefaultOrchestrator(): Orchestrator | null {
    return registry.getDefault()?.orchestrator ?? null;
  }

  // ── council://councils ──
  server.registerResource(
    'council_councils',
    'council://councils',
    { description: 'All available councils', mimeType: 'application/json' },
    async () => {
      const allCouncils = registry.list().map(({ councilId, entry }) => ({
        id: councilId,
        name: entry.config.council.name,
        description: entry.config.council.description,
        agentCount: entry.config.council.agents.length,
      }));
      return {
        contents: [{
          uri: 'council://councils',
          mimeType: 'application/json',
          text: JSON.stringify(allCouncils, null, 2),
        }],
      };
    },
  );

  // ── council://config ──
  server.registerResource(
    'council_config',
    'council://config',
    { description: 'Default council configuration', mimeType: 'application/json' },
    async () => {
      const orchestrator = getDefaultOrchestrator();
      if (!orchestrator) {
        return { contents: [{ uri: 'council://config', mimeType: 'application/json', text: '{"error":"No council available"}' }] };
      }
      const config = orchestrator.getConfig();
      return {
        contents: [{
          uri: 'council://config',
          mimeType: 'application/json',
          text: JSON.stringify({
            id: orchestrator.getCouncilId(),
            name: config.council.name,
            description: config.council.description,
            agents: config.council.agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
            rules: config.council.rules,
          }, null, 2),
        }],
      };
    },
  );

  // ── council://agents ──
  server.registerResource(
    'council_agents',
    'council://agents',
    { description: 'Current agent statuses', mimeType: 'application/json' },
    async () => {
      const orchestrator = getDefaultOrchestrator();
      if (!orchestrator) {
        return { contents: [{ uri: 'council://agents', mimeType: 'application/json', text: '[]' }] };
      }
      const agents = orchestrator.getAgentRegistry().getStatuses();
      return {
        contents: [{
          uri: 'council://agents',
          mimeType: 'application/json',
          text: JSON.stringify(agents, null, 2),
        }],
      };
    },
  );

  // ── council://decisions/pending ──
  server.registerResource(
    'council_pending_decisions',
    'council://decisions/pending',
    { description: 'Decisions awaiting human review', mimeType: 'application/json' },
    async () => {
      const orchestrator = getDefaultOrchestrator();
      if (!orchestrator) {
        return { contents: [{ uri: 'council://decisions/pending', mimeType: 'application/json', text: '[]' }] };
      }
      const decisions = orchestrator.listPendingDecisions();
      return {
        contents: [{
          uri: 'council://decisions/pending',
          mimeType: 'application/json',
          text: JSON.stringify(decisions, null, 2),
        }],
      };
    },
  );

  // ── council://sessions ──
  server.registerResource(
    'council_sessions',
    'council://sessions',
    { description: 'All deliberation sessions', mimeType: 'application/json' },
    async () => {
      const orchestrator = getDefaultOrchestrator();
      if (!orchestrator) {
        return { contents: [{ uri: 'council://sessions', mimeType: 'application/json', text: '[]' }] };
      }
      const sessions = orchestrator.listSessions();
      return {
        contents: [{
          uri: 'council://sessions',
          mimeType: 'application/json',
          text: JSON.stringify(sessions, null, 2),
        }],
      };
    },
  );

  // ── council://sessions/{sessionId} ──
  server.registerResource(
    'council_session_detail',
    new ResourceTemplate('council://sessions/{sessionId}', {
      list: async () => {
        const orchestrator = getDefaultOrchestrator();
        if (!orchestrator) return { resources: [] };
        const sessions = orchestrator.listSessions();
        return {
          resources: sessions.map((s) => ({
            uri: `council://sessions/${s.id}`,
            name: s.title,
            description: `Session ${s.id} — ${s.phase}`,
            mimeType: 'application/json' as const,
          })),
        };
      },
    }),
    { description: 'Session detail with messages, votes, and decision', mimeType: 'application/json' },
    async (uri, { sessionId }) => {
      const orchestrator = getDefaultOrchestrator();
      if (!orchestrator) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"error":"No council available"}' }] };
      }
      const sid = String(sessionId);
      const session = orchestrator.getSession(sid);
      if (!session) {
        return { contents: [{ uri: uri.href, mimeType: 'application/json', text: '{"error":"Session not found"}' }] };
      }
      const messages = orchestrator.getMessages(sid);
      const votes = orchestrator.getVotes(sid);
      const decision = orchestrator.getDecision(sid);
      return {
        contents: [{
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({ session, messages, votes, decision }, null, 2),
        }],
      };
    },
  );
}

/**
 * Register user-facing prompts on an McpServer instance.
 */
function registerPrompts(server: McpServer): void {
  // ── start-deliberation ──
  server.registerPrompt(
    'start-deliberation',
    {
      description: 'Guide through creating a new deliberation session',
      argsSchema: {
        topic: z.string().describe('The topic to deliberate'),
      },
    },
    ({ topic }) => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            `I want to start a deliberation on: "${topic}"`,
            '',
            'Please help me:',
            '1. Use council_user_list_councils to see available councils',
            '2. Use council_user_get_agents to see available agents',
            '3. Use council_user_create_session to create a session with an appropriate title',
            '4. Optionally assign a lead agent based on the topic',
            '5. Summarize the created session details',
          ].join('\n'),
        },
      }],
    }),
  );

  // ── review-decisions ──
  server.registerPrompt(
    'review-decisions',
    { description: 'Review all pending decisions awaiting human approval' },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Please review all pending decisions:',
            '',
            '1. Use council_user_list_pending_decisions to get all pending decisions',
            '2. For each decision, use council_user_get_session to get full context',
            '3. Present a summary of each decision with the votes and discussion',
            '4. Ask me for each one whether to approve, reject, or send back',
            '5. Use council_user_submit_review to submit my decision',
          ].join('\n'),
        },
      }],
    }),
  );

  // ── check-agents ──
  server.registerPrompt(
    'check-agents',
    { description: 'Check the status of all council agents' },
    () => ({
      messages: [{
        role: 'user',
        content: {
          type: 'text',
          text: [
            'Please check the status of all council agents:',
            '',
            '1. Use council_user_get_agents to get all agent statuses',
            '2. For each agent, show: name, role, connection status, active sessions',
            '3. Highlight any agents that are disconnected or have issues',
          ].join('\n'),
        },
      }],
    }),
  );
}

/**
 * Create a fresh McpServer for a user session.
 */
function createUserServerInstance(
  registry: OrchestratorRegistry,
  sessionUsers: Map<string, PublicUser>,
): McpServer {
  const server = new McpServer({
    name: 'council-user',
    version: '0.1.0',
  }, {
    instructions: 'Council user MCP server. Manage deliberation sessions, review decisions, and monitor agents.',
  });
  registerUserTools(server, registry, sessionUsers);
  registerResources(server, registry);
  registerPrompts(server);
  return server;
}

export interface UserMcpRouterResult {
  router: Router;
}

/**
 * Create the user-facing MCP Express router for the /mcp/user endpoint.
 * Authenticates via Bearer token (API key) tied to user accounts.
 */
export function createUserMcpRouter(
  registry: OrchestratorRegistry,
  userStore: UserStore,
): UserMcpRouterResult {
  const router = createRouter();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();
  const sessionUsers = new Map<string, PublicUser>();
  const sessionCleanup = new Map<string, () => void>();

  /**
   * Extract and verify the Bearer token from the Authorization header.
   */
  async function authenticateRequest(req: Request): Promise<UserRow | null> {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return null;
    const token = authHeader.slice(7);
    return userStore.verifyApiKey(token);
  }

  // ── POST / ──
  router.post('/', async (req: Request, res: Response) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (mcpSessionId && transports.has(mcpSessionId)) {
      // Existing session — verify user is still valid
      if (!sessionUsers.has(mcpSessionId)) {
        res.status(401).json({ error: 'Session expired' });
        return;
      }
      transport = transports.get(mcpSessionId)!;
    } else if (!mcpSessionId) {
      // New session — authenticate
      const user = await authenticateRequest(req);
      if (!user) {
        res.status(401).json({ error: 'Invalid or missing API key' });
        return;
      }
      const publicUser = toPublicUser(user);

      const server = createUserServerInstance(registry, sessionUsers);

      // Wire up real-time resource updates from all orchestrators
      const unsubscribers: Array<() => void> = [];
      for (const { entry } of registry.list()) {
        unsubscribers.push(entry.orchestrator.onEvent(() => {
          server.server.sendResourceListChanged().catch(() => {});
        }));
      }
      const unsubscribe = () => unsubscribers.forEach(fn => fn());

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          servers.set(id, server);
          sessionUsers.set(id, publicUser);
          sessionCleanup.set(id, unsubscribe);
        },
        onsessionclosed: (id) => {
          sessionCleanup.get(id)?.();
          sessionCleanup.delete(id);
          transports.delete(id);
          servers.delete(id);
          sessionUsers.delete(id);
        },
      });

      await server.connect(transport);
    } else {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  // ── GET / (SSE) ──
  router.get('/', async (req: Request, res: Response) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!mcpSessionId || !transports.has(mcpSessionId)) {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }
    await transports.get(mcpSessionId)!.handleRequest(req, res);
  });

  // ── DELETE / ──
  router.delete('/', async (req: Request, res: Response) => {
    const mcpSessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!mcpSessionId || !transports.has(mcpSessionId)) {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }
    await transports.get(mcpSessionId)!.handleRequest(req, res);
    transports.delete(mcpSessionId);
    servers.delete(mcpSessionId);
    sessionUsers.delete(mcpSessionId);
  });

  return { router };
}
