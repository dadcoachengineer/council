import type { CommunicationGraph, Message } from '../shared/types.js';

export type MessageHandler = (message: Message) => void;

/**
 * Graph-aware message routing bus.
 *
 * When policy is "broadcast", all messages go to all subscribers.
 * When policy is "graph", messages are only delivered if an edge exists
 * from sender to recipient (or if the message is a broadcast).
 */
export class MessageBus {
  private handlers = new Map<string, Set<MessageHandler>>();
  private globalHandlers = new Set<MessageHandler>();
  private graph: CommunicationGraph;

  constructor(graph: CommunicationGraph) {
    this.graph = graph;
  }

  /** Subscribe to messages for a specific agent. */
  subscribe(agentId: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(agentId)) {
      this.handlers.set(agentId, new Set());
    }
    this.handlers.get(agentId)!.add(handler);
    return () => {
      this.handlers.get(agentId)?.delete(handler);
    };
  }

  /** Subscribe to all messages (e.g. for persistence, WebSocket broadcast). */
  subscribeAll(handler: MessageHandler): () => void {
    this.globalHandlers.add(handler);
    return () => {
      this.globalHandlers.delete(handler);
    };
  }

  /** Route a message according to the communication graph. */
  publish(message: Message): void {
    // Always notify global handlers (for persistence/logging)
    for (const handler of this.globalHandlers) {
      handler(message);
    }

    if (message.toAgentId) {
      // Directed message: check graph policy
      if (this.canCommunicate(message.fromAgentId, message.toAgentId)) {
        const handlers = this.handlers.get(message.toAgentId);
        if (handlers) {
          for (const handler of handlers) {
            handler(message);
          }
        }
      }
    } else {
      // Broadcast: deliver to all subscribed agents except sender
      for (const [agentId, handlers] of this.handlers) {
        if (agentId === message.fromAgentId) continue;
        if (this.canCommunicate(message.fromAgentId, agentId)) {
          for (const handler of handlers) {
            handler(message);
          }
        }
      }
    }
  }

  /** Check if agent A can send a message to agent B. */
  canCommunicate(fromId: string, toId: string): boolean {
    if (this.graph.default_policy === 'broadcast') {
      return true;
    }
    // Graph policy: check for an explicit edge
    const edges = this.graph.edges[fromId];
    return edges ? edges.includes(toId) : false;
  }

  /** Update the communication graph (e.g. on config reload). */
  updateGraph(graph: CommunicationGraph): void {
    this.graph = graph;
  }
}
