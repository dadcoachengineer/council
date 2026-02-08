import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Router, Request, Response } from 'express';
import { Router as createRouter } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { OrchestratorRegistry, OrchestratorEntry } from '../engine/orchestrator-registry.js';
import type { AgentRegistry } from '../engine/agent-registry.js';
import { createVotingScheme } from '../engine/voting-schemes/index.js';
import type { SessionAssignment } from '../shared/types.js';

/**
 * Register all agent-facing tools on an McpServer instance.
 * The orchestrator/registry are resolved per-tool-call based on agent token.
 */
function registerTools(server: McpServer, registry: OrchestratorRegistry): void {

  /** Helper: resolve agent token to agentId + orchestrator + agentRegistry. */
  function resolveToken(token: string): { agentId: string; orchestrator: Orchestrator; agentRegistry: AgentRegistry; councilId: string } | null {
    const result = registry.resolveAgentToken(token);
    if (!result) return null;
    result.entry.agentRegistry.touch(result.agentId);
    return {
      agentId: result.agentId,
      orchestrator: result.entry.orchestrator,
      agentRegistry: result.entry.agentRegistry,
      councilId: result.councilId,
    };
  }

  // ── Tool: council_get_context ──
  server.registerTool(
    'council_get_context',
    {
      description: 'Get pending tasks, messages, and sessions for the calling agent',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
      },
    },
    async ({ agent_token }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      const { agentId, orchestrator } = resolved;

      const sessions = orchestrator.listSessions();
      const relevantSessions = sessions.filter(
        (s) => s.leadAgentId === agentId || s.phase === 'discussion' || s.phase === 'refinement' || s.phase === 'voting',
      );

      const context = relevantSessions.map((s) => {
        const msgs = orchestrator.getMessages(s.id);
        const recentMsgs = msgs.slice(-5);
        const amendments = msgs.filter((m) => m.messageType === 'amendment');
        return {
          sessionId: s.id,
          title: s.title,
          phase: s.phase,
          isLead: s.leadAgentId === agentId,
          deliberationRound: s.deliberationRound,
          activeProposalId: s.activeProposalId,
          pendingAmendments: amendments.filter((a) => a.amendmentStatus === 'proposed').length,
          acceptedAmendments: amendments.filter((a) => a.amendmentStatus === 'accepted').length,
          recentMessages: recentMsgs.map((m) => ({
            from: m.fromAgentId,
            to: m.toAgentId,
            type: m.messageType,
            content: m.content.substring(0, 500),
          })),
        };
      });

      return {
        content: [{ type: 'text', text: JSON.stringify(context, null, 2) }],
      };
    },
  );

  // ── Tool: council_get_session ──
  server.registerTool(
    'council_get_session',
    {
      description: 'Get full session details including messages, votes, and current phase',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID to retrieve'),
      },
    },
    async ({ agent_token, session_id }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      const { orchestrator } = resolved;

      const session = orchestrator.getSession(session_id);
      if (!session) {
        return { content: [{ type: 'text', text: 'Error: Session not found' }], isError: true };
      }

      const messages = orchestrator.getMessages(session_id);
      const votes = orchestrator.getVotes(session_id);
      const decision = orchestrator.getDecision(session_id);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ session, messages, votes, decision }, null, 2),
        }],
      };
    },
  );

  // ── Tool: council_send_message ──
  server.registerTool(
    'council_send_message',
    {
      description: 'Send a message to a specific agent or broadcast to all (graph-enforced)',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        content: z.string().describe('Message content'),
        to_agent_id: z.string().optional().describe('Target agent ID (omit for broadcast)'),
      },
    },
    async ({ agent_token, session_id, content, to_agent_id }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const message = resolved.orchestrator.sendMessage(session_id, resolved.agentId, to_agent_id ?? null, content);
      return {
        content: [{ type: 'text', text: JSON.stringify({ messageId: message.id, status: 'sent' }) }],
      };
    },
  );

  // ── Tool: council_consult_agent ──
  server.registerTool(
    'council_consult_agent',
    {
      description: 'Request input from another board member. Council spawns them if needed.',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        target_agent_id: z.string().describe('Agent ID to consult'),
        question: z.string().describe('The question or request for the consulted agent'),
      },
    },
    async ({ agent_token, session_id, target_agent_id, question }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const message = await resolved.orchestrator.consultAgent(session_id, resolved.agentId, target_agent_id, question);
      return {
        content: [{ type: 'text', text: JSON.stringify({ messageId: message.id, status: 'consultation_sent' }) }],
      };
    },
  );

  // ── Tool: council_create_proposal ──
  server.registerTool(
    'council_create_proposal',
    {
      description: 'Create a formal proposal for the board to deliberate',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        proposal: z.string().describe('The proposal content'),
      },
    },
    async ({ agent_token, session_id, proposal }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      try {
        const message = resolved.orchestrator.createProposal(session_id, resolved.agentId, proposal);
        return {
          content: [{ type: 'text', text: JSON.stringify({ messageId: message.id, status: 'proposal_created' }) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_submit_findings ──
  server.registerTool(
    'council_submit_findings',
    {
      description: 'Submit investigation results to a session',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        findings: z.string().describe('Investigation findings'),
      },
    },
    async ({ agent_token, session_id, findings }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const message = resolved.orchestrator.submitFindings(session_id, resolved.agentId, findings);
      return {
        content: [{ type: 'text', text: JSON.stringify({ messageId: message.id, status: 'findings_submitted' }) }],
      };
    },
  );

  // ── Tool: council_cast_vote ──
  server.registerTool(
    'council_cast_vote',
    {
      description: 'Vote on a proposal. Valid values depend on the voting scheme: approve/reject/abstain (majority, supermajority, unanimous, advisory) or consent/object/abstain (consent-based). Use council_get_voting_info to check.',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        vote: z.enum(['approve', 'reject', 'abstain', 'consent', 'object']).describe('Your vote (valid values depend on the council voting scheme)'),
        reasoning: z.string().describe('Reasoning for your vote'),
      },
    },
    async ({ agent_token, session_id, vote, reasoning }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      try {
        const voteResult = resolved.orchestrator.castVote(session_id, resolved.agentId, vote, reasoning);
        return {
          content: [{ type: 'text', text: JSON.stringify({ voteId: voteResult.id, status: 'vote_cast' }) }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_list_sessions ──
  server.registerTool(
    'council_list_sessions',
    {
      description: 'List sessions with optional phase filter',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        phase: z.enum(['investigation', 'proposal', 'discussion', 'refinement', 'voting', 'review', 'decided', 'closed'])
          .optional()
          .describe('Filter by phase'),
      },
    },
    async ({ agent_token, phase }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const sessions = resolved.orchestrator.listSessions(phase);
      return {
        content: [{ type: 'text', text: JSON.stringify(sessions, null, 2) }],
      };
    },
  );

  // ── Tool: council_list_councils ──
  server.registerTool(
    'council_list_councils',
    {
      description: 'List available councils',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
      },
    },
    async ({ agent_token }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const allCouncils = registry.list().map(({ councilId, entry }) => ({
        id: councilId,
        name: entry.config.council.name,
        description: entry.config.council.description,
        agents: entry.config.council.agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
      }));

      return {
        content: [{ type: 'text', text: JSON.stringify(allCouncils, null, 2) }],
      };
    },
  );

  // ── Tool: council_propose_amendment ──
  server.registerTool(
    'council_propose_amendment',
    {
      description: 'Propose an amendment to the active proposal during the refinement phase. Describe the specific change you want to make.',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        amendment: z.string().describe('The proposed amendment — describe what should change and why'),
        parent_message_id: z.string().optional().describe('The proposal message ID to amend (defaults to active proposal)'),
      },
    },
    async ({ agent_token, session_id, amendment, parent_message_id }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      try {
        const message = resolved.orchestrator.proposeAmendment(session_id, resolved.agentId, amendment, parent_message_id);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              amendmentId: message.id,
              status: 'amendment_proposed',
              amendmentStatus: message.amendmentStatus,
              parentMessageId: message.parentMessageId,
            }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_resolve_amendment ──
  server.registerTool(
    'council_resolve_amendment',
    {
      description: 'Accept or reject a proposed amendment (lead agent or agents with proposal rights only)',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        amendment_id: z.string().describe('The amendment message ID to resolve'),
        action: z.enum(['accept', 'reject']).describe('Whether to accept or reject the amendment'),
      },
    },
    async ({ agent_token, session_id, amendment_id, action }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      try {
        resolved.orchestrator.resolveAmendment(session_id, resolved.agentId, amendment_id, action);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify({ amendmentId: amendment_id, status: `amendment_${action}ed` }),
          }],
        };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  // ── Tool: council_get_voting_info ──
  server.registerTool(
    'council_get_voting_info',
    {
      description: 'Get the voting scheme and valid vote values for this council',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
      },
    },
    async ({ agent_token }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }

      const config = resolved.orchestrator.getConfig();
      const scheme = createVotingScheme(config.council.rules.voting_scheme);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            scheme: scheme.name,
            validVoteValues: scheme.validVoteValues(),
            quorum: config.council.rules.quorum,
            votingThreshold: config.council.rules.voting_threshold,
          }, null, 2),
        }],
      };
    },
  );

  // ── Tool: council_get_assignments ──
  server.registerTool(
    'council_get_assignments',
    {
      description: 'Get current session assignments for a persistent agent. Returns all active sessions the agent is participating in.',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
      },
    },
    async ({ agent_token }) => {
      const resolved = resolveToken(agent_token);
      if (!resolved) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      const { agentId, agentRegistry, orchestrator } = resolved;

      const sessionIds = agentRegistry.getActiveSessions(agentId);
      const assignments = sessionIds.map((sid) => {
        const session = orchestrator.getSession(sid);
        if (!session) return null;
        return {
          sessionId: sid,
          title: session.title,
          phase: session.phase,
          role: session.leadAgentId === agentId ? 'lead' : 'consulted',
        };
      }).filter(Boolean);

      return {
        content: [{ type: 'text', text: JSON.stringify(assignments, null, 2) }],
      };
    },
  );

}

/**
 * Create a fresh McpServer with all tools registered.
 * Each MCP session gets its own server instance because
 * McpServer only supports a single transport connection.
 */
function createServerInstance(registry: OrchestratorRegistry): McpServer {
  const server = new McpServer({
    name: 'council',
    version: '0.1.0',
  }, {
    instructions: 'Council MCP server. Connect with your agent token to participate in deliberations.',
  });
  registerTools(server, registry);
  return server;
}

export interface McpRouterResult {
  router: Router;
  notifyAgent: (agentId: string, assignment: SessionAssignment) => Promise<boolean>;
}

/**
 * Create the MCP Express router for the /mcp endpoint.
 * Supports multiple concurrent agent connections, each with
 * its own McpServer + StreamableHTTPServerTransport pair.
 */
export function createMcpRouter(registry: OrchestratorRegistry): McpRouterResult {
  const router = createRouter();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const servers = new Map<string, McpServer>();

  // Persistent agent connections keyed by agentId
  const persistentConnections = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport; mcpSessionId: string }>();

  // ── Express routes ──

  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId) {
      const server = createServerInstance(registry);
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          servers.set(id, server);
          // Try to identify the agent from the init request
          const token = req.headers['x-agent-token'] as string | undefined;
          if (token) {
            const result = registry.resolveAgentToken(token);
            if (result) {
              result.entry.agentRegistry.connect(result.agentId);
              // Track persistent agent connections
              if (result.entry.agentRegistry.isPersistent(result.agentId)) {
                persistentConnections.set(result.agentId, { server, transport, mcpSessionId: id });
              }
            }
          }
        },
        onsessionclosed: (id) => {
          transports.delete(id);
          servers.delete(id);
          // Clean up persistent connection if this was one
          for (const [agentId, conn] of persistentConnections) {
            if (conn.mcpSessionId === id) {
              persistentConnections.delete(agentId);
              break;
            }
          }
        },
      });
      await server.connect(transport);
    } else {
      // Check if this is a persistent agent reconnecting with a stale session
      const token = req.headers['x-agent-token'] as string | undefined;
      if (token) {
        const result = registry.resolveAgentToken(token);
        if (result && result.entry.agentRegistry.isPersistent(result.agentId)) {
          // Replace stale transport with new connection
          const server = createServerInstance(registry);
          transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
              transports.set(id, transport);
              servers.set(id, server);
              result.entry.agentRegistry.connect(result.agentId);
              persistentConnections.set(result.agentId, { server, transport, mcpSessionId: id });
            },
            onsessionclosed: (id) => {
              transports.delete(id);
              servers.delete(id);
              persistentConnections.delete(result.agentId);
            },
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);
          return;
        }
      }
      res.status(400).json({ error: 'Invalid session' });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  router.get('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
  });

  router.delete('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      res.status(400).json({ error: 'Invalid session' });
      return;
    }
    await transports.get(sessionId)!.handleRequest(req, res);
    transports.delete(sessionId);
    servers.delete(sessionId);
  });

  async function notifyAgent(agentId: string, assignment: SessionAssignment): Promise<boolean> {
    const conn = persistentConnections.get(agentId);
    if (!conn) return false;
    try {
      await conn.server.server.sendLoggingMessage({
        level: 'info',
        logger: 'council',
        data: { type: 'session_assigned', ...assignment },
      });
      return true;
    } catch {
      return false;
    }
  }

  return { router, notifyAgent };
}
