import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const COOKIE_NAME = 'council_session';
const COOKIE_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

/**
 * Derive a signing key from the password so the cookie can't be forged.
 */
function signingKey(password: string): Buffer {
  return Buffer.from(
    createHmac('sha256', 'council-session-key').update(password).digest('hex'),
  );
}

/**
 * Create a signed session cookie value.
 */
function createSessionToken(password: string): string {
  const payload = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', signingKey(password)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

/**
 * Verify a signed session cookie value.
 */
function verifySessionToken(token: string, password: string): boolean {
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', signingKey(password)).update(payload).digest('hex');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length) return false;
  return timingSafeEqual(sigBuf, expBuf);
}

/**
 * Parse cookies from request header (avoid adding a cookie-parser dependency).
 */
function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!header) return cookies;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const val = pair.slice(eq + 1).trim();
    cookies[key] = decodeURIComponent(val);
  }
  return cookies;
}

/**
 * Create auth middleware and login route handler.
 * Returns null if COUNCIL_PASSWORD is not set (auth disabled).
 */
export function createAuth(password: string | undefined) {
  if (!password) return null;

  const protect = (req: Request, res: Response, next: NextFunction) => {
    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[COOKIE_NAME];
    if (token && verifySessionToken(token, password)) {
      next();
      return;
    }
    // API requests get 401, page requests get redirected
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ error: 'Unauthorized' });
    } else {
      // Let the SPA handle showing the login page
      res.status(401).json({ error: 'Unauthorized' });
    }
  };

  const login = (req: Request, res: Response) => {
    const { password: attempt } = req.body;
    if (!attempt || typeof attempt !== 'string') {
      res.status(400).json({ error: 'Missing password' });
      return;
    }

    const attemptBuf = Buffer.from(attempt);
    const passwordBuf = Buffer.from(password);
    if (attemptBuf.length !== passwordBuf.length || !timingSafeEqual(attemptBuf, passwordBuf)) {
      res.status(401).json({ error: 'Invalid password' });
      return;
    }

    const token = createSessionToken(password);
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
    );
    res.json({ status: 'ok' });
  };

  const logout = (_req: Request, res: Response) => {
    res.setHeader('Set-Cookie',
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    );
    res.json({ status: 'ok' });
  };

  return { protect, login, logout };
}
