import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runMigrations } from '@/server/db.js';

/** Schema without the 3 columns added in PR #13 */
const STALE_SCHEMA = `
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    council_id TEXT NOT NULL,
    title TEXT NOT NULL,
    phase TEXT NOT NULL,
    lead_agent_id TEXT,
    trigger_event_id TEXT,
    deliberation_round INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    from_agent_id TEXT NOT NULL,
    to_agent_id TEXT,
    content TEXT NOT NULL,
    message_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
`;

/** Full schema with all columns present */
const CURRENT_SCHEMA = `
  CREATE TABLE sessions (
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

  CREATE TABLE messages (
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
`;

function getColumnNames(sqlite: Database.Database, table: string): string[] {
  const rows = sqlite.pragma(`table_info(${table})`) as { name: string }[];
  return rows.map((r) => r.name);
}

describe('DB schema migrations', () => {
  let dir: string;
  let sqlite: Database.Database;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'council-test-'));
  });

  afterEach(() => {
    sqlite?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fresh DB already has all columns — no migrations needed', () => {
    sqlite = new Database(join(dir, 'fresh.db'));
    sqlite.exec(CURRENT_SCHEMA);

    // Should not throw
    runMigrations(sqlite);

    expect(getColumnNames(sqlite, 'sessions')).toContain('active_proposal_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('parent_message_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('amendment_status');
  });

  it('stale DB missing columns gets them added', () => {
    sqlite = new Database(join(dir, 'stale.db'));
    sqlite.exec(STALE_SCHEMA);

    // Verify columns are missing before migration
    expect(getColumnNames(sqlite, 'sessions')).not.toContain('active_proposal_id');
    expect(getColumnNames(sqlite, 'messages')).not.toContain('parent_message_id');
    expect(getColumnNames(sqlite, 'messages')).not.toContain('amendment_status');

    runMigrations(sqlite);

    // Verify columns exist after migration
    expect(getColumnNames(sqlite, 'sessions')).toContain('active_proposal_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('parent_message_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('amendment_status');
  });

  it('migrations are idempotent — running twice is safe', () => {
    sqlite = new Database(join(dir, 'idempotent.db'));
    sqlite.exec(STALE_SCHEMA);

    runMigrations(sqlite);
    // Second run should not throw
    runMigrations(sqlite);

    expect(getColumnNames(sqlite, 'sessions')).toContain('active_proposal_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('parent_message_id');
    expect(getColumnNames(sqlite, 'messages')).toContain('amendment_status');
  });

  it('existing data is preserved after migration', () => {
    sqlite = new Database(join(dir, 'data.db'));
    sqlite.exec(STALE_SCHEMA);

    // Insert data before migration
    sqlite.exec(`
      INSERT INTO sessions (id, council_id, title, phase, deliberation_round, created_at, updated_at)
      VALUES ('s1', 'c1', 'Test Session', 'deliberation', 0, '2025-01-01', '2025-01-01');
    `);
    sqlite.exec(`
      INSERT INTO messages (id, session_id, from_agent_id, content, message_type, created_at)
      VALUES ('m1', 's1', 'agent-1', 'Hello world', 'proposal', '2025-01-01');
    `);

    runMigrations(sqlite);

    // Verify existing data is intact
    const session = sqlite.prepare('SELECT * FROM sessions WHERE id = ?').get('s1') as Record<string, unknown>;
    expect(session.title).toBe('Test Session');
    expect(session.council_id).toBe('c1');
    expect(session.active_proposal_id).toBeNull();

    const message = sqlite.prepare('SELECT * FROM messages WHERE id = ?').get('m1') as Record<string, unknown>;
    expect(message.content).toBe('Hello world');
    expect(message.from_agent_id).toBe('agent-1');
    expect(message.parent_message_id).toBeNull();
    expect(message.amendment_status).toBeNull();
  });
});
