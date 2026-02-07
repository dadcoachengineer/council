import type { AgentConfig, CouncilRules, DecisionOutcome, VoteValue } from '../../shared/types.js';
import type { Ballot, TallyResult, VotingScheme } from './types.js';

export class WeightedMajorityScheme implements VotingScheme {
  readonly name = 'weighted_majority';

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
    const votingWeight = approve + reject;
    const thresholdMet = votingWeight > 0 && approve / votingWeight >= rules.voting_threshold;

    let outcome: DecisionOutcome | null = null;
    if (quorumMet) {
      if (vetoExercised) {
        outcome = 'rejected';
      } else if (thresholdMet) {
        outcome = 'approved';
      } else {
        outcome = 'rejected';
      }
    }

    const parts = [
      `Approve: ${approve}, Reject: ${reject}, Abstain: ${abstain}`,
      `Quorum: ${quorumMet ? 'met' : 'not met'}`,
      `Threshold: ${thresholdMet ? 'met' : 'not met'}`,
    ];
    if (vetoExercised) parts.push('Veto exercised');

    return {
      outcome,
      quorumMet,
      vetoExercised,
      summary: parts.join('. '),
      approve,
      reject,
      abstain,
      totalWeight,
      thresholdMet,
    };
  }
}
