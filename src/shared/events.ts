import type { Session, Message, Vote, Decision, IncomingEvent } from './types.js';

// ── WebSocket events (server → web UI) ──

export type WsEvent =
  | { type: 'session:created'; session: Session }
  | { type: 'session:phase_changed'; sessionId: string; phase: string }
  | { type: 'message:new'; message: Message }
  | { type: 'vote:cast'; vote: Vote }
  | { type: 'decision:pending_review'; decision: Decision }
  | { type: 'event:received'; event: IncomingEvent }
  | { type: 'agent:connected'; agentId: string }
  | { type: 'agent:disconnected'; agentId: string };

// ── Webhook event types ──

export interface GithubWebhookEvent {
  source: 'github';
  eventType: string; // e.g. "issues.opened", "pull_request.opened"
  payload: {
    action: string;
    repository: { full_name: string };
    issue?: {
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
      html_url: string;
    };
    pull_request?: {
      number: number;
      title: string;
      body: string | null;
      labels: Array<{ name: string }>;
      html_url: string;
    };
    sender: { login: string };
  };
}

export interface GenericWebhookEvent {
  source: 'generic';
  eventType: string;
  payload: unknown;
}

export type WebhookEvent = GithubWebhookEvent | GenericWebhookEvent;
