import { eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import bcrypt from 'bcrypt';
import { users, userSessions, type DbClient } from './db.js';

const SALT_ROUNDS = 12;
const RECOVERY_SALT_ROUNDS = 6; // Lower for recovery codes (many to compare)
const RECOVERY_CODE_COUNT = 10;

export interface UserRow {
  id: string;
  email: string;
  displayName: string;
  passwordHash: string;
  role: string;
  totpSecret: string | null;
  totpVerified: number;
  recoveryCodes: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRow {
  id: string;
  userId: string;
  expiresAt: string;
  createdAt: string;
}

export class UserStore {
  constructor(private db: DbClient) {}

  async createUser(
    email: string,
    displayName: string,
    password: string,
    role: 'admin' | 'member' = 'member',
  ): Promise<UserRow> {
    const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
    const now = new Date().toISOString();
    const user: UserRow = {
      id: nanoid(),
      email: email.toLowerCase().trim(),
      displayName,
      passwordHash,
      role,
      totpSecret: null,
      totpVerified: 0,
      recoveryCodes: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.insert(users).values(user).run();
    return user;
  }

  getUserByEmail(email: string): UserRow | null {
    const rows = this.db
      .select()
      .from(users)
      .where(eq(users.email, email.toLowerCase().trim()))
      .all();
    return (rows[0] as UserRow | undefined) ?? null;
  }

  getUserById(id: string): UserRow | null {
    const rows = this.db.select().from(users).where(eq(users.id, id)).all();
    return (rows[0] as UserRow | undefined) ?? null;
  }

  async verifyPassword(user: UserRow, password: string): Promise<boolean> {
    return bcrypt.compare(password, user.passwordHash);
  }

  updateTotpSecret(userId: string, secret: string): void {
    this.db
      .update(users)
      .set({ totpSecret: secret, totpVerified: 0, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
  }

  confirmTotp(userId: string): void {
    this.db
      .update(users)
      .set({ totpVerified: 1, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
  }

  disableTotp(userId: string): void {
    this.db
      .update(users)
      .set({
        totpSecret: null,
        totpVerified: 0,
        recoveryCodes: null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(users.id, userId))
      .run();
  }

  async generateRecoveryCodes(userId: string): Promise<string[]> {
    const codes: string[] = [];
    const hashed: string[] = [];
    for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
      const code = `${nanoid(4)}-${nanoid(4)}-${nanoid(4)}`;
      codes.push(code);
      hashed.push(await bcrypt.hash(code, RECOVERY_SALT_ROUNDS));
    }
    this.db
      .update(users)
      .set({ recoveryCodes: JSON.stringify(hashed), updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
    return codes;
  }

  async verifyRecoveryCode(userId: string, code: string): Promise<boolean> {
    const user = this.getUserById(userId);
    if (!user?.recoveryCodes) return false;

    const hashed: string[] = JSON.parse(user.recoveryCodes);
    for (let i = 0; i < hashed.length; i++) {
      if (await bcrypt.compare(code, hashed[i])) {
        // Remove used code
        hashed.splice(i, 1);
        this.db
          .update(users)
          .set({ recoveryCodes: JSON.stringify(hashed), updatedAt: new Date().toISOString() })
          .where(eq(users.id, userId))
          .run();
        return true;
      }
    }
    return false;
  }

  createSession(userId: string, ttlDays = 7): string {
    const id = nanoid(32);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
    this.db
      .insert(userSessions)
      .values({
        id,
        userId,
        expiresAt: expiresAt.toISOString(),
        createdAt: now.toISOString(),
      })
      .run();
    return id;
  }

  getSession(sessionId: string): SessionRow | null {
    const rows = this.db
      .select()
      .from(userSessions)
      .where(eq(userSessions.id, sessionId))
      .all();
    const row = (rows[0] as SessionRow | undefined) ?? null;
    if (!row) return null;
    // Check expiry
    if (new Date(row.expiresAt) <= new Date()) {
      this.deleteSession(sessionId);
      return null;
    }
    return row;
  }

  deleteSession(sessionId: string): void {
    this.db.delete(userSessions).where(eq(userSessions.id, sessionId)).run();
  }

  countUsers(): number {
    const rows = this.db.select().from(users).all();
    return rows.length;
  }

  listUsers(): UserRow[] {
    return this.db.select().from(users).all() as UserRow[];
  }

  updateUser(
    userId: string,
    fields: Partial<Pick<UserRow, 'displayName' | 'role' | 'email'>>,
  ): void {
    const setClauses: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (fields.displayName !== undefined) setClauses.displayName = fields.displayName;
    if (fields.role !== undefined) setClauses.role = fields.role;
    if (fields.email !== undefined) setClauses.email = fields.email.toLowerCase().trim();
    this.db.update(users).set(setClauses).where(eq(users.id, userId)).run();
  }

  async updatePassword(userId: string, newPassword: string): Promise<void> {
    const passwordHash = await bcrypt.hash(newPassword, SALT_ROUNDS);
    this.db
      .update(users)
      .set({ passwordHash, updatedAt: new Date().toISOString() })
      .where(eq(users.id, userId))
      .run();
  }

  deleteUser(userId: string): void {
    // Delete user sessions first
    this.db.delete(userSessions).where(eq(userSessions.userId, userId)).run();
    this.db.delete(users).where(eq(users.id, userId)).run();
  }
}
