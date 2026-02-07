import type { AgentConfig, CouncilRules, DecisionOutcome, VoteValue } from '../../shared/types.js';
import type { Ballot, TallyResult, VotingScheme } from './types.js';

export class UnanimousScheme implements VotingScheme {
  readonly name = 'unanimous';

  validVoteValues(): VoteValue[] {
    return ['approve', 'reject', 'abstain'];
  }

  tally(ballots: Ballot[], agents: AgentConfig[], rules: CouncilRules): TallyResult {
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    let approve = 0;
    let reject = 0;
    let abstain = 0;
    let totalWeight = 0;
    let vetoExercised = false;

    for (const ballot of ballots) {
      const agent = agentMap.get(ballot.agentId);
      const weight = agent?.voting_weight ?? 1;
      totalWeight += weight;

      switch (ballot.value) {
        case 'approve':
          approve += weight;
          break;
        case 'reject':
          reject += weight;
          if (agent?.can_veto) vetoExercised = true;
          break;
        case 'abstain':
          abstain += weight;
          break;
      }
    }

    const quorumMet = ballots.length >= rules.quorum;
    const nonAbstaining = ballots.filter((b) => b.value !== 'abstain');
    const allApprove = nonAbstaining.length > 0 && nonAbstaining.every((b) => b.value === 'approve');
    const thresholdMet = allApprove;

    let outcome: DecisionOutcome | null = null;
    if (quorumMet) {
      outcome = allApprove ? 'approved' : 'rejected';
    }

    return {
      outcome,
      quorumMet,
      vetoExercised,
      summary: `Unanimous: ${allApprove ? 'all approve' : 'not unanimous'}. ${nonAbstaining.length} non-abstaining vote(s)`,
      approve,
      reject,
      abstain,
      totalWeight,
      thresholdMet,
    };
  }
}
