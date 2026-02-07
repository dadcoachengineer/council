import { Router, type Request, type Response } from 'express';
import type { UserStore } from './user-store.js';
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

export function createAdminRouter(userStore: UserStore): Router {
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

  return router;
}
