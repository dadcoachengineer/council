import { Router, type Request, type Response, type NextFunction } from 'express';
import type { OrchestratorRegistry, OrchestratorEntry } from '../engine/orchestrator-registry.js';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { DbStore } from './db.js';
import { parseConfig } from '../engine/config-loader.js';
import { nanoid } from 'nanoid';
import type { SessionPhase } from '../shared/types.js';

// Augment Express Request to carry the resolved orchestrator entry
declare module 'express' {
  interface Request {
    councilEntry?: OrchestratorEntry;
    resolvedCouncilId?: string;
  }
}

export interface ApiRouterOptions {
  /** Called after a new council is created via POST /councils so the caller can wire MCP, WS, etc. */
  onCouncilCreated?: (councilId: string, entry: OrchestratorEntry) => void;
  /** Called after a council is deleted via DELETE /councils/:id. */
  onCouncilDeleted?: (councilId: string) => void;
}

/**
 * REST API routes for the web UI.
 */
export function createApiRouter(
  registry: OrchestratorRegistry,
  store: DbStore,
  opts?: ApiRouterOptions,
): Router {
  const router = Router();

  // Helper: resolve council from route param or query, falling back to default
  function resolveOrchestrator(councilId: string | undefined): { orchestrator: Orchestrator; councilId: string } | null {
    if (councilId) {
      const entry = registry.get(councilId);
      if (!entry) return null;
      return { orchestrator: entry.orchestrator, councilId };
    }
    const defaultEntry = registry.getDefault();
    const defaultId = registry.getDefaultId();
    if (!defaultEntry || !defaultId) return null;
    return { orchestrator: defaultEntry.orchestrator, councilId: defaultId };
  }

  // Middleware for council-scoped routes: resolve `:councilId` param
  function resolveCouncilMiddleware(req: Request, res: Response, next: NextFunction): void {
    const councilId = String(req.params.councilId);
    const entry = registry.get(councilId);
    if (!entry) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }
    req.councilEntry = entry;
    req.resolvedCouncilId = councilId;
    next();
  }

  // ── Councils ──

  router.get('/councils', (_req: Request, res: Response) => {
    const councils = store.listCouncils();
    res.json(councils.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      agentCount: c.config.council.agents.length,
      createdAt: c.createdAt,
      active: registry.get(c.id) !== null,
    })));
  });

  router.post('/councils', (req: Request, res: Response) => {
    try {
      const { yaml: yamlContent } = req.body;
      if (!yamlContent || typeof yamlContent !== 'string') {
        res.status(400).json({ error: 'Request body must include "yaml" string field' });
        return;
      }

      const config = parseConfig(yamlContent);
      const councilId = nanoid();
      const council = {
        id: councilId,
        name: config.council.name,
        description: config.council.description,
        config,
        createdAt: new Date().toISOString(),
      };
      store.saveCouncil(council);

      // Spin up a live orchestrator for this council
      const mcpBaseUrl = `${req.protocol}://${req.get('host')}/mcp`;
      const entry = registry.create(councilId, config, store, mcpBaseUrl);

      // Persist council in DB
      if (!store.getCouncil(councilId)) {
        store.saveCouncil(council);
      }

      // Notify caller to wire up MCP notifications, WS subscriptions, etc.
      opts?.onCouncilCreated?.(councilId, entry);

      res.status(201).json(council);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/councils/:id', (req: Request, res: Response) => {
    const councilId = String(req.params.id);
    const council = store.getCouncil(councilId);
    if (!council) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }

    const entry = registry.get(councilId);
    const agents = entry?.agentRegistry.getStatuses() ?? [];
    res.json({ ...council, agents, active: entry !== null });
  });

  router.delete('/councils/:id', (req: Request, res: Response) => {
    const councilId = String(req.params.id);
    const council = store.getCouncil(councilId);
    if (!council) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }

    // Don't allow deleting the default council if it's the only one
    if (registry.size <= 1 && registry.getDefaultId() === councilId) {
      res.status(400).json({ error: 'Cannot delete the only active council' });
      return;
    }

    registry.remove(councilId);
    store.deleteCouncil(councilId);
    opts?.onCouncilDeleted?.(councilId);

    res.json({ status: 'deleted' });
  });

  // ── Council-scoped routes ──

  router.get('/councils/:councilId/sessions', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const phase = req.query.phase as SessionPhase | undefined;
    const sessions = req.councilEntry!.orchestrator.listSessions(phase);
    res.json(sessions);
  });

  router.post('/councils/:councilId/sessions', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const { title, topics } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Request body must include "title" string field' });
      return;
    }
    if (topics !== undefined && (!Array.isArray(topics) || !topics.every((t: unknown) => typeof t === 'string'))) {
      res.status(400).json({ error: '"topics" must be an array of strings' });
      return;
    }
    const session = req.councilEntry!.orchestrator.createSession({ title, topics });
    res.status(201).json(session);
  });

  router.get('/councils/:councilId/sessions/:id', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const session = req.councilEntry!.orchestrator.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }
    const orch = req.councilEntry!.orchestrator;
    const messages = orch.getMessages(session.id);
    const votes = orch.getVotes(session.id);
    const decision = orch.getDecision(session.id);
    res.json({ session, messages, votes, decision });
  });

  router.post('/councils/:councilId/sessions/:id/review', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const { action, notes } = req.body;
    if (!action) {
      res.status(400).json({ error: 'Request body must include "action" field' });
      return;
    }
    const reviewedBy = req.user?.displayName ?? req.body.reviewedBy ?? 'Unknown';
    try {
      req.councilEntry!.orchestrator.submitReview(String(req.params.id), action, reviewedBy, notes);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/councils/:councilId/events', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const events = req.councilEntry!.orchestrator.listEvents(50);
    res.json(events);
  });

  router.get('/councils/:councilId/agents', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const agents = req.councilEntry!.agentRegistry.getStatuses();
    res.json(agents);
  });

  router.get('/councils/:councilId/decisions', resolveCouncilMiddleware, (req: Request, res: Response) => {
    const decisions = req.councilEntry!.orchestrator.listPendingDecisions();
    res.json(decisions);
  });

  // ── Flat routes (backward compatible) — use ?councilId= query param or default council ──

  router.get('/sessions', (req: Request, res: Response) => {
    const phase = req.query.phase as SessionPhase | undefined;
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const sessions = resolved.orchestrator.listSessions(phase);
    res.json(sessions);
  });

  router.post('/sessions', (req: Request, res: Response) => {
    const { title, topics } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Request body must include "title" string field' });
      return;
    }
    if (topics !== undefined && (!Array.isArray(topics) || !topics.every((t: unknown) => typeof t === 'string'))) {
      res.status(400).json({ error: '"topics" must be an array of strings' });
      return;
    }

    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }

    const session = resolved.orchestrator.createSession({ title, topics });
    res.status(201).json(session);
  });

  router.get('/sessions/:id', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const session = resolved.orchestrator.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messages = resolved.orchestrator.getMessages(session.id);
    const votes = resolved.orchestrator.getVotes(session.id);
    const decision = resolved.orchestrator.getDecision(session.id);

    res.json({ session, messages, votes, decision });
  });

  router.post('/sessions/:id/phase', (req: Request, res: Response) => {
    const { phase } = req.body;
    if (!phase) {
      res.status(400).json({ error: 'Request body must include "phase" field' });
      return;
    }

    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }

    try {
      resolved.orchestrator.transitionPhase(String(req.params.id), phase);
      res.json({ status: 'ok', phase });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/sessions/:id/review', (req: Request, res: Response) => {
    const { action, notes } = req.body;
    if (!action) {
      res.status(400).json({ error: 'Request body must include "action" field' });
      return;
    }

    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }

    // Use authenticated user's name, fall back to body.reviewedBy for backward compat
    const reviewedBy = req.user?.displayName ?? req.body.reviewedBy ?? 'Unknown';

    try {
      resolved.orchestrator.submitReview(String(req.params.id), action, reviewedBy, notes);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Amendments ──

  router.get('/sessions/:id/amendments', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const sessionId = String(req.params.id);
    const messages = resolved.orchestrator.getMessages(sessionId);
    const amendments = messages.filter((m) => m.messageType === 'amendment');
    res.json(amendments);
  });

  // ── Escalation Events ──

  router.get('/sessions/:id/escalations', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const escalations = resolved.orchestrator.getEscalationEvents(String(req.params.id));
    res.json(escalations);
  });

  // ── Events ──

  router.get('/events', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const events = resolved.orchestrator.listEvents(50);
    res.json(events);
  });

  // ── Agents ──

  router.get('/agents', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const agents = resolved.orchestrator.getAgentRegistry().getStatuses();
    res.json(agents);
  });

  // ── Decisions ──

  router.get('/decisions', (req: Request, res: Response) => {
    const resolved = resolveOrchestrator(req.query.councilId as string | undefined);
    if (!resolved) {
      res.status(404).json({ error: 'No council available' });
      return;
    }
    const decisions = resolved.orchestrator.listPendingDecisions();
    res.json(decisions);
  });

  return router;
}
