import { describe, it, expect } from 'vitest';
import { createVotingScheme } from '@/engine/voting-schemes/index.js';
import { WeightedMajorityScheme } from '@/engine/voting-schemes/weighted-majority.js';
import { UnanimousScheme } from '@/engine/voting-schemes/unanimous.js';
import { SupermajorityScheme } from '@/engine/voting-schemes/supermajority.js';
import { ConsentBasedScheme } from '@/engine/voting-schemes/consent-based.js';
import { AdvisoryScheme } from '@/engine/voting-schemes/advisory.js';
import type { AgentConfig, CouncilRules } from '@/shared/types.js';
import type { Ballot } from '@/engine/voting-schemes/types.js';

const agents: AgentConfig[] = [
  { id: 'a', name: 'A', role: 'A', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
  { id: 'b', name: 'B', role: 'B', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: '' },
  { id: 'c', name: 'C', role: 'C', expertise: [], can_propose: true, can_veto: true, voting_weight: 1.5, system_prompt: '' },
];

const rules: CouncilRules = {
  quorum: 2,
  voting_threshold: 0.66,
  max_deliberation_rounds: 5,
  require_human_approval: true,
  escalation: [],
};

function ballot(agentId: string, value: string): Ballot {
  return { agentId, value: value as Ballot['value'], reasoning: 'test' };
}

// ── Factory ──

describe('createVotingScheme', () => {
  it('defaults to weighted_majority when no config', () => {
    const scheme = createVotingScheme();
    expect(scheme.name).toBe('weighted_majority');
  });

  it('creates weighted_majority scheme', () => {
    const scheme = createVotingScheme({ type: 'weighted_majority' });
    expect(scheme).toBeInstanceOf(WeightedMajorityScheme);
  });

  it('creates unanimous scheme', () => {
    const scheme = createVotingScheme({ type: 'unanimous' });
    expect(scheme).toBeInstanceOf(UnanimousScheme);
  });

  it('creates supermajority scheme with preset', () => {
    const scheme = createVotingScheme({ type: 'supermajority', preset: 'three_quarters' });
    expect(scheme).toBeInstanceOf(SupermajorityScheme);
    expect(scheme.name).toBe('supermajority');
  });

  it('creates supermajority scheme with custom threshold', () => {
    const scheme = createVotingScheme({ type: 'supermajority', threshold: 0.8 });
    expect(scheme).toBeInstanceOf(SupermajorityScheme);
  });

  it('creates consent_based scheme', () => {
    const scheme = createVotingScheme({ type: 'consent_based' });
    expect(scheme).toBeInstanceOf(ConsentBasedScheme);
  });

  it('creates advisory scheme', () => {
    const scheme = createVotingScheme({ type: 'advisory' });
    expect(scheme).toBeInstanceOf(AdvisoryScheme);
  });

  it('falls back to weighted_majority for unknown type', () => {
    const scheme = createVotingScheme({ type: 'unknown' as any });
    expect(scheme).toBeInstanceOf(WeightedMajorityScheme);
  });
});

// ── Weighted Majority ──

describe('WeightedMajorityScheme', () => {
  const scheme = new WeightedMajorityScheme();

  it('returns correct valid vote values', () => {
    expect(scheme.validVoteValues()).toEqual(['approve', 'reject', 'abstain']);
  });

  it('approves when threshold met', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('approved');
    expect(result.quorumMet).toBe(true);
    expect(result.thresholdMet).toBe(true);
  });

  it('rejects when threshold not met', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('rejected');
    expect(result.thresholdMet).toBe(false);
  });

  it('returns null outcome when quorum not met', () => {
    const ballots = [ballot('a', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBeNull();
    expect(result.quorumMet).toBe(false);
  });

  it('applies voting weights', () => {
    const ballots = [ballot('c', 'approve'), ballot('a', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.approve).toBe(1.5);
    expect(result.reject).toBe(1);
    // 1.5/2.5 = 0.6, below 0.66 threshold
    expect(result.thresholdMet).toBe(false);
  });

  it('handles veto power', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.vetoExercised).toBe(true);
    expect(result.outcome).toBe('rejected');
  });

  it('includes summary text', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.summary).toContain('Approve: 2');
    expect(result.summary).toContain('Quorum: met');
    expect(result.summary).toContain('Threshold: met');
  });
});

// ── Unanimous ──

describe('UnanimousScheme', () => {
  const scheme = new UnanimousScheme();

  it('returns correct valid vote values', () => {
    expect(scheme.validVoteValues()).toEqual(['approve', 'reject', 'abstain']);
  });

  it('approves when all non-abstaining approve', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('approved');
    expect(result.thresholdMet).toBe(true);
  });

  it('approves when all non-abstaining approve (with abstains)', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'abstain'), ballot('c', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('approved');
    expect(result.thresholdMet).toBe(true);
  });

  it('rejects when any non-abstaining rejects', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'reject'), ballot('c', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('rejected');
    expect(result.thresholdMet).toBe(false);
  });

  it('returns null outcome when quorum not met', () => {
    const ballots = [ballot('a', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBeNull();
  });

  it('includes summary text', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.summary).toContain('Unanimous');
    expect(result.summary).toContain('all approve');
  });
});

// ── Supermajority ──

describe('SupermajorityScheme', () => {
  it('defaults to two-thirds threshold', () => {
    const scheme = new SupermajorityScheme();
    // 2 approve, 1 reject = 66.7% — exactly meets 2/3
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'reject')];
    const result = scheme.tally(ballots, agents, { ...rules, quorum: 3 });
    // approve weight: 2, reject weight: 1.5, total: 3.5
    // 2/3.5 = 0.571 < 0.667 → rejected (because c has weight 1.5)
    expect(result.thresholdMet).toBe(false);
  });

  it('uses preset three_quarters', () => {
    const scheme = new SupermajorityScheme({ preset: 'three_quarters' });
    // Need >= 75% to pass. 3 approve, 1 reject:
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    // 3.5/3.5 = 100% >= 75%
    expect(result.outcome).toBe('approved');
  });

  it('uses custom threshold', () => {
    const scheme = new SupermajorityScheme({ threshold: 0.9 });
    // Need >= 90%. 2 approve (weight 2), 1 reject (weight 1.5)
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    // 2/3.5 = 57.1% < 90%
    expect(result.outcome).toBe('rejected');
    expect(result.thresholdMet).toBe(false);
  });

  it('threshold takes precedence over preset', () => {
    const scheme = new SupermajorityScheme({ preset: 'three_quarters', threshold: 0.5 });
    // threshold=0.5 should be used, not 0.75
    const ballots = [ballot('a', 'approve'), ballot('b', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    // 1/2 = 50% >= 50%
    expect(result.thresholdMet).toBe(true);
    expect(result.outcome).toBe('approved');
  });

  it('handles veto', () => {
    const scheme = new SupermajorityScheme();
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.vetoExercised).toBe(true);
    expect(result.outcome).toBe('rejected');
  });

  it('includes percentage in summary', () => {
    const scheme = new SupermajorityScheme({ preset: 'three_quarters' });
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.summary).toContain('75%');
  });

  it('returns correct valid vote values', () => {
    const scheme = new SupermajorityScheme();
    expect(scheme.validVoteValues()).toEqual(['approve', 'reject', 'abstain']);
  });
});

// ── Consent-Based ──

describe('ConsentBasedScheme', () => {
  const scheme = new ConsentBasedScheme();

  it('returns correct valid vote values', () => {
    expect(scheme.validVoteValues()).toEqual(['consent', 'object', 'abstain']);
  });

  it('approves when no objections', () => {
    const ballots = [ballot('a', 'consent'), ballot('b', 'consent'), ballot('c', 'consent')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('approved');
    expect(result.thresholdMet).toBe(true);
  });

  it('approves with abstains and no objections', () => {
    const ballots = [ballot('a', 'consent'), ballot('b', 'abstain'), ballot('c', 'consent')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('approved');
  });

  it('rejects when any agent objects', () => {
    const ballots = [ballot('a', 'consent'), ballot('b', 'object'), ballot('c', 'consent')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('rejected');
    expect(result.thresholdMet).toBe(false);
  });

  it('reports objectors in summary', () => {
    const ballots = [ballot('a', 'consent'), ballot('b', 'object')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.summary).toContain('b');
    expect(result.summary).toContain('Objection');
  });

  it('tracks veto on objection from veto agent', () => {
    const ballots = [ballot('a', 'consent'), ballot('c', 'object')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.vetoExercised).toBe(true);
  });

  it('returns null outcome when quorum not met', () => {
    const ballots = [ballot('a', 'consent')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBeNull();
  });

  it('maps consent to approve and object to reject in tally counts', () => {
    const ballots = [ballot('a', 'consent'), ballot('b', 'object'), ballot('c', 'abstain')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.approve).toBe(1);   // consent count
    expect(result.reject).toBe(1);    // object count
    expect(result.abstain).toBe(1.5); // c has weight 1.5
  });
});

// ── Advisory ──

describe('AdvisoryScheme', () => {
  const scheme = new AdvisoryScheme();

  it('returns correct valid vote values', () => {
    expect(scheme.validVoteValues()).toEqual(['approve', 'reject', 'abstain']);
  });

  it('always returns escalated outcome regardless of votes', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve'), ballot('c', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('escalated');
  });

  it('returns escalated even when votes would reject', () => {
    const ballots = [ballot('a', 'reject'), ballot('b', 'reject')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.outcome).toBe('escalated');
  });

  it('prefixes summary with Advisory label', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'approve')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.summary).toMatch(/^Advisory \(non-binding\):/);
  });

  it('still tallies votes correctly for informational purposes', () => {
    const ballots = [ballot('a', 'approve'), ballot('b', 'reject'), ballot('c', 'abstain')];
    const result = scheme.tally(ballots, agents, rules);
    expect(result.approve).toBe(1);
    expect(result.reject).toBe(1);
    expect(result.abstain).toBe(1.5);
  });
});
