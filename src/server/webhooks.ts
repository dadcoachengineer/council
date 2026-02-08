import { createHmac, timingSafeEqual } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import type { OrchestratorRegistry } from '../engine/orchestrator-registry.js';
import type { GithubWebhookEvent, GenericWebhookEvent } from '../shared/events.js';

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
 * Dispatches to targeted council via ?councilId= or broadcasts across all councils.
 *
 * IMPORTANT: The webhook router must be mounted with its own JSON body parser
 * that captures raw bytes (see createWebhookJsonParser).
 */
export function createWebhookRouter(registry: OrchestratorRegistry): Router {
  const router = Router();

  // ── GitHub webhook ──
  router.post('/github', async (req: Request, res: Response) => {
    const targetCouncilId = req.query.councilId as string | undefined;

    // Determine which councils to try
    const entries = targetCouncilId
      ? (() => {
          const entry = registry.get(targetCouncilId);
          return entry ? [{ councilId: targetCouncilId, entry }] : [];
        })()
      : registry.list();

    if (entries.length === 0) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }

    // Verify HMAC signature — try each council's secret until one matches
    const signature = req.headers['x-hub-signature-256'] as string | undefined;
    const rawBody = req.rawBody;

    let signatureVerified = false;
    let matchedEntries = entries;

    // If any council has a webhook secret, we need signature verification
    const secretEntries = entries.filter(({ entry }) => entry.config.council.github?.webhook_secret);
    if (secretEntries.length > 0) {
      if (!signature) {
        res.status(401).json({ error: 'Missing signature' });
        return;
      }
      if (!rawBody) {
        res.status(500).json({ error: 'Raw body not captured — check middleware order' });
        return;
      }

      // Find councils whose secret matches the signature
      matchedEntries = secretEntries.filter(({ entry }) =>
        verifyGithubSignature(rawBody, entry.config.council.github!.webhook_secret, signature),
      );

      // Also include councils without a secret configured
      const noSecretEntries = entries.filter(({ entry }) => !entry.config.council.github?.webhook_secret);
      matchedEntries = [...matchedEntries, ...noSecretEntries];

      if (matchedEntries.length === 0) {
        res.status(401).json({ error: 'Invalid signature' });
        return;
      }
      signatureVerified = true;
    }

    const ghEventType = req.headers['x-github-event'] as string;
    const payload = req.body;

    if (!ghEventType || !payload) {
      res.status(400).json({ error: 'Missing event type or payload' });
      return;
    }

    // Construct event type as "type.action" (e.g. "issues.opened")
    const eventType = payload.action ? `${ghEventType}.${payload.action}` : ghEventType;

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

    // Dispatch to matched councils — first match wins for session creation
    for (const { councilId, entry } of matchedEntries) {
      const githubConfig = entry.config.council.github;

      // Check repo filter
      if (githubConfig?.repos && githubConfig.repos.length > 0) {
        const repoName = payload.repository?.full_name;
        if (repoName && !githubConfig.repos.includes(repoName)) {
          continue;
        }
      }

      try {
        const session = await entry.orchestrator.handleWebhookEvent(event);
        if (session) {
          res.status(201).json({ status: 'session_created', sessionId: session.id, councilId });
          return;
        }
      } catch (err) {
        console.error(`[WEBHOOK:GITHUB] Error processing event for council ${councilId}:`, err);
      }
    }

    res.status(200).json({ status: 'no_matching_rule' });
  });

  // ── Generic webhook ──
  router.post('/ingest', async (req: Request, res: Response) => {
    const targetCouncilId = req.query.councilId as string | undefined;
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

    // Determine which councils to try
    const entries = targetCouncilId
      ? (() => {
          const entry = registry.get(targetCouncilId);
          return entry ? [{ councilId: targetCouncilId, entry }] : [];
        })()
      : registry.list();

    if (entries.length === 0 && targetCouncilId) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }

    // Dispatch — first match wins
    for (const { councilId, entry } of entries) {
      try {
        const session = await entry.orchestrator.handleWebhookEvent(event);
        if (session) {
          res.status(201).json({ status: 'session_created', sessionId: session.id, councilId });
          return;
        }
      } catch (err) {
        console.error(`[WEBHOOK:GENERIC] Error processing event for council ${councilId}:`, err);
      }
    }

    res.status(200).json({ status: 'no_matching_rule' });
  });

  return router;
}
