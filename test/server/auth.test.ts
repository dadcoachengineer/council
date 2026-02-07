import { describe, it, expect } from 'vitest';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Mirror the auth module's logic for testing
function signingKey(password: string): Buffer {
  return Buffer.from(
    createHmac('sha256', 'council-session-key').update(password).digest('hex'),
  );
}

function createSessionToken(password: string): string {
  const payload = randomBytes(16).toString('hex');
  const sig = createHmac('sha256', signingKey(password)).update(payload).digest('hex');
  return `${payload}.${sig}`;
}

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

describe('Auth session tokens', () => {
  const password = 'my-secret-password';

  it('creates a valid token that verifies', () => {
    const token = createSessionToken(password);
    expect(verifySessionToken(token, password)).toBe(true);
  });

  it('rejects a token signed with a different password', () => {
    const token = createSessionToken(password);
    expect(verifySessionToken(token, 'wrong-password')).toBe(false);
  });

  it('rejects a malformed token (no dot)', () => {
    expect(verifySessionToken('nodothere', password)).toBe(false);
  });

  it('rejects a tampered token', () => {
    const token = createSessionToken(password);
    // Flip a character in the signature
    const tampered = token.slice(0, -1) + (token.endsWith('0') ? '1' : '0');
    expect(verifySessionToken(tampered, password)).toBe(false);
  });

  it('rejects an empty token', () => {
    expect(verifySessionToken('', password)).toBe(false);
  });

  it('generates unique tokens each time', () => {
    const t1 = createSessionToken(password);
    const t2 = createSessionToken(password);
    expect(t1).not.toBe(t2);
  });
});
