import type { AgentConfig, CouncilRules, DecisionOutcome, VoteValue } from '../../shared/types.js';
import type { Ballot, TallyResult, VotingScheme } from './types.js';

export class ConsentBasedScheme implements VotingScheme {
  readonly name = 'consent_based';

  validVoteValues(): VoteValue[] {
    return ['consent', 'object', 'abstain'];
  }

  tally(ballots: Ballot[], agents: AgentConfig[], rules: CouncilRules): TallyResult {
    const agentMap = new Map(agents.map((a) => [a.id, a]));

    let consent = 0;
    let object = 0;
    let abstain = 0;
    let totalWeight = 0;
    let vetoExercised = false;

    const objectors: string[] = [];

    for (const ballot of ballots) {
      const agent = agentMap.get(ballot.agentId);
      const weight = agent?.voting_weight ?? 1;
      totalWeight += weight;

      switch (ballot.value) {
        case 'consent':
          consent += weight;
          break;
        case 'object':
          object += weight;
          objectors.push(ballot.agentId);
          if (agent?.can_veto) vetoExercised = true;
          break;
        case 'abstain':
          abstain += weight;
          break;
      }
    }

    const quorumMet = ballots.length >= rules.quorum;
    const hasObjection = object > 0;
    const thresholdMet = !hasObjection;

    let outcome: DecisionOutcome | null = null;
    if (quorumMet) {
      outcome = hasObjection ? 'rejected' : 'approved';
    }

    const summary = hasObjection
      ? `Objection raised by: ${objectors.join(', ')}. Consent not achieved.`
      : `No objections — consent achieved. ${consent} consent, ${abstain} abstain.`;

    return {
      outcome,
      quorumMet,
      vetoExercised,
      summary,
      approve: consent,
      reject: object,
      abstain,
      totalWeight,
      thresholdMet,
    };
  }
}
