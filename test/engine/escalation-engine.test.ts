import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EscalationEngine } from '@/engine/escalation-engine.js';
import type { Orchestrator } from '@/engine/orchestrator.js';
import type { CouncilConfig, EscalationEvent, Session, EscalationRule } from '@/shared/types.js';

// Helper to create a minimal config with given escalation rules
function createConfig(rules: EscalationRule[]): CouncilConfig {
  return {
    version: '1',
    council: {
      name: 'Test Council',
      description: '',
      spawner: { type: 'log' },
      rules: {
        quorum: 2,
        voting_threshold: 0.5,
        max_deliberation_rounds: 3,
        require_human_approval: true,
        escalation: rules,
      },
      agents: [
        { id: 'agent-a', name: 'Agent A', role: 'Tester', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'Test' },
        { id: 'agent-b', name: 'Agent B', role: 'Tester', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'Test' },
      ],
      communication_graph: { default_policy: 'broadcast', edges: {} },
      event_routing: [],
    },
  };
}

function createMockSession(overrides?: Partial<Session>): Session {
  return {
    id: 'session-1',
    councilId: 'council-1',
    title: 'Test Session',
    phase: 'voting',
    leadAgentId: 'agent-a',
    triggerEventId: null,
    deliberationRound: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function createMockOrchestrator() {
  const listeners: Array<(event: unknown) => void> = [];
  return {
    onEvent: vi.fn((fn: (event: unknown) => void) => {
      listeners.push(fn);
      return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    }),
    getSession: vi.fn(() => createMockSession()),
    createEscalatedDecision: vi.fn(),
    createAutoDecision: vi.fn(),
    spawnAgentForEscalation: vi.fn().mockResolvedValue(undefined),
    saveEscalationEvent: vi.fn(),
    getEscalationEvents: vi.fn(() => []),
    transitionPhase: vi.fn(),
    _emit(event: unknown) {
      for (const fn of listeners) fn(event);
    },
  } as unknown as Orchestrator & { _emit: (event: unknown) => void };
}

describe('EscalationEngine', () => {
  let engine: EscalationEngine;
  let orchestrator: ReturnType<typeof createMockOrchestrator>;

  afterEach(() => {
    engine?.stop();
  });

  describe('Rule evaluation', () => {
    it('evaluates deadlock trigger and calls escalate_to_human', () => {
      const config = createConfig([{
        name: 'deadlock_escalate',
        trigger: { type: 'deadlock' },
        action: { type: 'escalate_to_human', message: 'Deadlocked' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');

      expect(orchestrator.createEscalatedDecision).toHaveBeenCalledWith(
        'session-1',
        'Deadlocked',
        expect.objectContaining({ triggerType: 'deadlock', actionType: 'escalate_to_human' }),
      );
    });

    it('evaluates quorum_not_met trigger', () => {
      const config = createConfig([{
        trigger: { type: 'quorum_not_met' },
        action: { type: 'escalate_to_human', message: 'No quorum' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'quorum_not_met');

      expect(orchestrator.createEscalatedDecision).toHaveBeenCalledWith(
        'session-1',
        'No quorum',
        expect.objectContaining({ triggerType: 'quorum_not_met' }),
      );
    });

    it('evaluates veto_exercised trigger with add_agent action', () => {
      const config = createConfig([{
        trigger: { type: 'veto_exercised' },
        action: { type: 'add_agent', agent_id: 'agent-b' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'veto_exercised');

      expect(orchestrator.spawnAgentForEscalation).toHaveBeenCalledWith(
        'session-1',
        'agent-b',
        expect.stringContaining('veto_exercised'),
      );
    });

    it('evaluates auto_decide action with forced outcome', () => {
      const config = createConfig([{
        trigger: { type: 'max_rounds_exceeded' },
        action: { type: 'auto_decide', forced_outcome: 'rejected' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'max_rounds_exceeded');

      expect(orchestrator.createAutoDecision).toHaveBeenCalledWith(
        'session-1',
        'rejected',
        expect.stringContaining('escalation rule'),
        expect.objectContaining({ triggerType: 'max_rounds_exceeded' }),
      );
    });

    it('evaluates restart_discussion action', () => {
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'restart_discussion' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');

      expect(orchestrator.transitionPhase).toHaveBeenCalledWith('session-1', 'discussion');
      expect(orchestrator.saveEscalationEvent).toHaveBeenCalled();
    });

    it('evaluates notify_external action', () => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('ok'));
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'notify_external', webhook_url: 'http://example.com/hook' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');

      expect(fetchSpy).toHaveBeenCalledWith('http://example.com/hook', expect.objectContaining({
        method: 'POST',
      }));
      fetchSpy.mockRestore();
    });

    it('ignores rules for non-matching trigger type', () => {
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'escalate_to_human' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'timeout');

      expect(orchestrator.createEscalatedDecision).not.toHaveBeenCalled();
    });

    it('handles empty escalation config', () => {
      const config = createConfig([]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      expect(() => engine.evaluate('session-1', 'deadlock')).not.toThrow();
    });
  });

  describe('Priority and control flow', () => {
    it('respects priority ordering (lower fires first)', () => {
      const calls: string[] = [];
      const config = createConfig([
        { name: 'high', priority: 50, trigger: { type: 'deadlock' }, action: { type: 'escalate_to_human', message: 'high' } },
        { name: 'low', priority: 10, trigger: { type: 'deadlock' }, action: { type: 'restart_discussion' } },
      ]);
      orchestrator = createMockOrchestrator();
      // Track call order
      (orchestrator.transitionPhase as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push('restart_discussion'));
      (orchestrator.createEscalatedDecision as ReturnType<typeof vi.fn>).mockImplementation(() => calls.push('escalate_to_human'));

      engine = new EscalationEngine(config, orchestrator);
      engine.evaluate('session-1', 'deadlock');

      expect(calls).toEqual(['restart_discussion', 'escalate_to_human']);
    });

    it('respects stop_after — only first matching rule fires', () => {
      const config = createConfig([
        { name: 'first', priority: 10, trigger: { type: 'deadlock' }, action: { type: 'restart_discussion' }, stop_after: true },
        { name: 'second', priority: 20, trigger: { type: 'deadlock' }, action: { type: 'escalate_to_human' } },
      ]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');

      expect(orchestrator.transitionPhase).toHaveBeenCalled();
      expect(orchestrator.createEscalatedDecision).not.toHaveBeenCalled();
    });

    it('respects max_fires_per_session', () => {
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'restart_discussion' },
        max_fires_per_session: 1,
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');
      engine.evaluate('session-1', 'deadlock');

      expect(orchestrator.transitionPhase).toHaveBeenCalledTimes(1);
    });

    it('max_fires_per_session is per-session', () => {
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'restart_discussion' },
        max_fires_per_session: 1,
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);

      engine.evaluate('session-1', 'deadlock');
      engine.evaluate('session-2', 'deadlock');

      expect(orchestrator.transitionPhase).toHaveBeenCalledTimes(2);
    });
  });

  describe('Timer management', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('starts timer on phase change and fires after timeout', () => {
      const config = createConfig([{
        name: 'discussion_timeout',
        trigger: { type: 'timeout', phases: ['discussion'], timeout_seconds: 10 },
        action: { type: 'escalate_to_human', message: 'Timed out' },
      }]);
      orchestrator = createMockOrchestrator();
      (orchestrator.getSession as ReturnType<typeof vi.fn>).mockReturnValue(createMockSession({ phase: 'discussion' }));
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      // Simulate phase change
      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      // Timer not yet fired
      expect(orchestrator.createEscalatedDecision).not.toHaveBeenCalled();

      // Advance past timeout
      vi.advanceTimersByTime(10_000);

      expect(orchestrator.createEscalatedDecision).toHaveBeenCalledWith(
        'session-1',
        'Timed out',
        expect.objectContaining({ triggerType: 'timeout' }),
      );
    });

    it('cancels timer on phase change', () => {
      const config = createConfig([{
        trigger: { type: 'timeout', phases: ['discussion'], timeout_seconds: 10 },
        action: { type: 'escalate_to_human' },
      }]);
      orchestrator = createMockOrchestrator();
      (orchestrator.getSession as ReturnType<typeof vi.fn>).mockReturnValue(createMockSession({ phase: 'discussion' }));
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      // Move to voting before timeout fires
      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'voting' });

      vi.advanceTimersByTime(15_000);

      // Timer was cancelled, should not fire
      expect(orchestrator.createEscalatedDecision).not.toHaveBeenCalled();
    });

    it('does not start timer for non-matching phase', () => {
      const config = createConfig([{
        trigger: { type: 'timeout', phases: ['voting'], timeout_seconds: 10 },
        action: { type: 'escalate_to_human' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      expect(engine.getActiveTimers('session-1')).toHaveLength(0);
    });

    it('getActiveTimers returns remaining time', () => {
      const config = createConfig([{
        name: 'my_timer',
        trigger: { type: 'timeout', phases: ['discussion'], timeout_seconds: 60 },
        action: { type: 'escalate_to_human' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      vi.advanceTimersByTime(10_000);

      const timers = engine.getActiveTimers('session-1');
      expect(timers).toHaveLength(1);
      expect(timers[0].ruleName).toBe('my_timer');
      expect(timers[0].remainingMs).toBeLessThanOrEqual(50_000);
      expect(timers[0].remainingMs).toBeGreaterThan(0);
    });

    it('stop() cancels all timers', () => {
      const config = createConfig([{
        trigger: { type: 'timeout', phases: ['discussion'], timeout_seconds: 10 },
        action: { type: 'escalate_to_human' },
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      engine.stop();
      vi.advanceTimersByTime(15_000);

      expect(orchestrator.createEscalatedDecision).not.toHaveBeenCalled();
    });

    it('cleans up fire counts when session closes', () => {
      const config = createConfig([{
        trigger: { type: 'deadlock' },
        action: { type: 'restart_discussion' },
        max_fires_per_session: 1,
      }]);
      orchestrator = createMockOrchestrator();
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      // Fire once
      engine.evaluate('session-1', 'deadlock');
      expect(orchestrator.transitionPhase).toHaveBeenCalledTimes(1);

      // Simulate session closing (clears fire counts)
      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'closed' });

      // Should be able to fire again if session reopened (edge case)
      engine.evaluate('session-1', 'deadlock');
      expect(orchestrator.transitionPhase).toHaveBeenCalledTimes(2);
    });
  });

  describe('Phase-triggered evaluation', () => {
    it('evaluates max_rounds_exceeded when entering discussion beyond limit', () => {
      const config = createConfig([{
        trigger: { type: 'max_rounds_exceeded' },
        action: { type: 'auto_decide', forced_outcome: 'rejected' },
      }]);
      orchestrator = createMockOrchestrator();
      (orchestrator.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
        createMockSession({ phase: 'discussion', deliberationRound: 4 }),
      );
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      expect(orchestrator.createAutoDecision).toHaveBeenCalledWith(
        'session-1',
        'rejected',
        expect.any(String),
        expect.objectContaining({ triggerType: 'max_rounds_exceeded' }),
      );
    });

    it('does not trigger max_rounds_exceeded when within limit', () => {
      const config = createConfig([{
        trigger: { type: 'max_rounds_exceeded' },
        action: { type: 'auto_decide', forced_outcome: 'rejected' },
      }]);
      orchestrator = createMockOrchestrator();
      (orchestrator.getSession as ReturnType<typeof vi.fn>).mockReturnValue(
        createMockSession({ phase: 'discussion', deliberationRound: 2 }),
      );
      engine = new EscalationEngine(config, orchestrator);
      engine.start();

      orchestrator._emit({ type: 'session:phase_changed', sessionId: 'session-1', phase: 'discussion' });

      expect(orchestrator.createAutoDecision).not.toHaveBeenCalled();
    });
  });
});
