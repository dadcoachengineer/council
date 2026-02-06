import { nanoid } from 'nanoid';
import type {
  Session,
  SessionPhase,
  Message,
  Vote,
  Decision,
  CouncilConfig,
  AgentSpawner,
  IncomingEvent,
  DecisionOutcome,
} from '../shared/types.js';
import type { WebhookEvent } from '../shared/events.js';
import { EventRouter, type RouteResult } from './event-router.js';
import { MessageBus } from './message-bus.js';
import { AgentRegistry } from './agent-registry.js';
import { tallyVotes, allVotesCast } from './voting.js';

export type OrchestratorEvent =
  | { type: 'session:created'; session: Session }
  | { type: 'session:phase_changed'; sessionId: string; phase: SessionPhase }
  | { type: 'message:new'; message: Message }
  | { type: 'vote:cast'; vote: Vote }
  | { type: 'decision:pending_review'; decision: Decision }
  | { type: 'event:received'; event: IncomingEvent };

export type OrchestratorListener = (event: OrchestratorEvent) => void;

/**
 * Persistence interface for the orchestrator.
 * Implemented by the database layer.
 */
export interface OrchestratorStore {
  saveSession(session: Session): void;
  updateSession(id: string, updates: Partial<Session>): void;
  getSession(id: string): Session | null;
  listSessions(councilId?: string, phase?: SessionPhase): Session[];

  saveMessage(message: Message): void;
  getMessages(sessionId: string): Message[];

  saveVote(vote: Vote): void;
  getVotes(sessionId: string): Vote[];

  saveDecision(decision: Decision): void;
  getDecision(sessionId: string): Decision | null;
  updateDecision(id: string, updates: Partial<Decision>): void;
  listPendingDecisions(): Decision[];

  saveEvent(event: IncomingEvent): void;
  listEvents(councilId?: string, limit?: number): IncomingEvent[];
}

export class Orchestrator {
  private config: CouncilConfig;
  private councilId: string;
  private eventRouter: EventRouter;
  private messageBus: MessageBus;
  private agentRegistry: AgentRegistry;
  private spawner: AgentSpawner;
  private store: OrchestratorStore;
  private listeners = new Set<OrchestratorListener>();
  private mcpBaseUrl: string;

  constructor(opts: {
    config: CouncilConfig;
    councilId: string;
    eventRouter: EventRouter;
    messageBus: MessageBus;
    agentRegistry: AgentRegistry;
    spawner: AgentSpawner;
    store: OrchestratorStore;
    mcpBaseUrl: string;
  }) {
    this.config = opts.config;
    this.councilId = opts.councilId;
    this.eventRouter = opts.eventRouter;
    this.messageBus = opts.messageBus;
    this.agentRegistry = opts.agentRegistry;
    this.spawner = opts.spawner;
    this.store = opts.store;
    this.mcpBaseUrl = opts.mcpBaseUrl;

    // Wire message bus to persist all messages
    this.messageBus.subscribeAll((message) => {
      this.store.saveMessage(message);
      this.emit({ type: 'message:new', message });
    });
  }

  onEvent(listener: OrchestratorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(event: OrchestratorEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  // ── Event ingestion ──

  async handleWebhookEvent(event: WebhookEvent): Promise<Session | null> {
    const route = this.eventRouter.route(event);
    if (!route) {
      console.log(`[ORCHESTRATOR] No routing rule matched for ${event.source}:${event.eventType}`);
      return null;
    }

    const incomingEvent: IncomingEvent = {
      id: nanoid(),
      councilId: this.councilId,
      source: event.source,
      eventType: event.eventType,
      payload: event.payload,
      sessionId: null,
      createdAt: new Date().toISOString(),
    };

    // Create session
    const session = this.createSession({
      title: this.eventTitle(event),
      leadAgentId: route.lead,
      triggerEventId: incomingEvent.id,
      phase: 'investigation',
    });

    incomingEvent.sessionId = session.id;
    this.store.saveEvent(incomingEvent);
    this.emit({ type: 'event:received', event: incomingEvent });

    // Spawn lead agent
    await this.spawnAgent(session.id, route.lead, this.eventContext(event));

    // Spawn consulted agents
    for (const consultId of route.consult) {
      await this.spawnAgent(session.id, consultId, `You have been consulted for session ${session.id}. Use council_get_context to see details.`);
    }

    return session;
  }

  // ── Session management ──

  createSession(opts: {
    title: string;
    leadAgentId?: string | null;
    triggerEventId?: string | null;
    phase?: SessionPhase;
  }): Session {
    const session: Session = {
      id: nanoid(),
      councilId: this.councilId,
      title: opts.title,
      phase: opts.phase ?? 'proposal',
      leadAgentId: opts.leadAgentId ?? null,
      triggerEventId: opts.triggerEventId ?? null,
      deliberationRound: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.store.saveSession(session);
    this.emit({ type: 'session:created', session });
    return session;
  }

  getSession(id: string): Session | null {
    return this.store.getSession(id);
  }

  listSessions(phase?: SessionPhase): Session[] {
    return this.store.listSessions(this.councilId, phase);
  }

  // ── Phase transitions ──

  transitionPhase(sessionId: string, newPhase: SessionPhase): void {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const valid = this.validTransitions(session.phase);
    if (!valid.includes(newPhase)) {
      throw new Error(`Invalid transition: ${session.phase} → ${newPhase}`);
    }

    const updates: Partial<Session> = {
      phase: newPhase,
      updatedAt: new Date().toISOString(),
    };

    if (newPhase === 'discussion') {
      updates.deliberationRound = (session.deliberationRound ?? 0) + 1;
    }

    // Auto-create a placeholder decision when entering review without one
    if (newPhase === 'review' && !this.store.getDecision(sessionId)) {
      this.createDecision(sessionId, 'escalated', 'Manually advanced to review (no vote tally).');
    }

    this.store.updateSession(sessionId, updates);
    this.emit({ type: 'session:phase_changed', sessionId, phase: newPhase });
  }

  private validTransitions(current: SessionPhase): SessionPhase[] {
    const transitions: Record<SessionPhase, SessionPhase[]> = {
      investigation: ['proposal', 'closed'],
      proposal: ['discussion', 'closed'],
      discussion: ['voting', 'discussion', 'closed'], // Can loop for more rounds
      voting: ['review', 'discussion', 'closed'],     // Back to discussion if no consensus
      review: ['decided', 'discussion', 'closed'],    // Human can send back
      decided: ['closed'],
      closed: [],
    };
    return transitions[current] ?? [];
  }

  // ── Agent actions (called via MCP tools) ──

  submitFindings(sessionId: string, agentId: string, content: string): Message {
    const message: Message = {
      id: nanoid(),
      sessionId,
      fromAgentId: agentId,
      toAgentId: null,
      content,
      messageType: 'finding',
      createdAt: new Date().toISOString(),
    };
    this.messageBus.publish(message);
    return message;
  }

  createProposal(sessionId: string, agentId: string, content: string): Message {
    const agent = this.agentRegistry.getAgent(agentId);
    if (agent && !agent.can_propose) {
      throw new Error(`Agent ${agentId} does not have proposal rights`);
    }

    const message: Message = {
      id: nanoid(),
      sessionId,
      fromAgentId: agentId,
      toAgentId: null,
      content,
      messageType: 'proposal',
      createdAt: new Date().toISOString(),
    };
    this.messageBus.publish(message);

    // Auto-transition through phases toward discussion
    const session = this.store.getSession(sessionId);
    if (session) {
      if (session.phase === 'investigation') {
        this.transitionPhase(sessionId, 'proposal');
      }
      // Re-read in case we just transitioned
      const current = this.store.getSession(sessionId);
      if (current && current.phase === 'proposal') {
        this.transitionPhase(sessionId, 'discussion');
      }
    }

    return message;
  }

  sendMessage(sessionId: string, fromAgentId: string, toAgentId: string | null, content: string): Message {
    const message: Message = {
      id: nanoid(),
      sessionId,
      fromAgentId,
      toAgentId,
      content,
      messageType: toAgentId ? 'consultation' : 'discussion',
      createdAt: new Date().toISOString(),
    };
    this.messageBus.publish(message);
    return message;
  }

  async consultAgent(sessionId: string, requestingAgentId: string, targetAgentId: string, question: string): Promise<Message> {
    // Send consultation message
    const message = this.sendMessage(sessionId, requestingAgentId, targetAgentId, question);

    // Spawn the target agent if not connected
    if (!this.agentRegistry.isConnected(targetAgentId)) {
      await this.spawnAgent(
        sessionId,
        targetAgentId,
        `You have been consulted by ${requestingAgentId}. Question: ${question}. Use council_get_context to see the full session.`,
      );
    }

    return message;
  }

  castVote(sessionId: string, agentId: string, value: 'approve' | 'reject' | 'abstain', reasoning: string): Vote {
    const session = this.store.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (session.phase !== 'voting') {
      throw new Error(`Cannot vote in phase: ${session.phase}`);
    }

    // Check for duplicate vote
    const existingVotes = this.store.getVotes(sessionId);
    if (existingVotes.some((v) => v.agentId === agentId)) {
      throw new Error(`Agent ${agentId} has already voted on session ${sessionId}`);
    }

    const vote: Vote = {
      id: nanoid(),
      sessionId,
      agentId,
      value,
      reasoning,
      createdAt: new Date().toISOString(),
    };
    this.store.saveVote(vote);
    this.emit({ type: 'vote:cast', vote });

    // Check if all votes are in
    const allVotes = [...existingVotes, vote];
    const agentIds = this.config.council.agents.map((a) => a.id);
    if (allVotesCast(allVotes, agentIds)) {
      this.concludeVoting(sessionId, allVotes);
    }

    return vote;
  }

  private concludeVoting(sessionId: string, votes: Vote[]): void {
    const tally = tallyVotes(
      votes,
      this.config.council.agents,
      this.config.council.rules,
    );

    if (!tally.outcome) {
      // Deadlock - escalate to human
      this.createDecision(sessionId, 'escalated', 'Voting did not reach quorum.');
      return;
    }

    if (this.config.council.rules.require_human_approval) {
      // Create pending decision for human review
      this.createDecision(sessionId, tally.outcome, this.tallyToSummary(tally));
      this.transitionPhase(sessionId, 'review');
    } else {
      // Auto-decide
      this.createDecision(sessionId, tally.outcome, this.tallyToSummary(tally));
      this.transitionPhase(sessionId, 'decided');
    }
  }

  private createDecision(sessionId: string, outcome: DecisionOutcome, summary: string): Decision {
    const decision: Decision = {
      id: nanoid(),
      sessionId,
      outcome,
      summary,
      humanReviewedBy: null,
      humanNotes: null,
      createdAt: new Date().toISOString(),
    };
    this.store.saveDecision(decision);
    this.emit({ type: 'decision:pending_review', decision });
    return decision;
  }

  // ── Human review ──

  submitReview(
    sessionId: string,
    action: 'approve' | 'reject' | 'send_back',
    reviewedBy: string,
    notes?: string,
  ): void {
    const decision = this.store.getDecision(sessionId);
    if (!decision) throw new Error(`No decision found for session: ${sessionId}`);

    if (action === 'send_back') {
      this.store.updateDecision(decision.id, {
        humanReviewedBy: reviewedBy,
        humanNotes: notes ?? null,
      });
      this.transitionPhase(sessionId, 'discussion');
      return;
    }

    this.store.updateDecision(decision.id, {
      outcome: action === 'approve' ? 'approved' : 'rejected',
      humanReviewedBy: reviewedBy,
      humanNotes: notes ?? null,
    });
    this.transitionPhase(sessionId, 'decided');
  }

  // ── Queries ──

  getMessages(sessionId: string): Message[] {
    return this.store.getMessages(sessionId);
  }

  getVotes(sessionId: string): Vote[] {
    return this.store.getVotes(sessionId);
  }

  getDecision(sessionId: string): Decision | null {
    return this.store.getDecision(sessionId);
  }

  listPendingDecisions(): Decision[] {
    return this.store.listPendingDecisions();
  }

  listEvents(limit?: number): IncomingEvent[] {
    return this.store.listEvents(this.councilId, limit);
  }

  // ── Spawning helpers ──

  private async spawnAgent(sessionId: string, agentId: string, context: string): Promise<void> {
    const agentConfig = this.agentRegistry.getAgent(agentId);
    if (!agentConfig) {
      console.error(`[ORCHESTRATOR] Cannot spawn unknown agent: ${agentId}`);
      return;
    }

    const token = this.agentRegistry.generateToken(agentId);

    try {
      await this.spawner.spawn({
        sessionId,
        agentConfig,
        context,
        councilMcpUrl: this.mcpBaseUrl,
        agentToken: token,
      });
    } catch (err) {
      console.error(`[ORCHESTRATOR] Failed to spawn agent ${agentId}: ${(err as Error).message}`);
    }
  }

  // ── Helpers ──

  private eventTitle(event: WebhookEvent): string {
    if (event.source === 'github') {
      const gh = event.payload as { issue?: { title: string }; pull_request?: { title: string } };
      return gh.issue?.title ?? gh.pull_request?.title ?? `GitHub ${event.eventType}`;
    }
    return `Webhook: ${event.eventType}`;
  }

  private eventContext(event: WebhookEvent): string {
    return JSON.stringify(event.payload, null, 2);
  }

  private tallyToSummary(tally: ReturnType<typeof tallyVotes>): string {
    const parts = [
      `Approve: ${tally.approve}, Reject: ${tally.reject}, Abstain: ${tally.abstain}`,
      `Quorum: ${tally.quorumMet ? 'met' : 'not met'}`,
      `Threshold: ${tally.thresholdMet ? 'met' : 'not met'}`,
    ];
    if (tally.vetoExercised) parts.push('Veto exercised');
    return parts.join('. ');
  }

  getCouncilId(): string {
    return this.councilId;
  }

  getConfig(): CouncilConfig {
    return this.config;
  }

  getAgentRegistry(): AgentRegistry {
    return this.agentRegistry;
  }

  getMessageBus(): MessageBus {
    return this.messageBus;
  }
}
