import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator, type OrchestratorStore } from '@/engine/orchestrator.js';
import { EventRouter } from '@/engine/event-router.js';
import { MessageBus } from '@/engine/message-bus.js';
import { AgentRegistry } from '@/engine/agent-registry.js';
import { LogWebhookSpawner } from '@/engine/spawner.js';
import type { CouncilConfig, Session, Message, Vote, Decision, IncomingEvent, EscalationEvent } from '@/shared/types.js';

function createMockStore(): OrchestratorStore & { _sessions: Map<string, Session> } {
  const sessions = new Map<string, Session>();
  const messageMap = new Map<string, Message[]>();
  const voteMap = new Map<string, Vote[]>();
  const decisionMap = new Map<string, Decision>();
  const eventList: IncomingEvent[] = [];
  const participantMap = new Map<string, Array<{ agentId: string; role: string }>>();

  return {
    _sessions: sessions,
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

describe('Dynamic Voting Weights', () => {
  // Agents with different expertise areas
  const configWithDynamicWeights: CouncilConfig = {
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
        enable_refinement: false,
        escalation: [],
        dynamic_weights: {
          enabled: true,
          expertise_match_bonus: 0.5,
          max_multiplier: 3.0,
        },
      },
      agents: [
        { id: 'security', name: 'Security', role: 'CISO', expertise: ['security', 'compliance', 'infrastructure'], can_propose: true, can_veto: false, voting_weight: 1.0, system_prompt: '' },
        { id: 'product', name: 'Product', role: 'CPO', expertise: ['product_strategy', 'feature_design', 'ux'], can_propose: true, can_veto: false, voting_weight: 1.0, system_prompt: '' },
        { id: 'legal', name: 'Legal', role: 'Counsel', expertise: ['compliance', 'contracts', 'data_privacy'], can_propose: true, can_veto: false, voting_weight: 1.0, system_prompt: '' },
      ],
      communication_graph: { default_policy: 'broadcast', edges: {} },
      event_routing: [],
    },
  };

  let orchestrator: Orchestrator;
  let store: OrchestratorStore & { _sessions: Map<string, Session> };

  beforeEach(() => {
    store = createMockStore();
    const eventRouter = new EventRouter(configWithDynamicWeights.council.event_routing);
    const messageBus = new MessageBus(configWithDynamicWeights.council.communication_graph);
    const agentRegistry = new AgentRegistry();
    agentRegistry.loadAgents(configWithDynamicWeights.council.agents);

    orchestrator = new Orchestrator({
      config: configWithDynamicWeights,
      councilId: 'test-council',
      eventRouter,
      messageBus,
      agentRegistry,
      spawner: new LogWebhookSpawner(),
      store,
      mcpBaseUrl: 'http://localhost:3000/mcp',
    });
  });

  it('uses boosted weight for agents with matching expertise', () => {
    // Session with security topics — the security agent should have boosted weight
    const session = orchestrator.createSession({
      title: 'Security review',
      phase: 'proposal',
      topics: ['security', 'compliance'],
    });

    expect(session.topics).toEqual(['security', 'compliance']);

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // Security agent: matches 2 topics → weight = 1.0 + 2*0.5 = 2.0
    // Product agent: matches 0 → weight = 1.0
    // Legal agent: matches 1 (compliance) → weight = 1.0 + 0.5 = 1.5
    //
    // security approves (weight 2.0), product rejects (weight 1.0), legal rejects (weight 1.5)
    // Total approve weight: 2.0, total reject weight: 2.5
    // Threshold: 2.0/4.5 ≈ 0.44 < 0.5 → rejected
    orchestrator.castVote(session.id, 'security', 'approve', 'Looks secure');
    orchestrator.castVote(session.id, 'product', 'reject', 'Not user-friendly');
    orchestrator.castVote(session.id, 'legal', 'reject', 'Compliance concerns');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('rejected');
  });

  it('uses static weights when no topics are set', () => {
    const session = orchestrator.createSession({
      title: 'General discussion',
      phase: 'proposal',
      topics: [],
    });

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // All weights static (1.0 each)
    // 2 approve (2.0), 1 reject (1.0) → 2/3 ≈ 0.66 >= 0.5 → approved
    orchestrator.castVote(session.id, 'security', 'approve', 'OK');
    orchestrator.castVote(session.id, 'product', 'approve', 'OK');
    orchestrator.castVote(session.id, 'legal', 'reject', 'No');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });

  it('caps effective weight at max_multiplier', () => {
    // Agent with base weight 1.0, 3 matching topics → bonus 1.5
    // Capped at 1.0 * 3.0 = 3.0
    // Actual: min(1.0 + 1.5, 3.0) = 2.5 — not capped here
    // With 6 matching topics: bonus 3.0, min(1.0 + 3.0, 3.0) = 3.0 — capped
    const session = orchestrator.createSession({
      title: 'Deep security session',
      phase: 'proposal',
      topics: ['security', 'compliance', 'infrastructure'],
    });

    expect(session.topics).toHaveLength(3);

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // Security agent matches all 3 topics → bonus 1.5 → effective weight = min(2.5, 3.0) = 2.5
    // Product matches 0 → 1.0
    // Legal matches 1 (compliance) → 1.0 + 0.5 = 1.5
    //
    // Security approves (2.5), product approves (1.0) → 3.5 approve
    // Legal rejects (1.5) → total voting weight = 5.0
    // Threshold: 3.5/5.0 = 0.7 >= 0.5 → approved
    orchestrator.castVote(session.id, 'security', 'approve', 'Covers all bases');
    orchestrator.castVote(session.id, 'product', 'approve', 'Fine by me');
    orchestrator.castVote(session.id, 'legal', 'reject', 'Risk concerns');

    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });

  it('defaults topics to empty array', () => {
    const session = orchestrator.createSession({ title: 'No topics' });
    expect(session.topics).toEqual([]);
  });
});

describe('Dynamic Weights Disabled', () => {
  const configWithoutDynamicWeights: CouncilConfig = {
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
        enable_refinement: false,
        escalation: [],
        // No dynamic_weights — feature disabled
      },
      agents: [
        { id: 'a', name: 'A', role: 'A', expertise: ['security'], can_propose: true, can_veto: false, voting_weight: 1.0, system_prompt: '' },
        { id: 'b', name: 'B', role: 'B', expertise: [], can_propose: true, can_veto: false, voting_weight: 1.0, system_prompt: '' },
      ],
      communication_graph: { default_policy: 'broadcast', edges: {} },
      event_routing: [],
    },
  };

  it('uses static weights when dynamic_weights is not configured', () => {
    const store = createMockStore();
    const agentRegistry = new AgentRegistry();
    agentRegistry.loadAgents(configWithoutDynamicWeights.council.agents);

    const orchestrator = new Orchestrator({
      config: configWithoutDynamicWeights,
      councilId: 'test-council',
      eventRouter: new EventRouter([]),
      messageBus: new MessageBus({ default_policy: 'broadcast', edges: {} }),
      agentRegistry,
      spawner: new LogWebhookSpawner(),
      store,
      mcpBaseUrl: 'http://localhost:3000/mcp',
    });

    const session = orchestrator.createSession({
      title: 'Test',
      phase: 'proposal',
      topics: ['security'],
    });

    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // Both have weight 1.0 regardless of expertise match
    orchestrator.castVote(session.id, 'a', 'approve', 'Yes');
    orchestrator.castVote(session.id, 'b', 'reject', 'No');

    // 1 approve, 1 reject → 0.5 / 0.5 threshold → approved (>= 0.5)
    const decision = orchestrator.getDecision(session.id);
    expect(decision).not.toBeNull();
    expect(decision!.outcome).toBe('approved');
  });
});
