import { describe, it, expect } from 'vitest';
import { createHmac, timingSafeEqual } from 'node:crypto';

describe('GitHub webhook HMAC verification', () => {
  const secret = 'test-secret-123';

  function sign(body: Buffer, key: string): string {
    return 'sha256=' + createHmac('sha256', key).update(body).digest('hex');
  }

  /** Mirror of verifyGithubSignature from webhooks.ts */
  function verify(rawBody: Buffer, secret: string, signature: string): boolean {
    const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length) return false;
    return timingSafeEqual(sigBuf, expBuf);
  }

  it('accepts a valid signature computed from raw bytes', () => {
    const raw = Buffer.from('{"action":"opened"}', 'utf-8');
    const signature = sign(raw, secret);
    expect(verify(raw, secret, signature)).toBe(true);
  });

  it('rejects a signature computed from re-serialized JSON (the old bug)', () => {
    // GitHub sends: whitespace in JSON
    const rawPayload = '{"action" : "opened",  "issue": {"number":  1}}';
    const raw = Buffer.from(rawPayload, 'utf-8');
    const validSignature = sign(raw, secret);

    // Old code did JSON.stringify(JSON.parse(body)) which strips whitespace
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(rawPayload)), 'utf-8');
    const wrongSignature = sign(reserialized, secret);

    // The raw-based signature is valid
    expect(verify(raw, secret, validSignature)).toBe(true);
    // The re-serialized signature does NOT match raw bytes
    expect(verify(raw, secret, wrongSignature)).toBe(false);
  });

  it('rejects without crashing when signature has different length', () => {
    const raw = Buffer.from('{"test":true}', 'utf-8');
    // Too short — would crash timingSafeEqual without length guard
    expect(verify(raw, secret, 'sha256=abc')).toBe(false);
    // Empty
    expect(verify(raw, secret, '')).toBe(false);
  });

  it('rejects a wrong signature of correct length', () => {
    const raw = Buffer.from('{"test":true}', 'utf-8');
    const valid = sign(raw, secret);
    const invalid = valid.slice(0, -1) + (valid.endsWith('0') ? '1' : '0');
    expect(verify(raw, secret, invalid)).toBe(false);
  });
});
