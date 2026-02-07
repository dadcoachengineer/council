import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createDb } from '@/server/db.js';
import { UserStore } from '@/server/user-store.js';

let userStore: UserStore;
let tmpDir: string;
let closeSqlite: () => void;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'council-userstore-'));
  const { db, sqlite } = createDb(join(tmpDir, 'test.db'));
  userStore = new UserStore(db);
  closeSqlite = () => sqlite.close();
});

afterAll(() => {
  closeSqlite();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('UserStore', () => {
  let userId: string;

  it('countUsers returns 0 initially', () => {
    expect(userStore.countUsers()).toBe(0);
  });

  it('createUser creates a user with hashed password', async () => {
    const user = await userStore.createUser('test@example.com', 'Test User', 'password123', 'admin');
    expect(user.id).toBeDefined();
    expect(user.email).toBe('test@example.com');
    expect(user.displayName).toBe('Test User');
    expect(user.role).toBe('admin');
    expect(user.passwordHash).not.toBe('password123');
    expect(user.totpSecret).toBeNull();
    expect(user.totpVerified).toBe(0);
    userId = user.id;
  });

  it('countUsers returns 1 after creation', () => {
    expect(userStore.countUsers()).toBe(1);
  });

  it('getUserByEmail finds user (case-insensitive)', () => {
    const user = userStore.getUserByEmail('TEST@EXAMPLE.COM');
    expect(user).not.toBeNull();
    expect(user!.id).toBe(userId);
  });

  it('getUserById finds user', () => {
    const user = userStore.getUserById(userId);
    expect(user).not.toBeNull();
    expect(user!.email).toBe('test@example.com');
  });

  it('verifyPassword returns true for correct password', async () => {
    const user = userStore.getUserById(userId)!;
    expect(await userStore.verifyPassword(user, 'password123')).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    const user = userStore.getUserById(userId)!;
    expect(await userStore.verifyPassword(user, 'wrongpassword')).toBe(false);
  });

  it('updateUser modifies fields', () => {
    userStore.updateUser(userId, { displayName: 'Updated Name' });
    const user = userStore.getUserById(userId);
    expect(user!.displayName).toBe('Updated Name');
  });

  it('updatePassword changes the password', async () => {
    await userStore.updatePassword(userId, 'newpassword456');
    const user = userStore.getUserById(userId)!;
    expect(await userStore.verifyPassword(user, 'newpassword456')).toBe(true);
    expect(await userStore.verifyPassword(user, 'password123')).toBe(false);
  });

  it('listUsers returns all users', () => {
    const users = userStore.listUsers();
    expect(users.length).toBe(1);
  });

  describe('TOTP', () => {
    it('updateTotpSecret stores a secret', () => {
      userStore.updateTotpSecret(userId, 'TESTSECRET123');
      const user = userStore.getUserById(userId);
      expect(user!.totpSecret).toBe('TESTSECRET123');
      expect(user!.totpVerified).toBe(0);
    });

    it('confirmTotp marks as verified', () => {
      userStore.confirmTotp(userId);
      const user = userStore.getUserById(userId);
      expect(user!.totpVerified).toBe(1);
    });

    it('disableTotp clears secret and verification', () => {
      userStore.disableTotp(userId);
      const user = userStore.getUserById(userId);
      expect(user!.totpSecret).toBeNull();
      expect(user!.totpVerified).toBe(0);
      expect(user!.recoveryCodes).toBeNull();
    });
  });

  describe('Recovery codes', () => {
    it('generateRecoveryCodes returns plaintext codes', async () => {
      // Re-enable TOTP first
      userStore.updateTotpSecret(userId, 'TESTSECRET456');
      userStore.confirmTotp(userId);

      const codes = await userStore.generateRecoveryCodes(userId);
      expect(codes.length).toBe(10);
      expect(codes[0]).toMatch(/.+-/); // has dashes
    });

    it('verifyRecoveryCode returns true for valid code and removes it', async () => {
      const codes = await userStore.generateRecoveryCodes(userId);
      const valid = await userStore.verifyRecoveryCode(userId, codes[0]);
      expect(valid).toBe(true);

      // Using same code again should fail
      const again = await userStore.verifyRecoveryCode(userId, codes[0]);
      expect(again).toBe(false);
    });

    it('verifyRecoveryCode returns false for invalid code', async () => {
      const result = await userStore.verifyRecoveryCode(userId, 'invalid-code-here');
      expect(result).toBe(false);
    });
  });

  describe('Sessions', () => {
    let sessionId: string;

    it('createSession returns a session ID', () => {
      sessionId = userStore.createSession(userId);
      expect(sessionId).toBeDefined();
      expect(typeof sessionId).toBe('string');
    });

    it('getSession returns the session', () => {
      const session = userStore.getSession(sessionId);
      expect(session).not.toBeNull();
      expect(session!.userId).toBe(userId);
    });

    it('getSession returns null for unknown ID', () => {
      expect(userStore.getSession('nonexistent')).toBeNull();
    });

    it('deleteSession removes the session', () => {
      userStore.deleteSession(sessionId);
      expect(userStore.getSession(sessionId)).toBeNull();
    });

    it('expired session returns null', () => {
      // Create a session with 0 TTL (already expired)
      const expiredId = userStore.createSession(userId, 0);
      expect(userStore.getSession(expiredId)).toBeNull();
    });
  });

  describe('deleteUser', () => {
    it('deletes user and their sessions', async () => {
      const user2 = await userStore.createUser('todelete@example.com', 'Delete Me', 'password123');
      const sessId = userStore.createSession(user2.id);
      expect(userStore.getSession(sessId)).not.toBeNull();

      userStore.deleteUser(user2.id);
      expect(userStore.getUserById(user2.id)).toBeNull();
      expect(userStore.getSession(sessId)).toBeNull();
    });
  });
});
