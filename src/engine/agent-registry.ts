import type { AgentConfig, AgentStatus } from '../shared/types.js';

interface RegisteredAgent {
  config: AgentConfig;
  connected: boolean;
  lastSeen: Date | null;
  token: string | null;
}

/**
 * Tracks agent configurations and connection status.
 * Agents register via their MCP connection (mapped by token).
 */
export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  private tokenToAgent = new Map<string, string>();

  /** Load agents from council config. */
  loadAgents(agents: AgentConfig[]): void {
    for (const config of agents) {
      this.agents.set(config.id, {
        config,
        connected: false,
        lastSeen: null,
        token: null,
      });
    }
  }

  /** Generate a token for an agent and register the mapping. */
  generateToken(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }
    // Simple token: council_<agentId>_<random>
    const token = `council_${agentId}_${crypto.randomUUID().slice(0, 8)}`;
    agent.token = token;
    this.tokenToAgent.set(token, agentId);
    return token;
  }

  /** Resolve an agent ID from a connection token. */
  resolveToken(token: string): string | null {
    return this.tokenToAgent.get(token) ?? null;
  }

  /** Mark an agent as connected. */
  connect(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.connected = true;
      agent.lastSeen = new Date();
    }
  }

  /** Mark an agent as disconnected. */
  disconnect(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.connected = false;
    }
  }

  /** Get agent config by ID. */
  getAgent(agentId: string): AgentConfig | null {
    return this.agents.get(agentId)?.config ?? null;
  }

  /** Check if an agent is currently connected. */
  isConnected(agentId: string): boolean {
    return this.agents.get(agentId)?.connected ?? false;
  }

  /** Get all agent statuses. */
  getStatuses(): AgentStatus[] {
    return Array.from(this.agents.values()).map((a) => ({
      id: a.config.id,
      name: a.config.name,
      role: a.config.role,
      connected: a.connected,
      lastSeen: a.lastSeen?.toISOString() ?? null,
    }));
  }

  /** Get all agent configs. */
  getAllConfigs(): AgentConfig[] {
    return Array.from(this.agents.values()).map((a) => a.config);
  }

  /** Touch lastSeen for an agent. */
  touch(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.lastSeen = new Date();
    }
  }
}
