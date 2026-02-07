import type { AgentConfig, CouncilRules, DecisionOutcome, VoteValue } from '../../shared/types.js';

export interface Ballot {
  agentId: string;
  value: VoteValue;
  reasoning: string;
}

export interface TallyResult {
  outcome: DecisionOutcome | null;
  quorumMet: boolean;
  vetoExercised: boolean;
  summary: string;
  approve: number;
  reject: number;
  abstain: number;
  totalWeight: number;
  thresholdMet: boolean;
}

export interface VotingScheme {
  readonly name: string;
  validVoteValues(): VoteValue[];
  tally(ballots: Ballot[], agents: AgentConfig[], rules: CouncilRules): TallyResult;
}
