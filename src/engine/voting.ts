import type { AgentConfig, Vote, VoteTally, CouncilRules, DecisionOutcome } from '../shared/types.js';

/**
 * Tally votes for a session, accounting for voting weights,
 * quorum requirements, threshold, and veto power.
 */
export function tallyVotes(
  votes: Vote[],
  agents: AgentConfig[],
  rules: CouncilRules,
): VoteTally {
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  let approve = 0;
  let reject = 0;
  let abstain = 0;
  let totalWeight = 0;
  let vetoExercised = false;

  for (const vote of votes) {
    const agent = agentMap.get(vote.agentId);
    const weight = agent?.voting_weight ?? 1;
    totalWeight += weight;

    switch (vote.value) {
      case 'approve':
        approve += weight;
        break;
      case 'reject':
        reject += weight;
        // Check for veto
        if (agent?.can_veto) {
          vetoExercised = true;
        }
        break;
      case 'abstain':
        abstain += weight;
        break;
    }
  }

  const quorumMet = votes.length >= rules.quorum;
  const votingWeight = approve + reject; // Abstains don't count toward threshold
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

  return {
    approve,
    reject,
    abstain,
    totalWeight,
    quorumMet,
    thresholdMet,
    outcome,
    vetoExercised,
  };
}

/**
 * Check if all expected agents have voted.
 */
export function allVotesCast(
  votes: Vote[],
  expectedAgentIds: string[],
): boolean {
  const votedIds = new Set(votes.map((v) => v.agentId));
  return expectedAgentIds.every((id) => votedIds.has(id));
}
