import { EventRouter } from './event-router.js';
import { MessageBus } from './message-bus.js';
import { AgentRegistry } from './agent-registry.js';
import { createSpawner } from './spawner.js';
import { Orchestrator, type OrchestratorStore } from './orchestrator.js';
import { EscalationEngine } from './escalation-engine.js';
import type { CouncilConfig } from '../shared/types.js';

export interface OrchestratorEntry {
  orchestrator: Orchestrator;
  config: CouncilConfig;
  agentRegistry: AgentRegistry;
  eventRouter: EventRouter;
}

/**
 * Registry mapping councilId → Orchestrator + engine stack.
 * Supports multiple councils running in a single server process.
 */
export class OrchestratorRegistry {
  private entries = new Map<string, OrchestratorEntry>();
  private defaultCouncilId: string | null = null;

  /**
   * Register a pre-built entry. First registered council becomes the default.
   */
  register(councilId: string, entry: OrchestratorEntry): void {
    this.entries.set(councilId, entry);
    if (this.defaultCouncilId === null) {
      this.defaultCouncilId = councilId;
    }
  }

  /**
   * Build and register a full engine stack from a CouncilConfig.
   * Extracts the construction logic that was previously inline in createApp().
   */
  create(
    councilId: string,
    config: CouncilConfig,
    store: OrchestratorStore,
    mcpBaseUrl: string,
  ): OrchestratorEntry {
    const eventRouter = new EventRouter(config.council.event_routing);
    const messageBus = new MessageBus(config.council.communication_graph);
    const agentRegistry = new AgentRegistry();
    agentRegistry.loadAgents(config.council.agents);
    const spawner = createSpawner(config.council.spawner, agentRegistry);

    const orchestrator = new Orchestrator({
      config,
      councilId,
      eventRouter,
      messageBus,
      agentRegistry,
      spawner,
      store,
      mcpBaseUrl,
    });

    // Set up escalation engine if rules are defined
    if (config.council.rules.escalation.length > 0) {
      const escalationEngine = new EscalationEngine(config, orchestrator);
      orchestrator.setEscalationEngine(escalationEngine);
      escalationEngine.start();
    }

    const entry: OrchestratorEntry = {
      orchestrator,
      config,
      agentRegistry,
      eventRouter,
    };

    this.register(councilId, entry);
    return entry;
  }

  /** Get an entry by councilId. */
  get(councilId: string): OrchestratorEntry | null {
    return this.entries.get(councilId) ?? null;
  }

  /** Remove a council from the registry. */
  remove(councilId: string): boolean {
    const deleted = this.entries.delete(councilId);
    if (deleted && this.defaultCouncilId === councilId) {
      // Pick a new default if available
      const first = this.entries.keys().next();
      this.defaultCouncilId = first.done ? null : first.value;
    }
    return deleted;
  }

  /** Get the default council entry. */
  getDefault(): OrchestratorEntry | null {
    if (!this.defaultCouncilId) return null;
    return this.entries.get(this.defaultCouncilId) ?? null;
  }

  /** Get the default council ID. */
  getDefaultId(): string | null {
    return this.defaultCouncilId;
  }

  /** List all registered councils. */
  list(): Array<{ councilId: string; entry: OrchestratorEntry }> {
    return Array.from(this.entries.entries()).map(([councilId, entry]) => ({
      councilId,
      entry,
    }));
  }

  /**
   * Resolve an agent token across all councils.
   * Returns the matching agentId, councilId, and entry.
   */
  resolveAgentToken(token: string): { agentId: string; councilId: string; entry: OrchestratorEntry } | null {
    for (const [councilId, entry] of this.entries) {
      const agentId = entry.agentRegistry.resolveToken(token);
      if (agentId) {
        return { agentId, councilId, entry };
      }
    }
    return null;
  }

  /** Number of registered councils. */
  get size(): number {
    return this.entries.size;
  }
}
