import { describe, it, expect } from 'vitest';
import { CouncilConfigSchema, validateAgentReferences } from '@/shared/schemas.js';

describe('Escalation schema validation', () => {
  const baseConfig = {
    version: '1',
    council: {
      name: 'Test',
      description: '',
      spawner: { type: 'log' },
      rules: {
        quorum: 1,
        voting_threshold: 0.5,
      },
      agents: [
        { id: 'agent-a', name: 'A', role: 'Tester', system_prompt: 'Test' },
      ],
    },
  };

  it('validates well-formed escalation rule', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            name: 'test_rule',
            priority: 10,
            trigger: { type: 'deadlock' },
            action: { type: 'escalate_to_human', message: 'Deadlocked' },
            stop_after: true,
            max_fires_per_session: 2,
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const rule = result.data.council.rules.escalation[0];
      expect(rule.name).toBe('test_rule');
      expect(rule.priority).toBe(10);
      expect(rule.trigger.type).toBe('deadlock');
      expect(rule.action.type).toBe('escalate_to_human');
      expect(rule.stop_after).toBe(true);
      expect(rule.max_fires_per_session).toBe(2);
    }
  });

  it('rejects timeout trigger without timeout_seconds', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'timeout' },
            action: { type: 'escalate_to_human' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('accepts timeout trigger with timeout_seconds', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'timeout', timeout_seconds: 300, phases: ['discussion'] },
            action: { type: 'escalate_to_human' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
  });

  it('rejects add_agent action without agent_id', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'veto_exercised' },
            action: { type: 'add_agent' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('rejects notify_external without webhook_url', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'deadlock' },
            action: { type: 'notify_external' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(false);
  });

  it('applies default priority of 100', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'deadlock' },
            action: { type: 'escalate_to_human' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.council.rules.escalation[0].priority).toBe(100);
    }
  });

  it('applies default max_fires_per_session of 1', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'deadlock' },
            action: { type: 'escalate_to_human' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.council.rules.escalation[0].max_fires_per_session).toBe(1);
    }
  });

  it('backward compat: converts legacy { condition, action } format', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [
            { condition: 'deadlock', action: 'escalate_to_human' },
          ],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const rule = result.data.council.rules.escalation[0];
      expect(rule.name).toBe('legacy_deadlock');
      expect(rule.trigger.type).toBe('deadlock');
      expect(rule.action.type).toBe('escalate_to_human');
    }
  });

  it('validates agent references in escalation rules', () => {
    const config = {
      ...baseConfig,
      council: {
        ...baseConfig.council,
        rules: {
          ...baseConfig.council.rules,
          escalation: [{
            trigger: { type: 'veto_exercised' },
            action: { type: 'add_agent', agent_id: 'nonexistent' },
          }],
        },
      },
    };

    const result = CouncilConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      const errors = validateAgentReferences(result.data);
      expect(errors).toContainEqual(expect.stringContaining('nonexistent'));
    }
  });

  it('accepts empty escalation array', () => {
    const result = CouncilConfigSchema.safeParse(baseConfig);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.council.rules.escalation).toEqual([]);
    }
  });
});
