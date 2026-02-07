import { nanoid } from 'nanoid';
import type {
  CouncilConfig,
  EscalationRule,
  EscalationEvent,
  EscalationTriggerType,
  SessionPhase,
  DecisionOutcome,
} from '../shared/types.js';
import type { Orchestrator, OrchestratorEvent } from './orchestrator.js';

interface SessionTimerState {
  sessionId: string;
  phase: SessionPhase;
  startedAt: number;
  timeoutMs: number;
  timerId: ReturnType<typeof setTimeout>;
  ruleIndex: number;
}

export class EscalationEngine {
  private config: CouncilConfig;
  private orchestrator: Orchestrator;
  private timers = new Map<string, SessionTimerState[]>();
  private fireCounts = new Map<string, Map<number, number>>();
  private unsubscribe: (() => void) | null = null;

  constructor(config: CouncilConfig, orchestrator: Orchestrator) {
    this.config = config;
    this.orchestrator = orchestrator;
  }

  /** Start listening to orchestrator events. */
  start(): void {
    this.unsubscribe = this.orchestrator.onEvent((event: OrchestratorEvent) => {
      switch (event.type) {
        case 'session:phase_changed':
          this.onPhaseChanged(event.sessionId, event.phase);
          break;
        case 'session:created':
        case 'message:new':
        case 'vote:cast':
        case 'decision:pending_review':
        case 'event:received':
        case 'escalation:triggered':
          // No action needed for these events
          break;
      }
    });
  }

  /** Stop all timers and unsubscribe. */
  stop(): void {
    // Cancel all timers
    for (const [, timers] of this.timers) {
      for (const timer of timers) {
        clearTimeout(timer.timerId);
      }
    }
    this.timers.clear();
    this.fireCounts.clear();

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
  }

  /** Evaluate escalation rules for a session with a given trigger. */
  evaluate(sessionId: string, triggerType: EscalationTriggerType): void {
    const rules = this.getSortedRules();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.trigger.type !== triggerType) continue;

      // Check fire count limit
      const sessionFires = this.fireCounts.get(sessionId);
      const firedCount = sessionFires?.get(i) ?? 0;
      if (firedCount >= (rule.max_fires_per_session ?? 1)) continue;

      // Check phase filter for timeout rules
      if (rule.trigger.phases && rule.trigger.phases.length > 0) {
        const session = this.orchestrator.getSession(sessionId);
        if (session && !rule.trigger.phases.includes(session.phase)) continue;
      }

      // Rule matches — execute the action
      this.executeAction(sessionId, rule, i);

      if (rule.stop_after) break;
    }
  }

  /** Get active timers for a session (for debugging/UI). */
  getActiveTimers(sessionId: string): Array<{ phase: string; remainingMs: number; ruleName: string }> {
    const timers = this.timers.get(sessionId);
    if (!timers) return [];

    const now = Date.now();
    return timers.map((t) => ({
      phase: t.phase,
      remainingMs: Math.max(0, t.timeoutMs - (now - t.startedAt)),
      ruleName: this.getSortedRules()[t.ruleIndex]?.name ?? `rule_${t.ruleIndex}`,
    }));
  }

  /** Get escalation events for a session. */
  getEscalationEvents(sessionId: string): EscalationEvent[] {
    return this.orchestrator.getEscalationEvents(sessionId);
  }

  private onPhaseChanged(sessionId: string, newPhase: SessionPhase): void {
    // Cancel existing timers for this session
    this.cancelTimers(sessionId);

    // Clean up fire counts when session closes
    if (newPhase === 'closed' || newPhase === 'decided') {
      this.fireCounts.delete(sessionId);
      return;
    }

    // Check for max_rounds_exceeded when entering discussion
    if (newPhase === 'discussion') {
      const session = this.orchestrator.getSession(sessionId);
      if (session) {
        const maxRounds = this.config.council.rules.max_deliberation_rounds;
        if (session.deliberationRound > maxRounds) {
          this.evaluate(sessionId, 'max_rounds_exceeded');
        }
      }
    }

    // Start new timers for timeout rules that match this phase
    this.startTimersForPhase(sessionId, newPhase);
  }

  private startTimersForPhase(sessionId: string, phase: SessionPhase): void {
    const rules = this.getSortedRules();

    for (let i = 0; i < rules.length; i++) {
      const rule = rules[i];
      if (rule.trigger.type !== 'timeout') continue;
      if (!rule.trigger.timeout_seconds) continue;

      // Check if this timeout applies to the current phase
      if (rule.trigger.phases && rule.trigger.phases.length > 0) {
        if (!rule.trigger.phases.includes(phase)) continue;
      }

      // Check fire count
      const sessionFires = this.fireCounts.get(sessionId);
      const firedCount = sessionFires?.get(i) ?? 0;
      if (firedCount >= (rule.max_fires_per_session ?? 1)) continue;

      const timeoutMs = rule.trigger.timeout_seconds * 1000;
      const timerId = setTimeout(() => {
        this.evaluate(sessionId, 'timeout');
      }, timeoutMs);

      const timerState: SessionTimerState = {
        sessionId,
        phase,
        startedAt: Date.now(),
        timeoutMs,
        timerId,
        ruleIndex: i,
      };

      if (!this.timers.has(sessionId)) {
        this.timers.set(sessionId, []);
      }
      this.timers.get(sessionId)!.push(timerState);
    }
  }

  private cancelTimers(sessionId: string): void {
    const timers = this.timers.get(sessionId);
    if (timers) {
      for (const timer of timers) {
        clearTimeout(timer.timerId);
      }
      this.timers.delete(sessionId);
    }
  }

  private executeAction(sessionId: string, rule: EscalationRule, ruleIndex: number): void {
    // Record fire count
    if (!this.fireCounts.has(sessionId)) {
      this.fireCounts.set(sessionId, new Map());
    }
    const sessionFires = this.fireCounts.get(sessionId)!;
    sessionFires.set(ruleIndex, (sessionFires.get(ruleIndex) ?? 0) + 1);

    const escalationEvent: EscalationEvent = {
      id: nanoid(),
      sessionId,
      ruleName: rule.name ?? `rule_${ruleIndex}`,
      triggerType: rule.trigger.type,
      actionType: rule.action.type,
      details: `Escalation rule "${rule.name ?? ruleIndex}" triggered by ${rule.trigger.type}`,
      createdAt: new Date().toISOString(),
    };

    console.log(`[ESCALATION] ${escalationEvent.details} for session ${sessionId}`);

    switch (rule.action.type) {
      case 'escalate_to_human':
        this.actionEscalateToHuman(sessionId, rule, escalationEvent);
        break;
      case 'restart_discussion':
        this.actionRestartDiscussion(sessionId, rule, escalationEvent);
        break;
      case 'add_agent':
        this.actionAddAgent(sessionId, rule, escalationEvent);
        break;
      case 'auto_decide':
        this.actionAutoDecide(sessionId, rule, escalationEvent);
        break;
      case 'notify_external':
        this.actionNotifyExternal(sessionId, rule, escalationEvent);
        break;
    }
  }

  private actionEscalateToHuman(sessionId: string, rule: EscalationRule, event: EscalationEvent): void {
    const message = rule.action.message ?? `Escalated: ${rule.trigger.type}`;
    this.orchestrator.createEscalatedDecision(sessionId, message, event);
  }

  private actionRestartDiscussion(sessionId: string, rule: EscalationRule, event: EscalationEvent): void {
    const session = this.orchestrator.getSession(sessionId);
    if (!session) return;

    this.orchestrator.saveEscalationEvent(event);

    try {
      this.orchestrator.transitionPhase(sessionId, 'discussion');
    } catch {
      console.warn(`[ESCALATION] Cannot restart discussion for session ${sessionId} from phase ${session.phase}`);
    }
  }

  private actionAddAgent(sessionId: string, rule: EscalationRule, event: EscalationEvent): void {
    const agentId = rule.action.agent_id;
    if (!agentId) return;

    this.orchestrator.saveEscalationEvent(event);

    this.orchestrator.spawnAgentForEscalation(
      sessionId,
      agentId,
      `You have been brought in via escalation. Reason: ${rule.trigger.type}. Review the session context and contribute.`,
    ).catch((err) => {
      console.error(`[ESCALATION] Failed to spawn agent ${agentId}: ${(err as Error).message}`);
    });
  }

  private actionAutoDecide(sessionId: string, rule: EscalationRule, event: EscalationEvent): void {
    const outcome = rule.action.forced_outcome ?? 'rejected';
    this.orchestrator.createAutoDecision(
      sessionId,
      outcome,
      `Auto-decided by escalation rule: ${rule.name ?? rule.trigger.type}`,
      event,
    );
  }

  private actionNotifyExternal(sessionId: string, rule: EscalationRule, event: EscalationEvent): void {
    const url = rule.action.webhook_url;
    if (!url) return;

    this.orchestrator.saveEscalationEvent(event);

    const session = this.orchestrator.getSession(sessionId);
    const payload = rule.action.payload_template
      ? { ...rule.action.payload_template, session, escalation: event }
      : { session, escalation: event };

    fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch((err) => {
      console.error(`[ESCALATION] External notification failed: ${(err as Error).message}`);
    });
  }

  private getSortedRules(): EscalationRule[] {
    return [...this.config.council.rules.escalation].sort(
      (a, b) => (a.priority ?? 100) - (b.priority ?? 100),
    );
  }
}
