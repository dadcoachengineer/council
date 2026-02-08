import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';
import { eq, and, desc } from 'drizzle-orm';
import type {
  Session,
  SessionPhase,
  Message,
  Vote,
  Decision,
  IncomingEvent,
  CouncilConfig,
  Council,
  DecisionOutcome,
  EscalationEvent,
  AmendmentStatus,
} from '../shared/types.js';
import type { OrchestratorStore } from '../engine/orchestrator.js';

// ── Drizzle schema ──

export const councils = sqliteTable('councils', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  config: text('config').notNull(), // JSON
  createdAt: text('created_at').notNull(),
});

export const sessions = sqliteTable('sessions', {
  id: text('id').primaryKey(),
  councilId: text('council_id').notNull(),
  title: text('title').notNull(),
  phase: text('phase').notNull(), // SessionPhase
  leadAgentId: text('lead_agent_id'),
  triggerEventId: text('trigger_event_id'),
  activeProposalId: text('active_proposal_id'),
  deliberationRound: integer('deliberation_round').notNull().default(0),
  topics: text('topics').notNull().default('[]'), // JSON array of expertise tags
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  fromAgentId: text('from_agent_id').notNull(),
  toAgentId: text('to_agent_id'),
  content: text('content').notNull(),
  messageType: text('message_type').notNull(),
  parentMessageId: text('parent_message_id'),
  amendmentStatus: text('amendment_status'),
  createdAt: text('created_at').notNull(),
});

export const votes = sqliteTable('votes', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id').notNull(),
  value: text('value').notNull(), // VoteValue
  reasoning: text('reasoning').notNull(),
  createdAt: text('created_at').notNull(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  outcome: text('outcome').notNull(), // DecisionOutcome
  summary: text('summary').notNull(),
  humanReviewedBy: text('human_reviewed_by'),
  humanNotes: text('human_notes'),
  createdAt: text('created_at').notNull(),
});

export const escalationEvents = sqliteTable('escalation_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  ruleName: text('rule_name').notNull(),
  triggerType: text('trigger_type').notNull(),
  actionType: text('action_type').notNull(),
  details: text('details').notNull(),
  createdAt: text('created_at').notNull(),
});

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  passwordHash: text('password_hash').notNull(),
  role: text('role').notNull().default('member'),
  totpSecret: text('totp_secret'),
  totpVerified: integer('totp_verified').notNull().default(0),
  recoveryCodes: text('recovery_codes'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const userSessions = sqliteTable('user_sessions', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  expiresAt: text('expires_at').notNull(),
  createdAt: text('created_at').notNull(),
});

export const agentTokens = sqliteTable('agent_tokens', {
  agentId: text('agent_id').notNull(),
  councilId: text('council_id').notNull(),
  token: text('token').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
}, (table) => ({
  pk: primaryKey({ columns: [table.agentId, table.councilId] }),
}));

export const apiKeys = sqliteTable('api_keys', {
  id: text('id').primaryKey(),
  userId: text('user_id').notNull(),
  name: text('name').notNull(),
  keyHash: text('key_hash').notNull(),
  keyPrefix: text('key_prefix').notNull(),
  createdAt: text('created_at').notNull(),
  lastUsedAt: text('last_used_at'),
});

export const sessionParticipants = sqliteTable('session_participants', {
  sessionId: text('session_id').notNull(),
  agentId: text('agent_id').notNull(),
  role: text('role').notNull().default('consulted'), // 'lead' | 'consulted'
  joinedAt: text('joined_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.sessionId, table.agentId] }),
}));

export const events = sqliteTable('events', {
  id: text('id').primaryKey(),
  councilId: text('council_id').notNull(),
  source: text('source').notNull(),
  eventType: text('event_type').notNull(),
  payload: text('payload').notNull(), // JSON
  sessionId: text('session_id'),
  createdAt: text('created_at').notNull(),
});

// ── Schema migrations ──

interface ColumnMigration {
  table: string;
  column: string;
  type: string;
  defaultValue?: string;
}

const MIGRATIONS: ColumnMigration[] = [
  { table: 'sessions', column: 'active_proposal_id', type: 'TEXT' },
  { table: 'messages', column: 'parent_message_id', type: 'TEXT' },
  { table: 'messages', column: 'amendment_status', type: 'TEXT' },
  { table: 'sessions', column: 'topics', type: "TEXT NOT NULL DEFAULT '[]'" },
];

export function runMigrations(sqlite: Database.Database): void {
  const columnCache = new Map<string, Set<string>>();

  function getColumns(table: string): Set<string> {
    let cols = columnCache.get(table);
    if (!cols) {
      const rows = sqlite.pragma(`table_info(${table})`) as { name: string }[];
      cols = new Set(rows.map((r) => r.name));
      columnCache.set(table, cols);
    }
    return cols;
  }

  for (const migration of MIGRATIONS) {
    const existing = getColumns(migration.table);
    if (!existing.has(migration.column)) {
      const defaultClause = migration.defaultValue !== undefined
        ? ` DEFAULT ${migration.defaultValue}`
        : '';
      sqlite.exec(
        `ALTER TABLE ${migration.table} ADD COLUMN ${migration.column} ${migration.type}${defaultClause}`,
      );
      existing.add(migration.column);
      console.log(`Migration: added ${migration.table}.${migration.column} (${migration.type})`);
    }
  }

  // ── agent_tokens composite PK migration ──
  // Migrate from single PK (agent_id) to composite PK (agent_id, council_id)
  const info = sqlite.pragma('table_info(agent_tokens)') as Array<{ name: string; pk: number }>;
  const pkCols = info.filter(c => c.pk > 0);
  if (pkCols.length === 1 && pkCols[0].name === 'agent_id') {
    console.log('Migration: upgrading agent_tokens to composite PK (agent_id, council_id)');
    sqlite.exec(`
      CREATE TABLE agent_tokens_new (
        agent_id TEXT NOT NULL,
        council_id TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        PRIMARY KEY (agent_id, council_id)
      );
      INSERT INTO agent_tokens_new SELECT agent_id, council_id, token, created_at, last_used_at FROM agent_tokens;
      DROP TABLE agent_tokens;
      ALTER TABLE agent_tokens_new RENAME TO agent_tokens;
      CREATE INDEX idx_agent_tokens_token ON agent_tokens(token);
    `);
  }
}

// ── Database client ──

export type DbClient = ReturnType<typeof drizzle>;

export function createDb(dbPath: string): { db: DbClient; sqlite: BetterSqlite3.Database } {
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite);

  // Create tables
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS councils (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      config TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      council_id TEXT NOT NULL,
      title TEXT NOT NULL,
      phase TEXT NOT NULL,
      lead_agent_id TEXT,
      trigger_event_id TEXT,
      active_proposal_id TEXT,
      deliberation_round INTEGER NOT NULL DEFAULT 0,
      topics TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT,
      content TEXT NOT NULL,
      message_type TEXT NOT NULL,
      parent_message_id TEXT,
      amendment_status TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS votes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      value TEXT NOT NULL,
      reasoning TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      summary TEXT NOT NULL,
      human_reviewed_by TEXT,
      human_notes TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      council_id TEXT NOT NULL,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      session_id TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      totp_secret TEXT,
      totp_verified INTEGER NOT NULL DEFAULT 0,
      recovery_codes TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_tokens (
      agent_id TEXT NOT NULL,
      council_id TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      PRIMARY KEY (agent_id, council_id)
    );

    CREATE INDEX IF NOT EXISTS idx_agent_tokens_token ON agent_tokens(token);

    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL,
      key_prefix TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
    CREATE INDEX IF NOT EXISTS idx_api_keys_prefix ON api_keys(key_prefix);

    CREATE TABLE IF NOT EXISTS escalation_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS session_participants (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'consulted',
      joined_at TEXT NOT NULL,
      PRIMARY KEY (session_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_session_participants_session ON session_participants(session_id);

    CREATE INDEX IF NOT EXISTS idx_sessions_council ON sessions(council_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_phase ON sessions(phase);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_votes_session ON votes(session_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_council ON events(council_id);
    CREATE INDEX IF NOT EXISTS idx_escalation_events_session ON escalation_events(session_id);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_user ON user_sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_user_sessions_expires ON user_sessions(expires_at);
  `);

  runMigrations(sqlite);

  return { db, sqlite };
}

// ── OrchestratorStore implementation ──

export class DbStore implements OrchestratorStore {
  constructor(private db: DbClient) {}

  // ── Councils ──

  saveCouncil(council: Council): void {
    this.db.insert(councils).values({
      id: council.id,
      name: council.name,
      description: council.description,
      config: JSON.stringify(council.config),
      createdAt: council.createdAt,
    }).run();
  }

  getCouncil(id: string): Council | null {
    const rows = this.db.select().from(councils).where(eq(councils.id, id)).all();
    if (rows.length === 0) return null;
    const row = rows[0];
    return {
      ...row,
      config: JSON.parse(row.config) as CouncilConfig,
    };
  }

  listCouncils(): Council[] {
    return this.db.select().from(councils).all().map((row) => ({
      ...row,
      config: JSON.parse(row.config) as CouncilConfig,
    }));
  }

  deleteCouncil(id: string): void {
    this.db.delete(councils).where(eq(councils.id, id)).run();
  }

  // ── Sessions ──

  saveSession(session: Session): void {
    this.db.insert(sessions).values({
      ...session,
      topics: JSON.stringify(session.topics),
    }).run();
  }

  updateSession(id: string, updates: Partial<Session>): void {
    const setClauses: Record<string, unknown> = {};
    if (updates.phase !== undefined) setClauses.phase = updates.phase;
    if (updates.deliberationRound !== undefined) setClauses.deliberationRound = updates.deliberationRound;
    if (updates.updatedAt !== undefined) setClauses.updatedAt = updates.updatedAt;
    if (updates.leadAgentId !== undefined) setClauses.leadAgentId = updates.leadAgentId;
    if (updates.activeProposalId !== undefined) setClauses.activeProposalId = updates.activeProposalId;
    if (updates.topics !== undefined) setClauses.topics = JSON.stringify(updates.topics);

    this.db.update(sessions).set(setClauses).where(eq(sessions.id, id)).run();
  }

  private parseSessionRow(row: Record<string, unknown>): Session {
    return {
      ...row,
      topics: JSON.parse((row.topics as string) ?? '[]') as string[],
    } as Session;
  }

  getSession(id: string): Session | null {
    const rows = this.db.select().from(sessions).where(eq(sessions.id, id)).all();
    if (rows.length === 0) return null;
    return this.parseSessionRow(rows[0] as Record<string, unknown>);
  }

  listSessions(councilId?: string, phase?: SessionPhase): Session[] {
    let query;
    if (councilId && phase) {
      query = this.db.select().from(sessions)
        .where(and(eq(sessions.councilId, councilId), eq(sessions.phase, phase)))
        .orderBy(desc(sessions.createdAt));
    } else if (councilId) {
      query = this.db.select().from(sessions)
        .where(eq(sessions.councilId, councilId))
        .orderBy(desc(sessions.createdAt));
    } else if (phase) {
      query = this.db.select().from(sessions)
        .where(eq(sessions.phase, phase))
        .orderBy(desc(sessions.createdAt));
    } else {
      query = this.db.select().from(sessions)
        .orderBy(desc(sessions.createdAt));
    }
    return query.all().map(row => this.parseSessionRow(row as Record<string, unknown>));
  }

  // ── Messages ──

  saveMessage(message: Message): void {
    this.db.insert(messages).values(message).run();
  }

  updateMessage(id: string, updates: Partial<Message>): void {
    const setClauses: Record<string, unknown> = {};
    if (updates.amendmentStatus !== undefined) setClauses.amendmentStatus = updates.amendmentStatus;
    this.db.update(messages).set(setClauses).where(eq(messages.id, id)).run();
  }

  getMessages(sessionId: string): Message[] {
    return this.db.select().from(messages)
      .where(eq(messages.sessionId, sessionId))
      .orderBy(messages.createdAt)
      .all() as Message[];
  }

  // ── Votes ──

  saveVote(vote: Vote): void {
    this.db.insert(votes).values(vote).run();
  }

  getVotes(sessionId: string): Vote[] {
    return this.db.select().from(votes)
      .where(eq(votes.sessionId, sessionId))
      .all() as Vote[];
  }

  // ── Decisions ──

  saveDecision(decision: Decision): void {
    this.db.insert(decisions).values(decision).run();
  }

  getDecision(sessionId: string): Decision | null {
    const rows = this.db.select().from(decisions)
      .where(eq(decisions.sessionId, sessionId))
      .all();
    return (rows[0] as Decision | undefined) ?? null;
  }

  updateDecision(id: string, updates: Partial<Decision>): void {
    const setClauses: Record<string, unknown> = {};
    if (updates.outcome !== undefined) setClauses.outcome = updates.outcome;
    if (updates.humanReviewedBy !== undefined) setClauses.humanReviewedBy = updates.humanReviewedBy;
    if (updates.humanNotes !== undefined) setClauses.humanNotes = updates.humanNotes;

    this.db.update(decisions).set(setClauses).where(eq(decisions.id, id)).run();
  }

  listPendingDecisions(): Decision[] {
    return this.db.select().from(decisions)
      .innerJoin(sessions, eq(decisions.sessionId, sessions.id))
      .where(eq(sessions.phase, 'review'))
      .all()
      .map((row) => row.decisions as unknown as Decision);
  }

  // ── Events ──

  saveEvent(event: IncomingEvent): void {
    this.db.insert(events).values({
      ...event,
      payload: JSON.stringify(event.payload),
    }).run();
  }

  // ── Escalation Events ──

  saveEscalationEvent(event: EscalationEvent): void {
    this.db.insert(escalationEvents).values(event).run();
  }

  getEscalationEvents(sessionId: string): EscalationEvent[] {
    return this.db.select().from(escalationEvents)
      .where(eq(escalationEvents.sessionId, sessionId))
      .orderBy(escalationEvents.createdAt)
      .all() as EscalationEvent[];
  }

  // ── Agent Tokens (persistent) ──

  savePersistentToken(agentId: string, councilId: string, token: string): void {
    this.db.insert(agentTokens).values({
      agentId,
      councilId,
      token,
      createdAt: new Date().toISOString(),
    }).onConflictDoUpdate({
      target: [agentTokens.agentId, agentTokens.councilId],
      set: { token },
    }).run();
  }

  getPersistentToken(agentId: string, councilId?: string): { token: string; lastUsedAt: string | null } | null {
    const condition = councilId
      ? and(eq(agentTokens.agentId, agentId), eq(agentTokens.councilId, councilId))
      : eq(agentTokens.agentId, agentId);
    const rows = this.db.select().from(agentTokens).where(condition).all();
    if (rows.length === 0) return null;
    return { token: rows[0].token, lastUsedAt: rows[0].lastUsedAt };
  }

  updateTokenLastUsed(agentId: string, councilId?: string): void {
    const condition = councilId
      ? and(eq(agentTokens.agentId, agentId), eq(agentTokens.councilId, councilId))
      : eq(agentTokens.agentId, agentId);
    this.db.update(agentTokens)
      .set({ lastUsedAt: new Date().toISOString() })
      .where(condition)
      .run();
  }

  deletePersistentToken(agentId: string, councilId?: string): void {
    const condition = councilId
      ? and(eq(agentTokens.agentId, agentId), eq(agentTokens.councilId, councilId))
      : eq(agentTokens.agentId, agentId);
    this.db.delete(agentTokens).where(condition).run();
  }

  listPersistentTokens(councilId: string): Array<{ agentId: string; token: string }> {
    return this.db.select({
      agentId: agentTokens.agentId,
      token: agentTokens.token,
    }).from(agentTokens).where(eq(agentTokens.councilId, councilId)).all();
  }

  // ── Session Participants ──

  addSessionParticipant(sessionId: string, agentId: string, role: 'lead' | 'consulted'): void {
    this.db.insert(sessionParticipants).values({
      sessionId,
      agentId,
      role,
      joinedAt: new Date().toISOString(),
    }).onConflictDoNothing().run();
  }

  getSessionParticipants(sessionId: string): Array<{ agentId: string; role: string }> {
    return this.db.select({
      agentId: sessionParticipants.agentId,
      role: sessionParticipants.role,
    }).from(sessionParticipants).where(eq(sessionParticipants.sessionId, sessionId)).all();
  }

  // ── Agent Tokens (admin listing) ──

  listAllPersistentTokens(): Array<{ agentId: string; councilId: string; tokenPrefix: string; createdAt: string; lastUsedAt: string | null }> {
    return this.db.select().from(agentTokens).all().map(row => ({
      agentId: row.agentId,
      councilId: row.councilId,
      tokenPrefix: row.token.slice(0, 20) + '...',
      createdAt: row.createdAt,
      lastUsedAt: row.lastUsedAt,
    }));
  }

  listEvents(councilId?: string, limit = 50): IncomingEvent[] {
    const query = councilId
      ? this.db.select().from(events).where(eq(events.councilId, councilId))
      : this.db.select().from(events);

    return query
      .orderBy(desc(events.createdAt))
      .limit(limit)
      .all()
      .map((row) => ({
        ...row,
        payload: JSON.parse(row.payload),
      })) as IncomingEvent[];
  }
}
