import { z } from 'zod';

// ── Zod schemas for YAML config validation ──

const EscalationTriggerSchema = z.object({
  type: z.enum(['deadlock', 'quorum_not_met', 'veto_exercised', 'timeout', 'max_rounds_exceeded']),
  phases: z.array(z.enum(['investigation', 'proposal', 'discussion', 'refinement', 'voting', 'review', 'decided', 'closed'])).optional(),
  timeout_seconds: z.number().int().min(1).optional(),
}).refine(
  (t) => t.type !== 'timeout' || (t.timeout_seconds !== undefined && t.timeout_seconds > 0),
  { message: 'timeout trigger requires timeout_seconds' },
);

const EscalationActionSchema = z.object({
  type: z.enum(['escalate_to_human', 'restart_discussion', 'add_agent', 'auto_decide', 'notify_external']),
  message: z.string().optional(),
  agent_id: z.string().optional(),
  forced_outcome: z.enum(['approved', 'rejected', 'escalated']).optional(),
  webhook_url: z.string().optional(),
  payload_template: z.record(z.unknown()).optional(),
}).refine(
  (a) => a.type !== 'add_agent' || (a.agent_id !== undefined),
  { message: 'add_agent action requires an agent_id' },
).refine(
  (a) => a.type !== 'notify_external' || (a.webhook_url !== undefined),
  { message: 'notify_external action requires a webhook_url' },
);

const EscalationRuleSchema = z.object({
  name: z.string().optional(),
  priority: z.number().int().default(100),
  trigger: EscalationTriggerSchema,
  action: EscalationActionSchema,
  stop_after: z.boolean().default(false),
  max_fires_per_session: z.number().int().positive().default(1),
});

const VotingSchemeConfigSchema = z.object({
  type: z.enum(['weighted_majority', 'unanimous', 'supermajority', 'consent_based', 'advisory']).default('weighted_majority'),
  preset: z.enum(['two_thirds', 'three_quarters']).optional(),
  threshold: z.number().min(0).max(1).optional(),
});

const DynamicWeightConfigSchema = z.object({
  enabled: z.boolean().default(false),
  expertise_match_bonus: z.number().positive().default(0.5),
  max_multiplier: z.number().positive().default(3.0),
});

const CouncilRulesSchema = z.object({
  quorum: z.number().int().min(1),
  voting_threshold: z.number().min(0).max(1),
  voting_scheme: VotingSchemeConfigSchema.optional(),
  max_deliberation_rounds: z.number().int().min(1).default(5),
  require_human_approval: z.boolean().default(true),
  enable_refinement: z.boolean().default(true),
  max_amendments: z.number().int().min(1).default(10),
  amendment_resolution: z.enum(['lead_resolves', 'auto_accept']).default('lead_resolves'),
  dynamic_weights: DynamicWeightConfigSchema.optional(),
  escalation: z.preprocess(
    (val) => {
      if (!Array.isArray(val)) return val;
      return val.map((rule: Record<string, unknown>) => {
        // Legacy format: { condition: "deadlock", action: "escalate_to_human" }
        if (typeof rule.condition === 'string' && typeof rule.action === 'string') {
          return {
            name: `legacy_${rule.condition}`,
            trigger: { type: rule.condition },
            action: { type: rule.action },
          };
        }
        return rule;
      });
    },
    z.array(EscalationRuleSchema).default([]),
  ),
});

const AgentConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9_-]+$/, 'Agent ID must be lowercase alphanumeric with hyphens/underscores'),
  name: z.string().min(1),
  role: z.string().min(1),
  expertise: z.array(z.string()).default([]),
  can_propose: z.boolean().default(true),
  can_veto: z.boolean().default(false),
  voting_weight: z.number().positive().default(1),
  model: z.string().optional(),
  system_prompt: z.string().min(1),
  persistent: z.boolean().default(false),
});

const CommunicationGraphSchema = z.object({
  default_policy: z.enum(['broadcast', 'graph']).default('broadcast'),
  edges: z.record(z.array(z.string())).default({}),
});

const EventRoutingMatchSchema = z.object({
  source: z.string(),
  type: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const EventRoutingAssignSchema = z.object({
  lead: z.string(),
  consult: z.array(z.string()).default([]),
  topics: z.array(z.string()).default([]),
});

const EventRoutingRuleSchema = z.object({
  match: EventRoutingMatchSchema,
  assign: EventRoutingAssignSchema,
});

const SpawnerConfigSchema = z.object({
  type: z.enum(['sdk', 'log', 'webhook']).default('log'),
  webhook_url: z.string().optional(),
  default_model: z.string().optional(),
  max_turns: z.number().int().min(1).optional(),
  timeout_ms: z.number().int().min(1000).optional(),
});

const GithubConfigSchema = z.object({
  webhook_secret: z.string(),
  repos: z.array(z.string()).default([]),
});

const CouncilBodySchema = z.object({
  name: z.string().min(1),
  description: z.string().default(''),
  spawner: SpawnerConfigSchema.default({ type: 'log' }),
  rules: CouncilRulesSchema,
  agents: z.array(AgentConfigSchema).min(1, 'At least one agent is required'),
  communication_graph: CommunicationGraphSchema.default({ default_policy: 'broadcast', edges: {} }),
  event_routing: z.array(EventRoutingRuleSchema).default([]),
  github: GithubConfigSchema.optional(),
});

export const CouncilConfigSchema = z.object({
  version: z.literal('1'),
  council: CouncilBodySchema,
});

export type ValidatedCouncilConfig = z.infer<typeof CouncilConfigSchema>;

// Validate agent references in event routing and communication graph
export function validateAgentReferences(config: ValidatedCouncilConfig): string[] {
  const errors: string[] = [];
  const agentIds = new Set(config.council.agents.map((a) => a.id));

  // Check event routing references
  for (const rule of config.council.event_routing) {
    if (!agentIds.has(rule.assign.lead)) {
      errors.push(`Event routing lead agent "${rule.assign.lead}" not found in agents`);
    }
    for (const consultId of rule.assign.consult) {
      if (!agentIds.has(consultId)) {
        errors.push(`Event routing consult agent "${consultId}" not found in agents`);
      }
    }
  }

  // Check communication graph edges
  for (const [from, targets] of Object.entries(config.council.communication_graph.edges)) {
    if (!agentIds.has(from)) {
      errors.push(`Communication graph source agent "${from}" not found in agents`);
    }
    for (const to of targets) {
      if (!agentIds.has(to)) {
        errors.push(`Communication graph target agent "${to}" not found in agents`);
      }
    }
  }

  // Check escalation rule agent references
  for (const rule of config.council.rules.escalation) {
    if (rule.action.agent_id && !agentIds.has(rule.action.agent_id)) {
      errors.push(`Escalation rule "${rule.name ?? 'unnamed'}" references unknown agent "${rule.action.agent_id}"`);
    }
  }

  return errors;
}
