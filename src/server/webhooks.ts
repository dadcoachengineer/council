import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { GithubWebhookEvent, GenericWebhookEvent } from '../shared/events.js';
import type { GithubConfig } from '../shared/types.js';

/**
 * Create webhook routes for GitHub and generic event ingestion.
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

      const body = JSON.stringify(req.body);
      const expected = 'sha256=' + createHmac('sha256', githubConfig.webhook_secret)
        .update(body)
        .digest('hex');

      if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
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
