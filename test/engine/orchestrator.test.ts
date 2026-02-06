import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator, type OrchestratorStore } from '@/engine/orchestrator.js';
import { EventRouter } from '@/engine/event-router.js';
import { MessageBus } from '@/engine/message-bus.js';
import { AgentRegistry } from '@/engine/agent-registry.js';
import { LogWebhookSpawner } from '@/engine/spawner.js';
import type { CouncilConfig, Session, Message, Vote, Decision, IncomingEvent } from '@/shared/types.js';

function createMockStore(): OrchestratorStore {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, Message[]>();
  const voteMap = new Map<string, Vote[]>();
  const decisionMap = new Map<string, Decision>();
  const eventList: IncomingEvent[] = [];

  return {
    saveSession: (s) => sessions.set(s.id, { ...s }),
    updateSession: (id, updates) => {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...updates });
    },
    getSession: (id) => sessions.get(id) ?? null,
    listSessions: (councilId, phase) => {
      let list = Array.from(sessions.values());
      if (councilId) list = list.filter((s) => s.councilId === councilId);
      if (phase) list = list.filter((s) => s.phase === phase);
      return list;
    },
    saveMessage: (m) => {
      const list = messages.get(m.sessionId) ?? [];
      list.push(m);
      messages.set(m.sessionId, list);
    },
    getMessages: (sid) => messages.get(sid) ?? [],
    saveVote: (v) => {
      const list = voteMap.get(v.sessionId) ?? [];
      list.push(v);
      voteMap.set(v.sessionId, list);
    },
    getVotes: (sid) => voteMap.get(sid) ?? [],
    saveDecision: (d) => decisionMap.set(d.sessionId, d),
    getDecision: (sid) => decisionMap.get(sid) ?? null,
    updateDecision: (id, updates) => {
      for (const [sid, d] of decisionMap) {
        if (d.id === id) {
          decisionMap.set(sid, { ...d, ...updates });
          break;
        }
      }
    },
    listPendingDecisions: () => {
      return Array.from(decisionMap.values()).filter((d) => {
        const s = sessions.get(d.sessionId);
        return s?.phase === 'review';
      });
    },
    saveEvent: (e) => eventList.push(e),
    listEvents: (_cid, limit = 50) => eventList.slice(0, limit),
  };
}

const config: CouncilConfig = {
  version: '1',
  council: {
    name: 'Test',
    description: 'Test council',
    spawner: { type: 'log' },
    rules: {
      quorum: 2,
      voting_threshold: 0.66,
      max_deliberation_rounds: 5,
      require_human_approval: true,
      escalation: [],
    },
    agents: [
      { id: 'cto', name: 'CTO', role: 'CTO', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'cto' },
      { id: 'cpo', name: 'CPO', role: 'CPO', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'cpo' },
    ],
    communication_graph: { default_policy: 'broadcast', edges: {} },
    event_routing: [
      { match: { source: 'github', type: 'issues.opened', labels: ['bug'] }, assign: { lead: 'cto', consult: ['cpo'] } },
    ],
  },
};

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let store: OrchestratorStore;

  beforeEach(() => {
    store = createMockStore();
    const eventRouter = new EventRouter(config.council.event_routing);
    const messageBus = new MessageBus(config.council.communication_graph);
    const agentRegistry = new AgentRegistry();
    agentRegistry.loadAgents(config.council.agents);

    orchestrator = new Orchestrator({
      config,
      councilId: 'test-council',
      eventRouter,
      messageBus,
      agentRegistry,
      spawner: new LogWebhookSpawner(),
      store,
      mcpBaseUrl: 'http://localhost:3000/mcp',
    });
  });

  it('creates a session', () => {
    const session = orchestrator.createSession({ title: 'Test session' });
    expect(session.title).toBe('Test session');
    expect(session.phase).toBe('proposal');

    const fetched = orchestrator.getSession(session.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('Test session');
  });

  it('transitions phases correctly', () => {
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');

    const updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('discussion');
    expect(updated!.deliberationRound).toBe(1);
  });

  it('rejects invalid phase transitions', () => {
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    expect(() => orchestrator.transitionPhase(session.id, 'decided')).toThrow('Invalid transition');
  });

  it('handles webhook events', async () => {
    const session = await orchestrator.handleWebhookEvent({
      source: 'github',
      eventType: 'issues.opened',
      payload: {
        action: 'opened',
        repository: { full_name: 'org/repo' },
        issue: {
          number: 1,
          title: 'Bug: something is broken',
          body: 'Details here',
          labels: [{ name: 'bug' }],
          html_url: 'https://github.com/org/repo/issues/1',
        },
        sender: { login: 'user' },
      },
    });

    expect(session).not.toBeNull();
    expect(session!.phase).toBe('investigation');
    expect(session!.leadAgentId).toBe('cto');
    expect(session!.title).toBe('Bug: something is broken');
  });

  it('returns null for unmatched webhook events', async () => {
    const session = await orchestrator.handleWebhookEvent({
      source: 'github',
      eventType: 'push',
      payload: {
        action: '',
        repository: { full_name: 'org/repo' },
        sender: { login: 'user' },
      },
    });
    expect(session).toBeNull();
  });

  it('handles proposal creation and phase transition', () => {
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    const msg = orchestrator.createProposal(session.id, 'cto', 'I propose we fix the bug');

    expect(msg.messageType).toBe('proposal');
    const updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('discussion');
  });

  it('handles voting and decision creation', () => {
    const session = orchestrator.createSession({ title: 'Vote test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    orchestrator.castVote(session.id, 'cto', 'approve', 'Looks good');
    orchestrator.castVote(session.id, 'cpo', 'approve', 'Agreed');

    const updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('review');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });

  it('prevents duplicate votes', () => {
    const session = orchestrator.createSession({ title: 'Dup test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    orchestrator.castVote(session.id, 'cto', 'approve', 'First vote');
    expect(() => orchestrator.castVote(session.id, 'cto', 'reject', 'Changed mind')).toThrow('already voted');
  });

  it('handles human review', () => {
    const session = orchestrator.createSession({ title: 'Review test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');
    orchestrator.castVote(session.id, 'cto', 'approve', 'Yes');
    orchestrator.castVote(session.id, 'cpo', 'approve', 'Yes');

    // Now in review phase
    orchestrator.submitReview(session.id, 'approve', 'admin', 'Ship it');

    const final = orchestrator.getSession(session.id);
    expect(final!.phase).toBe('decided');

    const decision = orchestrator.getDecision(session.id);
    expect(decision!.humanReviewedBy).toBe('admin');
    expect(decision!.humanNotes).toBe('Ship it');
  });
});
