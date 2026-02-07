import { describe, it, expect, beforeEach } from 'vitest';
import { Orchestrator, type OrchestratorStore, type OrchestratorEvent } from '@/engine/orchestrator.js';
import { EventRouter } from '@/engine/event-router.js';
import { MessageBus } from '@/engine/message-bus.js';
import { AgentRegistry } from '@/engine/agent-registry.js';
import { LogWebhookSpawner } from '@/engine/spawner.js';
import type { CouncilConfig, Session, Message, Vote, Decision, IncomingEvent, EscalationEvent } from '@/shared/types.js';

function createMockStore(): OrchestratorStore {
  const sessions = new Map<string, Session>();
  const messagesBySession = new Map<string, Message[]>();
  const voteMap = new Map<string, Vote[]>();
  const decisionMap = new Map<string, Decision>();
  const eventList: IncomingEvent[] = [];
  const escalationEvents: EscalationEvent[] = [];

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
      const list = messagesBySession.get(m.sessionId) ?? [];
      list.push(m);
      messagesBySession.set(m.sessionId, list);
    },
    updateMessage: (id, updates) => {
      for (const [, msgs] of messagesBySession) {
        const msg = msgs.find((m) => m.id === id);
        if (msg) {
          Object.assign(msg, updates);
          break;
        }
      }
    },
    getMessages: (sid) => messagesBySession.get(sid) ?? [],
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
    saveEscalationEvent: (e) => escalationEvents.push(e),
    getEscalationEvents: (sid) => escalationEvents.filter((e) => e.sessionId === sid),
  };
}

const baseConfig: CouncilConfig = {
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
      enable_refinement: true,
      max_amendments: 10,
      amendment_resolution: 'lead_resolves',
    },
    agents: [
      { id: 'lead', name: 'Lead', role: 'Lead', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
      { id: 'reviewer', name: 'Reviewer', role: 'Reviewer', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
      { id: 'observer', name: 'Observer', role: 'Observer', expertise: [], can_propose: false, can_veto: false, voting_weight: 1, system_prompt: '' },
    ],
    communication_graph: { default_policy: 'broadcast', edges: {} },
    event_routing: [],
  },
};

function makeOrchestrator(config: CouncilConfig = baseConfig) {
  const store = createMockStore();
  const eventRouter = new EventRouter(config.council.event_routing);
  const messageBus = new MessageBus(config.council.communication_graph);
  const agentRegistry = new AgentRegistry();
  agentRegistry.loadAgents(config.council.agents);

  const orchestrator = new Orchestrator({
    config,
    councilId: 'test-council',
    eventRouter,
    messageBus,
    agentRegistry,
    spawner: new LogWebhookSpawner(),
    store,
    mcpBaseUrl: 'http://localhost:3000/mcp',
  });

  return { orchestrator, store };
}

describe('Refinement phase transitions', () => {
  it('allows discussion -> refinement transition', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'refinement');
    expect(orchestrator.getSession(session.id)!.phase).toBe('refinement');
  });

  it('allows refinement -> voting transition', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'refinement');
    orchestrator.transitionPhase(session.id, 'voting');
    expect(orchestrator.getSession(session.id)!.phase).toBe('voting');
  });

  it('allows refinement -> discussion transition', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'refinement');
    orchestrator.transitionPhase(session.id, 'discussion');
    expect(orchestrator.getSession(session.id)!.phase).toBe('discussion');
  });

  it('allows voting -> refinement transition', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');
    orchestrator.transitionPhase(session.id, 'refinement');
    expect(orchestrator.getSession(session.id)!.phase).toBe('refinement');
  });

  it('allows review -> refinement transition', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');
    orchestrator.transitionPhase(session.id, 'review');
    orchestrator.transitionPhase(session.id, 'refinement');
    expect(orchestrator.getSession(session.id)!.phase).toBe('refinement');
  });

  it('rejects refinement transitions when enable_refinement is false', () => {
    const config = structuredClone(baseConfig);
    config.council.rules.enable_refinement = false;
    const { orchestrator } = makeOrchestrator(config);
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    expect(() => orchestrator.transitionPhase(session.id, 'refinement')).toThrow('Invalid transition');
  });

  it('auto-refines on vote rejection (non-veto) when refinement enabled', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'voting');

    // All reject -> rejected outcome, no veto -> auto-refine
    orchestrator.castVote(session.id, 'lead', 'reject', 'Needs changes');
    orchestrator.castVote(session.id, 'reviewer', 'reject', 'Agreed');
    orchestrator.castVote(session.id, 'observer', 'reject', 'Same');

    expect(orchestrator.getSession(session.id)!.phase).toBe('refinement');
    // No decision created because we went to refinement
    expect(orchestrator.getDecision(session.id)).toBeNull();
  });
});

describe('proposeAmendment', () => {
  it('creates an amendment message linked to the active proposal', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Original proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Change X to Y');
    expect(amendment.messageType).toBe('amendment');
    expect(amendment.amendmentStatus).toBe('proposed');
    expect(amendment.parentMessageId).not.toBeNull();
  });

  it('rejects amendments outside refinement phase', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    // Now in discussion phase
    expect(() => orchestrator.proposeAmendment(session.id, 'reviewer', 'Amendment')).toThrow('Cannot propose amendments');
  });

  it('enforces max_amendments limit', () => {
    const config = structuredClone(baseConfig);
    config.council.rules.max_amendments = 2;
    const { orchestrator } = makeOrchestrator(config);
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    orchestrator.proposeAmendment(session.id, 'reviewer', 'Amendment 1');
    orchestrator.proposeAmendment(session.id, 'observer', 'Amendment 2');
    expect(() => orchestrator.proposeAmendment(session.id, 'lead', 'Amendment 3')).toThrow('Maximum amendments');
  });

  it('auto-accepts when amendment_resolution is auto_accept', () => {
    const config = structuredClone(baseConfig);
    config.council.rules.amendment_resolution = 'auto_accept';
    const { orchestrator } = makeOrchestrator(config);
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Auto-accepted');
    expect(amendment.amendmentStatus).toBe('accepted');
  });

  it('requires an active proposal', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'proposal' });
    orchestrator.transitionPhase(session.id, 'discussion');
    orchestrator.transitionPhase(session.id, 'refinement');
    // No proposal created, so activeProposalId is null
    expect(() => orchestrator.proposeAmendment(session.id, 'reviewer', 'Amendment')).toThrow('No active proposal');
  });
});

describe('resolveAmendment', () => {
  it('allows lead agent to accept an amendment', () => {
    const { orchestrator, store } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Change this');
    orchestrator.resolveAmendment(session.id, 'lead', amendment.id, 'accept');

    const messages = orchestrator.getMessages(session.id);
    const resolved = messages.find((m) => m.id === amendment.id);
    expect(resolved!.amendmentStatus).toBe('accepted');
  });

  it('allows agents with can_propose to resolve amendments', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'observer', 'Change this');
    // 'reviewer' has can_propose: true
    orchestrator.resolveAmendment(session.id, 'reviewer', amendment.id, 'reject');

    const messages = orchestrator.getMessages(session.id);
    const resolved = messages.find((m) => m.id === amendment.id);
    expect(resolved!.amendmentStatus).toBe('rejected');
  });

  it('rejects resolution by agents without rights', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Change this');
    // 'observer' has can_propose: false and is not lead
    expect(() => orchestrator.resolveAmendment(session.id, 'observer', amendment.id, 'accept')).toThrow('does not have rights');
  });

  it('rejects resolution of already-resolved amendments', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Change this');
    orchestrator.resolveAmendment(session.id, 'lead', amendment.id, 'accept');
    expect(() => orchestrator.resolveAmendment(session.id, 'lead', amendment.id, 'reject')).toThrow('already accepted');
  });

  it('emits amendment:resolved event', () => {
    const { orchestrator } = makeOrchestrator();
    const events: OrchestratorEvent[] = [];
    orchestrator.onEvent((e) => events.push(e));

    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Proposal');
    orchestrator.transitionPhase(session.id, 'refinement');

    const amendment = orchestrator.proposeAmendment(session.id, 'reviewer', 'Change this');
    orchestrator.resolveAmendment(session.id, 'lead', amendment.id, 'accept');

    const resolvedEvents = events.filter((e) => e.type === 'amendment:resolved');
    expect(resolvedEvents).toHaveLength(1);
    expect(resolvedEvents[0]).toMatchObject({
      type: 'amendment:resolved',
      sessionId: session.id,
      amendmentId: amendment.id,
      status: 'accepted',
    });
  });
});

describe('synthesizeRefinedProposal', () => {
  it('creates refined proposal with accepted amendments on transition to voting', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    const proposal = orchestrator.createProposal(session.id, 'lead', 'Original proposal content');
    orchestrator.transitionPhase(session.id, 'refinement');

    const a1 = orchestrator.proposeAmendment(session.id, 'reviewer', 'Add section A');
    orchestrator.resolveAmendment(session.id, 'lead', a1.id, 'accept');

    const a2 = orchestrator.proposeAmendment(session.id, 'observer', 'Remove section B');
    orchestrator.resolveAmendment(session.id, 'lead', a2.id, 'reject');

    orchestrator.transitionPhase(session.id, 'voting');

    // Should have a refined proposal message
    const messages = orchestrator.getMessages(session.id);
    const refined = messages.filter((m) => m.messageType === 'proposal');
    expect(refined.length).toBeGreaterThanOrEqual(2); // Original + refined
    const lastProposal = refined[refined.length - 1];
    expect(lastProposal.content).toContain('Refined Proposal');
    expect(lastProposal.content).toContain('Original proposal content');
    expect(lastProposal.content).toContain('Add section A');
    expect(lastProposal.content).not.toContain('Remove section B');
  });

  it('does not create refined proposal when no amendments accepted', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Original');
    orchestrator.transitionPhase(session.id, 'refinement');

    const a1 = orchestrator.proposeAmendment(session.id, 'reviewer', 'Bad idea');
    orchestrator.resolveAmendment(session.id, 'lead', a1.id, 'reject');

    orchestrator.transitionPhase(session.id, 'voting');

    const messages = orchestrator.getMessages(session.id);
    const proposals = messages.filter((m) => m.messageType === 'proposal');
    expect(proposals).toHaveLength(1); // Only original
  });

  it('updates activeProposalId to the refined proposal', () => {
    const { orchestrator } = makeOrchestrator();
    const session = orchestrator.createSession({ title: 'Test', phase: 'investigation' });
    const proposal = orchestrator.createProposal(session.id, 'lead', 'Original');

    const originalProposalId = orchestrator.getSession(session.id)!.activeProposalId;
    expect(originalProposalId).toBe(proposal.id);

    orchestrator.transitionPhase(session.id, 'refinement');
    const a1 = orchestrator.proposeAmendment(session.id, 'reviewer', 'Fix it');
    orchestrator.resolveAmendment(session.id, 'lead', a1.id, 'accept');
    orchestrator.transitionPhase(session.id, 'voting');

    const updatedSession = orchestrator.getSession(session.id);
    expect(updatedSession!.activeProposalId).not.toBe(originalProposalId);
  });
});

describe('Full refinement flow', () => {
  it('proposal -> discussion -> refinement -> voting -> review', () => {
    const { orchestrator } = makeOrchestrator();

    // Create session and proposal
    const session = orchestrator.createSession({ title: 'Full flow', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Upgrade Node.js to v22');
    expect(orchestrator.getSession(session.id)!.phase).toBe('discussion');

    // Discussion -> refinement
    orchestrator.transitionPhase(session.id, 'refinement');

    // Propose and resolve amendments
    const a1 = orchestrator.proposeAmendment(session.id, 'reviewer', 'Pin >= 22.4 for CVE fix');
    orchestrator.resolveAmendment(session.id, 'lead', a1.id, 'accept');

    // Refinement -> voting (synthesizes refined proposal)
    orchestrator.transitionPhase(session.id, 'voting');

    // All approve
    orchestrator.castVote(session.id, 'lead', 'approve', 'LGTM');
    orchestrator.castVote(session.id, 'reviewer', 'approve', 'Good');
    orchestrator.castVote(session.id, 'observer', 'approve', 'Fine');

    // Should be in review
    expect(orchestrator.getSession(session.id)!.phase).toBe('review');
    const decision = orchestrator.getDecision(session.id);
    expect(decision!.outcome).toBe('approved');
  });

  it('vote rejection triggers refinement loop', () => {
    const { orchestrator } = makeOrchestrator();

    const session = orchestrator.createSession({ title: 'Rejection flow', phase: 'investigation' });
    orchestrator.createProposal(session.id, 'lead', 'Initial proposal');
    orchestrator.transitionPhase(session.id, 'voting');

    // All reject -> auto-refine
    orchestrator.castVote(session.id, 'lead', 'reject', 'Needs work');
    orchestrator.castVote(session.id, 'reviewer', 'reject', 'Bad idea');
    orchestrator.castVote(session.id, 'observer', 'reject', 'No');

    expect(orchestrator.getSession(session.id)!.phase).toBe('refinement');

    // Amend and try again
    const a1 = orchestrator.proposeAmendment(session.id, 'reviewer', 'Fix the issue');
    orchestrator.resolveAmendment(session.id, 'lead', a1.id, 'accept');
    orchestrator.transitionPhase(session.id, 'voting');

    expect(orchestrator.getSession(session.id)!.phase).toBe('voting');
  });
});
