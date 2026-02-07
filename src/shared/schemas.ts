import { z } from 'zod';

// ── Zod schemas for YAML config validation ──

const EscalationRuleSchema = z.object({
  condition: z.string(),
  action: z.string(),
});

const CouncilRulesSchema = z.object({
  quorum: z.number().int().min(1),
  voting_threshold: z.number().min(0).max(1),
  max_deliberation_rounds: z.number().int().min(1).default(5),
  require_human_approval: z.boolean().default(true),
  escalation: z.array(EscalationRuleSchema).default([]),
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

  return errors;
}
