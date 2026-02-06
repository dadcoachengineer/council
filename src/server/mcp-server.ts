import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import type { Router, Request, Response } from 'express';
import { Router as createRouter } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';

/**
 * Create the MCP server with all agent-facing tools and return
 * an Express router for the /mcp endpoint.
 */
export function createMcpRouter(orchestrator: Orchestrator): Router {
  const router = createRouter();
  const transports = new Map<string, StreamableHTTPServerTransport>();
  const registry = orchestrator.getAgentRegistry();

  const server = new McpServer({
    name: 'council',
    version: '0.1.0',
  }, {
    instructions: 'Council MCP server. Connect with your agent token to participate in deliberations.',
  });

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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const sessions = orchestrator.listSessions();
      const relevantSessions = sessions.filter(
        (s) => s.leadAgentId === agentId || s.phase === 'discussion' || s.phase === 'voting',
      );

      const context = relevantSessions.map((s) => {
        const msgs = orchestrator.getMessages(s.id);
        const recentMsgs = msgs.slice(-5);
        return {
          sessionId: s.id,
          title: s.title,
          phase: s.phase,
          isLead: s.leadAgentId === agentId,
          deliberationRound: s.deliberationRound,
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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const message = orchestrator.sendMessage(session_id, agentId, to_agent_id ?? null, content);
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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const message = await orchestrator.consultAgent(session_id, agentId, target_agent_id, question);
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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      try {
        const message = orchestrator.createProposal(session_id, agentId, proposal);
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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const message = orchestrator.submitFindings(session_id, agentId, findings);
      return {
        content: [{ type: 'text', text: JSON.stringify({ messageId: message.id, status: 'findings_submitted' }) }],
      };
    },
  );

  // ── Tool: council_cast_vote ──
  server.registerTool(
    'council_cast_vote',
    {
      description: 'Vote on a proposal (approve/reject/abstain with reasoning)',
      inputSchema: {
        agent_token: z.string().describe('Your agent authentication token'),
        session_id: z.string().describe('The session ID'),
        vote: z.enum(['approve', 'reject', 'abstain']).describe('Your vote'),
        reasoning: z.string().describe('Reasoning for your vote'),
      },
    },
    async ({ agent_token, session_id, vote, reasoning }) => {
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      try {
        const voteResult = orchestrator.castVote(session_id, agentId, vote, reasoning);
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
        phase: z.enum(['investigation', 'proposal', 'discussion', 'voting', 'review', 'decided', 'closed'])
          .optional()
          .describe('Filter by phase'),
      },
    },
    async ({ agent_token, phase }) => {
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const sessions = orchestrator.listSessions(phase);
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
      const agentId = registry.resolveToken(agent_token);
      if (!agentId) {
        return { content: [{ type: 'text', text: 'Error: Invalid agent token' }], isError: true };
      }
      registry.touch(agentId);

      const config = orchestrator.getConfig();
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            id: orchestrator.getCouncilId(),
            name: config.council.name,
            description: config.council.description,
            agents: config.council.agents.map((a) => ({ id: a.id, name: a.name, role: a.role })),
          }, null, 2),
        }],
      };
    },
  );

  // ── Express routes ──

  router.post('/', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
      transport = transports.get(sessionId)!;
    } else if (!sessionId) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, transport);
          // Try to identify the agent from the init request
          const token = req.headers['x-agent-token'] as string | undefined;
          if (token) {
            const agentId = registry.resolveToken(token);
            if (agentId) {
              registry.connect(agentId);
            }
          }
        },
        onsessionclosed: (id) => {
          transports.delete(id);
        },
      });
      await server.connect(transport);
    } else {
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
  });

  return router;
}
