import { Router, type Request, type Response } from 'express';
import type { Orchestrator } from '../engine/orchestrator.js';
import type { DbStore } from './db.js';
import { parseConfig } from '../engine/config-loader.js';
import { nanoid } from 'nanoid';
import type { SessionPhase } from '../shared/types.js';

/**
 * REST API routes for the web UI.
 */
export function createApiRouter(orchestrator: Orchestrator, store: DbStore): Router {
  const router = Router();

  // ── Councils ──

  router.get('/councils', (_req: Request, res: Response) => {
    const councils = store.listCouncils();
    res.json(councils.map((c) => ({
      id: c.id,
      name: c.name,
      description: c.description,
      agentCount: c.config.council.agents.length,
      createdAt: c.createdAt,
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
      const council = {
        id: nanoid(),
        name: config.council.name,
        description: config.council.description,
        config,
        createdAt: new Date().toISOString(),
      };
      store.saveCouncil(council);
      res.status(201).json(council);
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.get('/councils/:id', (req: Request, res: Response) => {
    const council = store.getCouncil(String(req.params.id));
    if (!council) {
      res.status(404).json({ error: 'Council not found' });
      return;
    }

    const agents = orchestrator.getAgentRegistry().getStatuses();
    res.json({ ...council, agents });
  });

  // ── Sessions ──

  router.get('/sessions', (req: Request, res: Response) => {
    const phase = req.query.phase as SessionPhase | undefined;
    const sessions = orchestrator.listSessions(phase);
    res.json(sessions);
  });

  router.post('/sessions', (req: Request, res: Response) => {
    const { title } = req.body;
    if (!title || typeof title !== 'string') {
      res.status(400).json({ error: 'Request body must include "title" string field' });
      return;
    }

    const session = orchestrator.createSession({ title });
    res.status(201).json(session);
  });

  router.get('/sessions/:id', (req: Request, res: Response) => {
    const session = orchestrator.getSession(String(req.params.id));
    if (!session) {
      res.status(404).json({ error: 'Session not found' });
      return;
    }

    const messages = orchestrator.getMessages(session.id);
    const votes = orchestrator.getVotes(session.id);
    const decision = orchestrator.getDecision(session.id);

    res.json({ session, messages, votes, decision });
  });

  router.post('/sessions/:id/phase', (req: Request, res: Response) => {
    const { phase } = req.body;
    if (!phase) {
      res.status(400).json({ error: 'Request body must include "phase" field' });
      return;
    }

    try {
      orchestrator.transitionPhase(String(req.params.id), phase);
      res.json({ status: 'ok', phase });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  router.post('/sessions/:id/review', (req: Request, res: Response) => {
    const { action, reviewedBy, notes } = req.body;
    if (!action || !reviewedBy) {
      res.status(400).json({ error: 'Request body must include "action" and "reviewedBy" fields' });
      return;
    }

    try {
      orchestrator.submitReview(String(req.params.id), action, reviewedBy, notes);
      res.json({ status: 'ok' });
    } catch (err) {
      res.status(400).json({ error: (err as Error).message });
    }
  });

  // ── Escalation Events ──

  router.get('/sessions/:id/escalations', (req: Request, res: Response) => {
    const escalations = orchestrator.getEscalationEvents(String(req.params.id));
    res.json(escalations);
  });

  // ── Events ──

  router.get('/events', (_req: Request, res: Response) => {
    const events = orchestrator.listEvents(50);
    res.json(events);
  });

  // ── Agents ──

  router.get('/agents', (_req: Request, res: Response) => {
    const agents = orchestrator.getAgentRegistry().getStatuses();
    res.json(agents);
  });

  // ── Decisions ──

  router.get('/decisions', (_req: Request, res: Response) => {
    const decisions = orchestrator.listPendingDecisions();
    res.json(decisions);
  });

  return router;
}
