import type { AgentConfig, CouncilRules, VoteValue } from '../../shared/types.js';
import type { Ballot, TallyResult, VotingScheme } from './types.js';
import { WeightedMajorityScheme } from './weighted-majority.js';

export class AdvisoryScheme implements VotingScheme {
  readonly name = 'advisory';
  private inner = new WeightedMajorityScheme();

  validVoteValues(): VoteValue[] {
    return ['approve', 'reject', 'abstain'];
  }

  tally(ballots: Ballot[], agents: AgentConfig[], rules: CouncilRules): TallyResult {
    const inner = this.inner.tally(ballots, agents, rules);
    return {
      ...inner,
      outcome: 'escalated', // Advisory is always non-binding
      summary: `Advisory (non-binding): ${inner.summary}`,
    };
  }
}
