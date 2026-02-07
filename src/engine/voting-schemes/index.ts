import type { VotingSchemeConfig } from '../../shared/types.js';
import type { VotingScheme } from './types.js';
import { WeightedMajorityScheme } from './weighted-majority.js';
import { UnanimousScheme } from './unanimous.js';
import { SupermajorityScheme } from './supermajority.js';
import { ConsentBasedScheme } from './consent-based.js';
import { AdvisoryScheme } from './advisory.js';

export type { VotingScheme, Ballot, TallyResult } from './types.js';

export function createVotingScheme(config?: VotingSchemeConfig): VotingScheme {
  const type = config?.type ?? 'weighted_majority';

  switch (type) {
    case 'weighted_majority':
      return new WeightedMajorityScheme();
    case 'unanimous':
      return new UnanimousScheme();
    case 'supermajority':
      return new SupermajorityScheme({
        preset: config?.preset,
        threshold: config?.threshold,
      });
    case 'consent_based':
      return new ConsentBasedScheme();
    case 'advisory':
      return new AdvisoryScheme();
    default:
      return new WeightedMajorityScheme();
  }
}

export {
  WeightedMajorityScheme,
  UnanimousScheme,
  SupermajorityScheme,
  ConsentBasedScheme,
  AdvisoryScheme,
};
