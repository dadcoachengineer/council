import { describe, it, expect } from 'vitest';
import { tallyVotes, allVotesCast } from '@/engine/voting.js';
import type { AgentConfig, Vote, CouncilRules } from '@/shared/types.js';

const agents: AgentConfig[] = [
  { id: 'a', name: 'A', role: 'A', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'A' },
  { id: 'b', name: 'B', role: 'B', expertise: [], can_propose: true, can_veto: false, voting_weight: 1, system_prompt: 'B' },
  { id: 'c', name: 'C', role: 'C', expertise: [], can_propose: true, can_veto: true, voting_weight: 1.5, system_prompt: 'C' },
];

const rules: CouncilRules = {
  quorum: 2,
  voting_threshold: 0.66,
  max_deliberation_rounds: 5,
  require_human_approval: true,
  escalation: [],
};

function makeVote(agentId: string, value: 'approve' | 'reject' | 'abstain'): Vote {
  return { id: `v-${agentId}`, sessionId: 's1', agentId, value, reasoning: 'test', createdAt: '' };
}

describe('tallyVotes', () => {
  it('approves when threshold is met', () => {
    const votes = [makeVote('a', 'approve'), makeVote('b', 'approve')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.quorumMet).toBe(true);
    expect(tally.thresholdMet).toBe(true);
    expect(tally.outcome).toBe('approved');
  });

  it('rejects when threshold is not met', () => {
    const votes = [makeVote('a', 'approve'), makeVote('b', 'reject')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.quorumMet).toBe(true);
    expect(tally.thresholdMet).toBe(false);
    expect(tally.outcome).toBe('rejected');
  });

  it('returns null outcome when quorum not met', () => {
    const votes = [makeVote('a', 'approve')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.quorumMet).toBe(false);
    expect(tally.outcome).toBeNull();
  });

  it('applies voting weights', () => {
    // Agent C has weight 1.5, so even though 1 approve vs 1 reject by count,
    // the weighted totals are 1.5 approve vs 1 reject = 60% which is < 66%
    const votes = [makeVote('c', 'approve'), makeVote('a', 'reject')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.approve).toBe(1.5);
    expect(tally.reject).toBe(1);
    expect(tally.thresholdMet).toBe(false);
  });

  it('handles veto power', () => {
    // Agent C has veto and rejects
    const votes = [makeVote('a', 'approve'), makeVote('b', 'approve'), makeVote('c', 'reject')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.vetoExercised).toBe(true);
    expect(tally.outcome).toBe('rejected');
  });

  it('does not trigger veto on non-veto agent reject', () => {
    const votes = [makeVote('a', 'reject'), makeVote('b', 'approve'), makeVote('c', 'approve')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.vetoExercised).toBe(false);
  });

  it('handles abstains (not counted toward threshold)', () => {
    const votes = [makeVote('a', 'approve'), makeVote('b', 'abstain'), makeVote('c', 'approve')];
    const tally = tallyVotes(votes, agents, rules);
    expect(tally.abstain).toBe(1);
    // threshold = approve / (approve + reject) = 2.5 / 2.5 = 1.0 >= 0.66
    expect(tally.thresholdMet).toBe(true);
    expect(tally.outcome).toBe('approved');
  });
});

describe('allVotesCast', () => {
  it('returns true when all expected agents voted', () => {
    const votes = [makeVote('a', 'approve'), makeVote('b', 'reject')];
    expect(allVotesCast(votes, ['a', 'b'])).toBe(true);
  });

  it('returns false when some agents have not voted', () => {
    const votes = [makeVote('a', 'approve')];
    expect(allVotesCast(votes, ['a', 'b'])).toBe(false);
  });
});
