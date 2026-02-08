import type { AgentConfig, AgentStatus } from '../shared/types.js';

interface RegisteredAgent {
  config: AgentConfig;
  connected: boolean;
  lastSeen: Date | null;
  token: string | null;
  connectionMode: 'per_session' | 'persistent';
  activeSessions: Set<string>;
  persistentToken: string | null;
}

/**
 * Tracks agent configurations and connection status.
 * Agents register via their MCP connection (mapped by token).
 */
export class AgentRegistry {
  private agents = new Map<string, RegisteredAgent>();
  private tokenToAgent = new Map<string, string>();
  private persistentTokenToAgent = new Map<string, string>();

  /** Load agents from council config. */
  loadAgents(agents: AgentConfig[]): void {
    for (const config of agents) {
      this.agents.set(config.id, {
        config,
        connected: false,
        lastSeen: null,
        token: null,
        connectionMode: config.persistent ? 'persistent' : 'per_session',
        activeSessions: new Set(),
        persistentToken: null,
      });
    }
  }

  /** Generate a token for an agent and register the mapping. */
  generateToken(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // Persistent agents reuse their persistent token
    if (agent.connectionMode === 'persistent') {
      if (agent.persistentToken) {
        return agent.persistentToken;
      }
      return this.generatePersistentToken(agentId);
    }

    // Per-session agents get a fresh token each time
    const token = `council_${agentId}_${crypto.randomUUID().slice(0, 8)}`;
    agent.token = token;
    this.tokenToAgent.set(token, agentId);
    return token;
  }

  /** Generate a persistent token for an agent. Idempotent — returns existing if already set. */
  generatePersistentToken(agentId: string): string {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    if (agent.persistentToken) {
      return agent.persistentToken;
    }

    const token = `council_persistent_${agentId}_${crypto.randomUUID().slice(0, 8)}`;
    agent.persistentToken = token;
    this.persistentTokenToAgent.set(token, agentId);
    return token;
  }

  /** Set a persistent token loaded from DB. */
  setPersistentToken(agentId: string, token: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    agent.persistentToken = token;
    this.persistentTokenToAgent.set(token, agentId);
  }

  /** Get persistent token for an agent, or null. */
  getPersistentToken(agentId: string): string | null {
    return this.agents.get(agentId)?.persistentToken ?? null;
  }

  /** Clear a persistent token for an agent. */
  clearPersistentToken(agentId: string): void {
    const agent = this.agents.get(agentId);
    if (!agent) return;
    if (agent.persistentToken) {
      this.persistentTokenToAgent.delete(agent.persistentToken);
      agent.persistentToken = null;
    }
  }

  /** Resolve an agent ID from a connection token (checks both per-session and persistent). */
  resolveToken(token: string): string | null {
    return this.tokenToAgent.get(token)
      ?? this.persistentTokenToAgent.get(token)
      ?? null;
  }

  /** Track a session assignment for an agent. */
  assignSession(agentId: string, sessionId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.activeSessions.add(sessionId);
    }
  }

  /** Remove a session assignment from an agent. */
  unassignSession(agentId: string, sessionId: string): void {
    const agent = this.agents.get(agentId);
    if (agent) {
      agent.activeSessions.delete(sessionId);
    }
  }

  /** Get all active session IDs for an agent. */
  getActiveSessions(agentId: string): string[] {
    return Array.from(this.agents.get(agentId)?.activeSessions ?? []);
  }

  /** Check if an agent is configured as persistent. */
  isPersistent(agentId: string): boolean {
    return this.agents.get(agentId)?.connectionMode === 'persistent';
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
      connectionMode: a.connectionMode,
      activeSessions: Array.from(a.activeSessions),
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
