import { WebSocketServer, type WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { Orchestrator, OrchestratorEvent } from '../engine/orchestrator.js';
import type { WsEvent } from '../shared/events.js';

/**
 * Set up WebSocket server for real-time events to the web UI.
 * Bridges orchestrator events to connected WebSocket clients.
 */
export function setupWebSocket(httpServer: HttpServer, orchestrator: Orchestrator): WebSocketServer {
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

  // Bridge orchestrator events to WebSocket
  orchestrator.onEvent((event: OrchestratorEvent) => {
    const wsEvent = toWsEvent(event);
    if (!wsEvent) return;

    const data = JSON.stringify(wsEvent);
    for (const client of clients) {
      if (client.readyState === client.OPEN) {
        client.send(data);
      }
    }
  });

  return wss;
}

function toWsEvent(event: OrchestratorEvent): WsEvent | null {
  switch (event.type) {
    case 'session:created':
      return { type: 'session:created', session: event.session };
    case 'session:phase_changed':
      return { type: 'session:phase_changed', sessionId: event.sessionId, phase: event.phase };
    case 'message:new':
      return { type: 'message:new', message: event.message };
    case 'vote:cast':
      return { type: 'vote:cast', vote: event.vote };
    case 'decision:pending_review':
      return { type: 'decision:pending_review', decision: event.decision };
    case 'event:received':
      return { type: 'event:received', event: event.event };
    case 'escalation:triggered':
      return { type: 'escalation:triggered', event: event.event };
    default:
      return null;
  }
}
