import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';
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

    CREATE TABLE IF NOT EXISTS escalation_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      rule_name TEXT NOT NULL,
      trigger_type TEXT NOT NULL,
      action_type TEXT NOT NULL,
      details TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_council ON sessions(council_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_phase ON sessions(phase);
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_votes_session ON votes(session_id);
    CREATE INDEX IF NOT EXISTS idx_decisions_session ON decisions(session_id);
    CREATE INDEX IF NOT EXISTS idx_events_council ON events(council_id);
    CREATE INDEX IF NOT EXISTS idx_escalation_events_session ON escalation_events(session_id);
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

  // ── Sessions ──

  saveSession(session: Session): void {
    this.db.insert(sessions).values(session).run();
  }

  updateSession(id: string, updates: Partial<Session>): void {
    const setClauses: Record<string, unknown> = {};
    if (updates.phase !== undefined) setClauses.phase = updates.phase;
    if (updates.deliberationRound !== undefined) setClauses.deliberationRound = updates.deliberationRound;
    if (updates.updatedAt !== undefined) setClauses.updatedAt = updates.updatedAt;
    if (updates.leadAgentId !== undefined) setClauses.leadAgentId = updates.leadAgentId;
    if (updates.activeProposalId !== undefined) setClauses.activeProposalId = updates.activeProposalId;

    this.db.update(sessions).set(setClauses).where(eq(sessions.id, id)).run();
  }

  getSession(id: string): Session | null {
    const rows = this.db.select().from(sessions).where(eq(sessions.id, id)).all();
    return (rows[0] as Session | undefined) ?? null;
  }

  listSessions(councilId?: string, phase?: SessionPhase): Session[] {
    if (councilId && phase) {
      return this.db.select().from(sessions)
        .where(and(eq(sessions.councilId, councilId), eq(sessions.phase, phase)))
        .orderBy(desc(sessions.createdAt))
        .all() as Session[];
    }
    if (councilId) {
      return this.db.select().from(sessions)
        .where(eq(sessions.councilId, councilId))
        .orderBy(desc(sessions.createdAt))
        .all() as Session[];
    }
    if (phase) {
      return this.db.select().from(sessions)
        .where(eq(sessions.phase, phase))
        .orderBy(desc(sessions.createdAt))
        .all() as Session[];
    }
    return this.db.select().from(sessions)
      .orderBy(desc(sessions.createdAt))
      .all() as Session[];
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
