import { Router, type Request, type Response } from 'express';
import type { UserStore } from './user-store.js';
import type { DbStore } from './db.js';
import type { OrchestratorRegistry } from '../engine/orchestrator-registry.js';
import type { PublicUser } from '../shared/types.js';

function toPublicUser(row: { id: string; email: string; displayName: string; role: string; totpVerified: number; createdAt: string }): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role as PublicUser['role'],
    totpEnabled: row.totpVerified === 1,
    createdAt: row.createdAt,
  };
}

export function createAdminRouter(userStore: UserStore, store?: DbStore, registry?: OrchestratorRegistry): Router {
  const router = Router();

  // GET /api/admin/users — list all users
  router.get('/users', (_req: Request, res: Response) => {
    const rows = userStore.listUsers();
    res.json(rows.map(toPublicUser));
  });

  // POST /api/admin/users — create new user
  router.post('/users', async (req: Request, res: Response) => {
    const { email, displayName, password, role } = req.body;
    if (!email || !displayName || !password) {
      res.status(400).json({ error: 'Missing email, displayName, or password' });
      return;
    }

    const validRoles = ['admin', 'member'];
    const userRole = validRoles.includes(role) ? role : 'member';

    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    // Check for duplicate email
    const existing = userStore.getUserByEmail(email);
    if (existing) {
      res.status(409).json({ error: 'User with this email already exists' });
      return;
    }

    const user = await userStore.createUser(email, displayName, password, userRole);
    res.status(201).json(toPublicUser(user));
  });

  // PUT /api/admin/users/:id — update user role/name
  router.put('/users/:id', (req: Request, res: Response) => {
    const userId = String(req.params.id);
    const user = userStore.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const fields: Partial<{ displayName: string; role: string; email: string }> = {};
    if (req.body.displayName) fields.displayName = req.body.displayName;
    if (req.body.role && ['admin', 'member'].includes(req.body.role)) fields.role = req.body.role;
    if (req.body.email) fields.email = req.body.email;

    userStore.updateUser(userId, fields);
    const updated = userStore.getUserById(userId);
    res.json(updated ? toPublicUser(updated) : null);
  });

  // DELETE /api/admin/users/:id — delete user
  router.delete('/users/:id', (req: Request, res: Response) => {
    const userId = String(req.params.id);

    // Cannot delete self
    if (req.user && req.user.id === userId) {
      res.status(400).json({ error: 'Cannot delete your own account' });
      return;
    }

    const user = userStore.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    userStore.deleteUser(userId);
    res.json({ status: 'deleted' });
  });

  // ── API Keys ──

  // POST /api/admin/api-keys — create API key for a user
  router.post('/api-keys', async (req: Request, res: Response) => {
    const { userId, name } = req.body;
    if (!userId || !name) {
      res.status(400).json({ error: 'Missing userId or name' });
      return;
    }

    const user = userStore.getUserById(userId);
    if (!user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const result = await userStore.createApiKey(userId, name);
    res.status(201).json({ id: result.id, key: result.key, keyPrefix: result.keyPrefix, name });
  });

  // GET /api/admin/api-keys?userId=xxx — list keys for a user
  router.get('/api-keys', (req: Request, res: Response) => {
    const userId = String(req.query.userId ?? '');
    if (!userId) {
      res.status(400).json({ error: 'Missing userId query parameter' });
      return;
    }
    const keys = userStore.listApiKeys(userId);
    res.json(keys);
  });

  // DELETE /api/admin/api-keys/:id — revoke a key
  router.delete('/api-keys/:id', (req: Request, res: Response) => {
    const keyId = String(req.params.id);
    userStore.deleteApiKey(keyId);
    res.json({ status: 'deleted' });
  });

  // ── Agent Tokens ──

  // GET /api/admin/agent-tokens — list all persistent agent tokens
  router.get('/agent-tokens', (_req: Request, res: Response) => {
    if (!store) {
      res.status(501).json({ error: 'Agent token management not available' });
      return;
    }
    const tokens = store.listAllPersistentTokens();
    res.json(tokens);
  });

  // POST /api/admin/agent-tokens/:agentId — provision a persistent token for an agent
  router.post('/agent-tokens/:agentId', (req: Request, res: Response) => {
    if (!store || !registry) {
      res.status(501).json({ error: 'Agent token management not available' });
      return;
    }

    const agentId = String(req.params.agentId);
    const councilId = req.body.councilId as string | undefined;

    if (!councilId) {
      const defaultId = registry.getDefaultId();
      if (!defaultId) {
        res.status(400).json({ error: 'No council available. Provide councilId in request body.' });
        return;
      }
      req.body.councilId = defaultId;
    }

    const resolvedCouncilId = req.body.councilId as string;
    const entry = registry.get(resolvedCouncilId);
    if (!entry) {
      res.status(404).json({ error: `Council "${resolvedCouncilId}" not found` });
      return;
    }

    const agentRegistry = entry.agentRegistry;
    const agent = agentRegistry.getAgent(agentId);
    if (!agent) {
      res.status(404).json({ error: `Agent "${agentId}" not found in council "${resolvedCouncilId}"` });
      return;
    }

    // Check if token already exists for this agent+council
    const existing = store.getPersistentToken(agentId, resolvedCouncilId);
    if (existing) {
      res.status(409).json({ error: `Agent "${agentId}" already has a persistent token for council "${resolvedCouncilId}". Delete it first to re-provision.` });
      return;
    }

    const token = agentRegistry.generatePersistentToken(agentId);
    store.savePersistentToken(agentId, resolvedCouncilId, token);
    res.status(201).json({ agentId, councilId: resolvedCouncilId, token });
  });

  // DELETE /api/admin/agent-tokens/:agentId — revoke a persistent token
  router.delete('/agent-tokens/:agentId', (req: Request, res: Response) => {
    if (!store || !registry) {
      res.status(501).json({ error: 'Agent token management not available' });
      return;
    }

    const agentId = String(req.params.agentId);
    const councilId = (req.query.councilId ?? req.body?.councilId) as string | undefined;

    // Clear from all matching agent registries
    if (councilId) {
      const entry = registry.get(councilId);
      if (entry) {
        entry.agentRegistry.clearPersistentToken(agentId);
      }
      store.deletePersistentToken(agentId, councilId);
    } else {
      // Clear from all councils
      for (const { entry } of registry.list()) {
        entry.agentRegistry.clearPersistentToken(agentId);
      }
      store.deletePersistentToken(agentId);
    }

    res.json({ status: 'deleted' });
  });

  return router;
}
