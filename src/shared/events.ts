import type { Session, Message, Vote, Decision, IncomingEvent, EscalationEvent } from './types.js';

// ── WebSocket events (server → web UI) ──

export type WsEvent =
  | { type: 'session:created'; session: Session; councilId?: string }
  | { type: 'session:phase_changed'; sessionId: string; phase: string; councilId?: string }
  | { type: 'message:new'; message: Message; councilId?: string }
  | { type: 'amendment:resolved'; sessionId: string; amendmentId: string; status: string; councilId?: string }
  | { type: 'vote:cast'; vote: Vote; councilId?: string }
  | { type: 'decision:pending_review'; decision: Decision; councilId?: string }
  | { type: 'event:received'; event: IncomingEvent; councilId?: string }
  | { type: 'escalation:triggered'; event: EscalationEvent; councilId?: string }
  | { type: 'agent:connected'; agentId: string; councilId?: string }
  | { type: 'agent:disconnected'; agentId: string; councilId?: string }
  | { type: 'agent:session_assigned'; agentId: string; sessionId: string; councilId?: string };

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
