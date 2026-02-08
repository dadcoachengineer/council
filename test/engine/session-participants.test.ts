import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator, type OrchestratorStore } from '@/engine/orchestrator.js';
import { EventRouter } from '@/engine/event-router.js';
import { MessageBus } from '@/engine/message-bus.js';
import { AgentRegistry } from '@/engine/agent-registry.js';
import { LogWebhookSpawner } from '@/engine/spawner.js';
import type { CouncilConfig, Session, Message, Vote, Decision, IncomingEvent, EscalationEvent } from '@/shared/types.js';

function createMockStore(): OrchestratorStore & {
  _sessions: Map<string, Session>;
  _participants: Map<string, Array<{ agentId: string; role: string }>>;
} {
  const sessions = new Map<string, Session>();
  const messageMap = new Map<string, Message[]>();
  const voteMap = new Map<string, Vote[]>();
  const decisionMap = new Map<string, Decision>();
  const eventList: IncomingEvent[] = [];
  const participantMap = new Map<string, Array<{ agentId: string; role: string }>>();

  return {
    _sessions: sessions,
    _participants: participantMap,
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
      const list = messageMap.get(m.sessionId) ?? [];
      list.push(m);
      messageMap.set(m.sessionId, list);
    },
    updateMessage: (id, updates) => {
      for (const [, msgs] of messageMap) {
        const msg = msgs.find((m) => m.id === id);
        if (msg) { Object.assign(msg, updates); break; }
      }
    },
    getMessages: (sid) => messageMap.get(sid) ?? [],
    saveVote: (v) => {
      const list = voteMap.get(v.sessionId) ?? [];
      list.push(v);
      voteMap.set(v.sessionId, list);
    },
    getVotes: (sid) => [...(voteMap.get(sid) ?? [])],
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
    saveEscalationEvent: () => {},
    getEscalationEvents: () => [],
    addSessionParticipant: (sessionId, agentId, role) => {
      const list = participantMap.get(sessionId) ?? [];
      if (!list.some(p => p.agentId === agentId)) {
        list.push({ agentId, role });
        participantMap.set(sessionId, list);
      }
    },
    getSessionParticipants: (sessionId) => participantMap.get(sessionId) ?? [],
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
      voting_threshold: 0.5,
      max_deliberation_rounds: 5,
      require_human_approval: true,
      escalation: [],
    },
    agents: [
      { id: 'cto', name: 'CTO', role: 'CTO', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
      { id: 'cpo', name: 'CPO', role: 'CPO', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
      { id: 'cfo', name: 'CFO', role: 'CFO', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
    ],
    communication_graph: { default_policy: 'broadcast', edges: {} },
    event_routing: [
      {
        match: { source: 'generic', type: 'feature' },
        assign: { lead: 'cto', consult: ['cpo'], topics: ['architecture'] },
      },
    ],
  },
};

describe('Session Participants', () => {
  let orchestrator: Orchestrator;
  let store: OrchestratorStore & {
    _sessions: Map<string, Session>;
    _participants: Map<string, Array<{ agentId: string; role: string }>>;
  };

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

  it('records lead agent as participant on session creation', () => {
    const session = orchestrator.createSession({
      title: 'Test',
      leadAgentId: 'cto',
    });

    const participants = store.getSessionParticipants(session.id);
    expect(participants).toHaveLength(1);
    expect(participants[0]).toEqual({ agentId: 'cto', role: 'lead' });
  });

  it('does not record participant when no lead is set', () => {
    const session = orchestrator.createSession({ title: 'Test' });

    const participants = store.getSessionParticipants(session.id);
    expect(participants).toHaveLength(0);
  });

  it('records consulted agents as participants during webhook handling', async () => {
    const session = await orchestrator.handleWebhookEvent({
      source: 'generic',
      eventType: 'feature',
      payload: { description: 'New feature request' },
    });

    expect(session).not.toBeNull();
    const participants = store.getSessionParticipants(session!.id);

    // Should have lead (cto) and consult (cpo)
    expect(participants).toHaveLength(2);
    expect(participants.find(p => p.agentId === 'cto')).toEqual({ agentId: 'cto', role: 'lead' });
    expect(participants.find(p => p.agentId === 'cpo')).toEqual({ agentId: 'cpo', role: 'consulted' });
  });

  it('concludes voting when all participants have voted (not all agents)', () => {
    // Create session with only 2 of 3 agents as participants
    const session = orchestrator.createSession({
      title: 'Participant-scoped vote',
      leadAgentId: 'cto',
      phase: 'proposal',
    });

    // Manually add cpo as participant
    store.addSessionParticipant(session.id, 'cpo', 'consulted');

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // Only cto and cpo are participants — cfo is NOT
    orchestrator.castVote(session.id, 'cto', 'approve', 'Yes');
    orchestrator.castVote(session.id, 'cpo', 'approve', 'Agreed');

    // Voting should conclude with 2 votes (from participants), not wait for cfo
    const updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('review');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });

  it('falls back to all agents when no participants are tracked', () => {
    // Create session without lead — no participants recorded
    const session = orchestrator.createSession({
      title: 'No participants',
      phase: 'proposal',
    });

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // Need all 3 agents to vote (fallback behavior)
    orchestrator.castVote(session.id, 'cto', 'approve', 'Yes');
    orchestrator.castVote(session.id, 'cpo', 'approve', 'Yes');

    // 2 of 3 agents voted — should NOT conclude yet
    let updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('voting');

    orchestrator.castVote(session.id, 'cfo', 'approve', 'Yes');

    // Now all 3 voted — should conclude
    updated = orchestrator.getSession(session.id);
    expect(updated!.phase).toBe('review');
  });

  it('passes topics from routing rule to session', async () => {
    const session = await orchestrator.handleWebhookEvent({
      source: 'generic',
      eventType: 'feature',
      payload: { description: 'New feature' },
    });

    expect(session).not.toBeNull();
    expect(session!.topics).toContain('architecture');
  });

  it('deduplicates participant entries', () => {
    const session = orchestrator.createSession({
      title: 'Test dedup',
      leadAgentId: 'cto',
    });

    // Try to add cto again
    store.addSessionParticipant(session.id, 'cto', 'consulted');

    const participants = store.getSessionParticipants(session.id);
    expect(participants).toHaveLength(1);
  });

  it('quorum checks work with participant count', () => {
    // quorum = 2, so even with 2 participants, we need 2 votes
    const session = orchestrator.createSession({
      title: 'Quorum test',
      leadAgentId: 'cto',
      phase: 'proposal',
    });
    store.addSessionParticipant(session.id, 'cpo', 'consulted');

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    orchestrator.castVote(session.id, 'cto', 'approve', 'Yes');
    orchestrator.castVote(session.id, 'cpo', 'approve', 'Yes');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });
});
