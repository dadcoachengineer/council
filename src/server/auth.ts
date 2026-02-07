import { Router, type Request, type Response, type NextFunction } from 'express';
import { TOTP, Secret } from 'otpauth';
import { toDataURL } from 'qrcode';
import type { UserStore, UserRow } from './user-store.js';
import type { PublicUser } from '../shared/types.js';

const COOKIE_NAME = 'council_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

// Augment Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: PublicUser | null;
      /** The raw user row for internal use (e.g. checking totp_secret) */
      _userRow?: UserRow | null;
    }
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eqIdx = pair.indexOf('=');
    if (eqIdx === -1) continue;
    const key = pair.slice(0, eqIdx).trim();
    const val = pair.slice(eqIdx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

function toPublicUser(row: UserRow): PublicUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role as PublicUser['role'],
    totpEnabled: row.totpVerified === 1,
    createdAt: row.createdAt,
  };
}

function setSessionCookie(res: Response, sessionId: string): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
  );
}

function clearSessionCookie(res: Response): void {
  res.setHeader(
    'Set-Cookie',
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
}

export interface AuthMiddleware {
  authenticate: (req: Request, res: Response, next: NextFunction) => void;
  protect: (req: Request, res: Response, next: NextFunction) => void;
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void;
  router: ReturnType<typeof Router>;
}

export function createAuth(store: UserStore): AuthMiddleware {
  const router = Router();

  // ── Middleware: load user from session cookie (non-blocking) ──
  function authenticate(req: Request, _res: Response, next: NextFunction) {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[COOKIE_NAME];
    if (!sessionId) {
      req.user = null;
      req._userRow = null;
      next();
      return;
    }

    const session = store.getSession(sessionId);
    if (!session) {
      req.user = null;
      req._userRow = null;
      next();
      return;
    }

    const userRow = store.getUserById(session.userId);
    if (!userRow) {
      req.user = null;
      req._userRow = null;
      next();
      return;
    }

    req.user = toPublicUser(userRow);
    req._userRow = userRow;
    next();
  }

  // ── Guard: require authenticated user ──
  function protect(req: Request, res: Response, next: NextFunction) {
    if (!req.user) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  }

  // ── Guard: require admin role ──
  function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.user || req.user.role !== 'admin') {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  }

  // ── POST /auth/setup — first-run admin creation ──
  router.post('/setup', async (req: Request, res: Response) => {
    if (store.countUsers() > 0) {
      res.status(400).json({ error: 'Setup already completed' });
      return;
    }

    const { email, displayName, password } = req.body;
    if (!email || !displayName || !password) {
      res.status(400).json({ error: 'Missing email, displayName, or password' });
      return;
    }
    if (typeof password !== 'string' || password.length < 8) {
      res.status(400).json({ error: 'Password must be at least 8 characters' });
      return;
    }

    const user = await store.createUser(email, displayName, password, 'admin');
    const sessionId = store.createSession(user.id);
    setSessionCookie(res, sessionId);
    res.status(201).json({ user: toPublicUser(user) });
  });

  // ── POST /auth/login — email + password ──
  router.post('/login', async (req: Request, res: Response) => {
    const { email, password } = req.body;
    if (!email || !password) {
      res.status(400).json({ error: 'Missing email or password' });
      return;
    }

    const user = store.getUserByEmail(email);
    if (!user) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    const valid = await store.verifyPassword(user, password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid email or password' });
      return;
    }

    // If 2FA is enabled, don't create session yet — require TOTP
    if (user.totpVerified === 1) {
      // Create a short-lived "pending 2FA" session token to carry state
      const pendingSessionId = store.createSession(user.id, 1 / 24); // 1 hour
      res.json({
        requires2fa: true,
        pendingSession: pendingSessionId,
      });
      return;
    }

    const sessionId = store.createSession(user.id);
    setSessionCookie(res, sessionId);
    res.json({ user: toPublicUser(user) });
  });

  // ── POST /auth/login/2fa — verify TOTP after password ──
  router.post('/login/2fa', (req: Request, res: Response) => {
    const { pendingSession, code } = req.body;
    if (!pendingSession || !code) {
      res.status(400).json({ error: 'Missing pendingSession or code' });
      return;
    }

    const session = store.getSession(pendingSession);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const user = store.getUserById(session.userId);
    if (!user || !user.totpSecret) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }

    const totp = new TOTP({
      secret: Secret.fromBase32(user.totpSecret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      res.status(401).json({ error: 'Invalid TOTP code' });
      return;
    }

    // Delete the pending session and create a real one
    store.deleteSession(pendingSession);
    const realSessionId = store.createSession(user.id);
    setSessionCookie(res, realSessionId);
    res.json({ user: toPublicUser(user) });
  });

  // ── POST /auth/login/recovery — use recovery code instead of TOTP ──
  router.post('/login/recovery', async (req: Request, res: Response) => {
    const { pendingSession, code } = req.body;
    if (!pendingSession || !code) {
      res.status(400).json({ error: 'Missing pendingSession or code' });
      return;
    }

    const session = store.getSession(pendingSession);
    if (!session) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }

    const user = store.getUserById(session.userId);
    if (!user) {
      res.status(401).json({ error: 'Invalid session' });
      return;
    }

    const valid = await store.verifyRecoveryCode(user.id, code);
    if (!valid) {
      res.status(401).json({ error: 'Invalid recovery code' });
      return;
    }

    store.deleteSession(pendingSession);
    const realSessionId = store.createSession(user.id);
    setSessionCookie(res, realSessionId);
    res.json({ user: toPublicUser(user) });
  });

  // ── POST /auth/logout ──
  router.post('/logout', (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const sessionId = cookies[COOKIE_NAME];
    if (sessionId) {
      store.deleteSession(sessionId);
    }
    clearSessionCookie(res);
    res.json({ status: 'ok' });
  });

  // ── GET /auth/me — current user info or setup detection ──
  router.get('/me', (_req: Request, res: Response) => {
    const needsSetup = store.countUsers() === 0;
    if (needsSetup) {
      res.json({ needsSetup: true, authenticated: false });
      return;
    }
    if (!_req.user) {
      res.status(401).json({ authenticated: false });
      return;
    }
    res.json({ authenticated: true, user: _req.user, needsSetup: false });
  });

  // ── POST /auth/2fa/enable — generate TOTP secret + QR ──
  router.post('/2fa/enable', protect, async (req: Request, res: Response) => {
    const userRow = req._userRow!;
    if (userRow.totpVerified === 1) {
      res.status(400).json({ error: '2FA is already enabled' });
      return;
    }

    const secret = new Secret();
    const totp = new TOTP({
      issuer: 'Council',
      label: userRow.email,
      secret,
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    store.updateTotpSecret(userRow.id, secret.base32);
    const uri = totp.toString();
    const qrDataUrl = await toDataURL(uri);

    res.json({ secret: secret.base32, uri, qrDataUrl });
  });

  // ── POST /auth/2fa/confirm — verify code to activate 2FA ──
  router.post('/2fa/confirm', protect, async (req: Request, res: Response) => {
    const userRow = req._userRow!;
    if (!userRow.totpSecret) {
      res.status(400).json({ error: 'No TOTP secret pending. Call enable first.' });
      return;
    }
    if (userRow.totpVerified === 1) {
      res.status(400).json({ error: '2FA is already confirmed' });
      return;
    }

    const { code } = req.body;
    if (!code) {
      res.status(400).json({ error: 'Missing code' });
      return;
    }

    const totp = new TOTP({
      secret: Secret.fromBase32(userRow.totpSecret),
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });

    const delta = totp.validate({ token: code, window: 1 });
    if (delta === null) {
      res.status(400).json({ error: 'Invalid TOTP code' });
      return;
    }

    store.confirmTotp(userRow.id);
    const recoveryCodes = await store.generateRecoveryCodes(userRow.id);
    res.json({ enabled: true, recoveryCodes });
  });

  // ── POST /auth/2fa/disable — remove 2FA (requires password) ──
  router.post('/2fa/disable', protect, async (req: Request, res: Response) => {
    const userRow = req._userRow!;
    const { password } = req.body;
    if (!password) {
      res.status(400).json({ error: 'Password required to disable 2FA' });
      return;
    }

    const valid = await store.verifyPassword(userRow, password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    store.disableTotp(userRow.id);
    res.json({ disabled: true });
  });

  // ── POST /auth/2fa/recovery-codes — regenerate recovery codes ──
  router.post('/2fa/recovery-codes', protect, async (req: Request, res: Response) => {
    const userRow = req._userRow!;
    if (userRow.totpVerified !== 1) {
      res.status(400).json({ error: '2FA is not enabled' });
      return;
    }

    const { password } = req.body;
    if (!password) {
      res.status(400).json({ error: 'Password required' });
      return;
    }

    const valid = await store.verifyPassword(userRow, password);
    if (!valid) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const codes = await store.generateRecoveryCodes(userRow.id);
    res.json({ recoveryCodes: codes });
  });

  // ── PUT /auth/profile — update own profile ──
  router.put('/profile', protect, (req: Request, res: Response) => {
    const { displayName } = req.body;
    if (displayName) {
      store.updateUser(req.user!.id, { displayName });
    }
    const updated = store.getUserById(req.user!.id);
    res.json({ user: updated ? toPublicUser(updated) : req.user });
  });

  // ── PUT /auth/password — change own password ──
  router.put('/password', protect, async (req: Request, res: Response) => {
    const userRow = req._userRow!;
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'Missing currentPassword or newPassword' });
      return;
    }
    if (typeof newPassword !== 'string' || newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters' });
      return;
    }

    const valid = await store.verifyPassword(userRow, currentPassword);
    if (!valid) {
      res.status(401).json({ error: 'Current password is incorrect' });
      return;
    }

    await store.updatePassword(userRow.id, newPassword);
    res.json({ status: 'ok' });
  });

  return { authenticate, protect, requireAdmin, router };
}
