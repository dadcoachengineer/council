import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { GithubWebhookEvent, GenericWebhookEvent } from '../shared/events.js';
import type { GithubConfig } from '../shared/types.js';

// Augment Express Request to carry raw body bytes captured by verify callback
declare module 'express' {
  interface Request {
    rawBody?: Buffer;
  }
}

function verifyGithubSignature(rawBody: Buffer, secret: string, signature: string): boolean {
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
  const sigBuf = Buffer.from(signature);
  const expBuf = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch — reject early
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

/**
 * Create webhook routes for GitHub and generic event ingestion.
 * IMPORTANT: The webhook router must be mounted with its own JSON body parser
 * that captures raw bytes (see createWebhookJsonParser).
 */
export function createWebhookRouter(
  orchestrator: Orchestrator,
  githubConfig?: GithubConfig,
): Router {
  const router = Router();

  // ── GitHub webhook ──
  router.post('/github', async (req: Request, res: Response) => {
    // Verify signature if secret is configured
    if (githubConfig?.webhook_secret) {
      const signature = req.headers['x-hub-signature-256'] as string | undefined;
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }

      const rawBody = req.rawBody;
      if (!rawBody) {
        res.status(500).json({ error: 'Raw body not captured — check middleware order' });
        return;
      }

      if (!verifyGithubSignature(rawBody, githubConfig.webhook_secret, signature)) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
    }

    const ghEventType = req.headers['x-github-event'] as string;
    const payload = req.body;

    if (!ghEventType || !payload) {
      res.status(400).json({ error: 'Missing event type or payload' });
      return;
    }

    // Construct event type as "type.action" (e.g. "issues.opened")
    const eventType = payload.action ? `${ghEventType}.${payload.action}` : ghEventType;

    // Check repo filter
    if (githubConfig?.repos && githubConfig.repos.length > 0) {
      const repoName = payload.repository?.full_name;
      if (repoName && !githubConfig.repos.includes(repoName)) {
        res.status(200).json({ status: 'ignored', reason: 'repo not in allowlist' });
        return;
      }
    }

    const event: GithubWebhookEvent = {
      source: 'github',
      eventType,
      payload: {
        action: payload.action ?? '',
        repository: payload.repository ?? { full_name: 'unknown' },
        issue: payload.issue,
        pull_request: payload.pull_request,
        sender: payload.sender ?? { login: 'unknown' },
      },
    };

    try {
      const session = await orchestrator.handleWebhookEvent(event);
      if (session) {
        res.status(201).json({ status: 'session_created', sessionId: session.id });
      } else {
        res.status(200).json({ status: 'no_matching_rule' });
      }
    } catch (err) {
      console.error('[WEBHOOK:GITHUB] Error processing event:', err);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  // ── Generic webhook ──
  router.post('/ingest', async (req: Request, res: Response) => {
    const eventType = (req.headers['x-event-type'] as string) ?? 'generic';
    const payload = req.body;

    if (!payload) {
      res.status(400).json({ error: 'Missing payload' });
      return;
    }

    const event: GenericWebhookEvent = {
      source: 'generic',
      eventType,
      payload,
    };

    try {
      const session = await orchestrator.handleWebhookEvent(event);
      if (session) {
        res.status(201).json({ status: 'session_created', sessionId: session.id });
      } else {
        res.status(200).json({ status: 'no_matching_rule' });
      }
    } catch (err) {
      console.error('[WEBHOOK:GENERIC] Error processing event:', err);
      res.status(500).json({ error: 'Internal error processing webhook' });
    }
  });

  return router;
}
