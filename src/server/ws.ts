import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { Orchestrator, OrchestratorEvent } from '../engine/orchestrator.js';
import type { OrchestratorRegistry } from '../engine/orchestrator-registry.js';
import type { WsEvent } from '../shared/events.js';

export interface WsSetupResult {
  wss: WebSocketServer;
  /** Subscribe a dynamically-added council to the WebSocket broadcast. */
  addCouncil: (councilId: string, orchestrator: Orchestrator) => void;
}

/**
 * Set up WebSocket server for real-time events to the web UI.
 * Bridges orchestrator events from all councils to connected WebSocket clients.
 */
export function setupWebSocket(httpServer: HttpServer, registry: OrchestratorRegistry): WsSetupResult {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
  const clients = new Set<WebSocket>();

  wss.on('connection', (ws) => {
    clients.add(ws);
    console.log(`[WS] Client connected (${clients.size} total)`);

    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected (${clients.size} total)`);
    });

    ws.on('error', (err) => {
      console.error('[WS] Client error:', err.message);
      clients.delete(ws);
    });
  });

  function broadcast(wsEvent: WsEvent): void {
    const data = JSON.stringify(wsEvent);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  }

  function subscribeCouncil(councilId: string, orchestrator: Orchestrator): void {
    orchestrator.onEvent((event: OrchestratorEvent) => {
      const wsEvent = toWsEvent(event, councilId);
      if (!wsEvent) return;
      broadcast(wsEvent);
    });
  }

  // Subscribe to all existing councils
  for (const { councilId, entry } of registry.list()) {
    subscribeCouncil(councilId, entry.orchestrator);
  }

  return {
    wss,
    addCouncil: subscribeCouncil,
  };
}

function toWsEvent(event: OrchestratorEvent, councilId: string): WsEvent | null {
  switch (event.type) {
    case 'session:created':
      return { type: 'session:created', session: event.session, councilId };
    case 'session:phase_changed':
      return { type: 'session:phase_changed', sessionId: event.sessionId, phase: event.phase, councilId };
    case 'message:new':
      return { type: 'message:new', message: event.message, councilId };
    case 'amendment:resolved':
      return { type: 'amendment:resolved', sessionId: event.sessionId, amendmentId: event.amendmentId, status: event.status, councilId };
    case 'vote:cast':
      return { type: 'vote:cast', vote: event.vote, councilId };
    case 'decision:pending_review':
      return { type: 'decision:pending_review', decision: event.decision, councilId };
    case 'event:received':
      return { type: 'event:received', event: event.event, councilId };
    case 'escalation:triggered':
      return { type: 'escalation:triggered', event: event.event, councilId };
    case 'agent:session_assigned':
      return { type: 'agent:session_assigned', agentId: event.agentId, sessionId: event.sessionId, councilId };
    default:
      return null;
  }
}
