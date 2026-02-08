// ── User types ──

export type UserRole = 'admin' | 'member';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  totpEnabled: boolean;
  createdAt: string;
}

// ── Core domain types for Council ──

export type SessionPhase =
  | 'investigation'
  | 'proposal'
  | 'discussion'
  | 'refinement'
  | 'voting'
  | 'review'
  | 'decided'
  | 'closed';

export type VoteValue = 'approve' | 'reject' | 'abstain' | 'consent' | 'object';

export type DecisionOutcome = 'approved' | 'rejected' | 'escalated';

export type SpawnerType = 'sdk' | 'log' | 'webhook';

export type CommunicationPolicy = 'broadcast' | 'graph';

// ── Agent ──

export interface AgentConfig {
  id: string;
  name: string;
  role: string;
  expertise: string[];
  can_propose: boolean;
  can_veto: boolean;
  voting_weight: number;
  model?: string;
  system_prompt: string;
  persistent?: boolean;
}

export interface AgentStatus {
  id: string;
  name: string;
  role: string;
  connected: boolean;
  lastSeen: string | null;
  connectionMode: 'per_session' | 'persistent';
  activeSessions: string[];
}

// ── Council ──

// ── Voting schemes ──

export type VotingSchemeName =
  | 'weighted_majority'
  | 'unanimous'
  | 'supermajority'
  | 'consent_based'
  | 'advisory';

export interface VotingSchemeConfig {
  type: VotingSchemeName;
  preset?: 'two_thirds' | 'three_quarters';
  threshold?: number;
}

export type AmendmentStatus = 'proposed' | 'accepted' | 'rejected';
export type AmendmentResolution = 'lead_resolves' | 'auto_accept';

export interface CouncilRules {
  quorum: number;
  voting_threshold: number;
  voting_scheme?: VotingSchemeConfig;
  max_deliberation_rounds: number;
  require_human_approval: boolean;
  escalation: EscalationRule[];
  enable_refinement?: boolean;
  max_amendments?: number;
  amendment_resolution?: AmendmentResolution;
}

// ── Escalation ──

export type EscalationTriggerType =
  | 'deadlock'
  | 'quorum_not_met'
  | 'veto_exercised'
  | 'timeout'
  | 'max_rounds_exceeded';

export type EscalationActionType =
  | 'escalate_to_human'
  | 'restart_discussion'
  | 'add_agent'
  | 'auto_decide'
  | 'notify_external';

export interface EscalationTrigger {
  type: EscalationTriggerType;
  phases?: SessionPhase[];
  timeout_seconds?: number;
}

export interface EscalationAction {
  type: EscalationActionType;
  message?: string;
  agent_id?: string;
  forced_outcome?: DecisionOutcome;
  webhook_url?: string;
  payload_template?: Record<string, unknown>;
}

export interface EscalationRule {
  name?: string;
  priority?: number;
  trigger: EscalationTrigger;
  action: EscalationAction;
  stop_after?: boolean;
  max_fires_per_session?: number;
}

export interface EscalationEvent {
  id: string;
  sessionId: string;
  ruleName: string;
  triggerType: EscalationTriggerType;
  actionType: EscalationActionType;
  details: string;
  createdAt: string;
}

export interface CommunicationGraph {
  default_policy: CommunicationPolicy;
  edges: Record<string, string[]>;
}

export interface EventRoutingRule {
  match: {
    source: string;
    type?: string;
    labels?: string[];
  };
  assign: {
    lead: string;
    consult: string[];
  };
}

export interface SpawnerConfig {
  type: SpawnerType;
  webhook_url?: string;
  default_model?: string;
  max_turns?: number;
  timeout_ms?: number;
}

// ── Agent lifecycle events ──

export type AgentLifecycleEvent =
  | { type: 'agent:started'; agentId: string; sessionId: string }
  | { type: 'agent:completed'; agentId: string; sessionId: string; durationMs: number; cost?: number }
  | { type: 'agent:errored'; agentId: string; sessionId: string; error: string }
  | { type: 'agent:session_assigned'; agentId: string; sessionId: string };

export interface GithubConfig {
  webhook_secret: string;
  repos: string[];
}

export interface CouncilConfig {
  version: string;
  council: {
    name: string;
    description: string;
    spawner: SpawnerConfig;
    rules: CouncilRules;
    agents: AgentConfig[];
    communication_graph: CommunicationGraph;
    event_routing: EventRoutingRule[];
    github?: GithubConfig;
  };
}

// ── Persisted entities ──

export interface Council {
  id: string;
  name: string;
  description: string;
  config: CouncilConfig;
  createdAt: string;
}

export interface Session {
  id: string;
  councilId: string;
  title: string;
  phase: SessionPhase;
  leadAgentId: string | null;
  triggerEventId: string | null;
  activeProposalId: string | null;
  deliberationRound: number;
  createdAt: string;
  updatedAt: string;
}

export interface Message {
  id: string;
  sessionId: string;
  fromAgentId: string;
  toAgentId: string | null; // null = broadcast
  content: string;
  messageType: 'discussion' | 'consultation' | 'finding' | 'proposal' | 'amendment';
  parentMessageId: string | null;
  amendmentStatus: AmendmentStatus | null;
  createdAt: string;
}

export interface Vote {
  id: string;
  sessionId: string;
  agentId: string;
  value: VoteValue;
  reasoning: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  sessionId: string;
  outcome: DecisionOutcome;
  summary: string;
  humanReviewedBy: string | null;
  humanNotes: string | null;
  createdAt: string;
}

export interface IncomingEvent {
  id: string;
  councilId: string;
  source: string;
  eventType: string;
  payload: unknown;
  sessionId: string | null;
  createdAt: string;
}

// ── Spawner ──

export interface SessionAssignment {
  sessionId: string;
  role: 'lead' | 'consulted';
  context: string;
}

export interface SpawnTask {
  sessionId: string;
  agentConfig: AgentConfig;
  context: string;
  councilMcpUrl: string;
  agentToken: string;
  connectionMode?: 'per_session' | 'persistent';
}

export interface AgentSpawner {
  spawn(task: SpawnTask): Promise<void>;
}

// ── Vote tally ──

export interface VoteTally {
  approve: number;
  reject: number;
  abstain: number;
  totalWeight: number;
  quorumMet: boolean;
  thresholdMet: boolean;
  outcome: DecisionOutcome | null;
  vetoExercised: boolean;
}
