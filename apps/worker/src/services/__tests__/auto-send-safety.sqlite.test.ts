/**
 * REAL-SQLite proof of the auto-send safety SQL (same rationale as
 * publish.sqlite.test.ts): an in-memory mock's atomicity is our own
 * construction — these suites run the ACTUAL claim / conditional-INSERT /
 * window SQL against a real SQLite engine so removing INSERT OR IGNORE, the
 * partial unique index, or the conditional-SELECT guard makes them FAIL.
 *
 * Restart-durability note: all abuse counters live in these TABLES (D1 in
 * production) — the module holds zero in-memory state, which the
 * "pre-existing rows count against the caps" test proves directly (rows
 * written by a "previous process" deny the next reservation).
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import {
  claimTriggerDelivery,
  reserveAutoSend,
  withinStandardWindow,
  reconcileDarkAutoSend,
  autoDmCaps,
  autoSendEnabled,
  DEFAULT_AUTO_DM_CAPS,
} from '../auto-send-safety.js';

type SqliteStmt = { run: (...a: unknown[]) => { changes: number | bigint }; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
type SqliteDb = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStmt };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (path: string) => SqliteDb;
};

/** Minimal D1Database over node:sqlite (run/first/all). */
function d1(db: SqliteDb): D1Database {
  return {
    prepare(sql: string) {
      const isRead = /^\s*SELECT/i.test(sql);
      const make = (bound: unknown[]) => ({
        bind(...args: unknown[]) { return make(args); },
        async run() {
          const r = db.prepare(sql).run(...(bound as never[]));
          return { meta: { changes: Number(r.changes) } };
        },
        async first() { return db.prepare(sql).get(...(bound as never[])) ?? null; },
        async all() { return { results: isRead ? db.prepare(sql).all(...(bound as never[])) : [] }; },
      });
      return make([]);
    },
  } as unknown as D1Database;
}

function freshDb(): { raw: SqliteDb; db: D1Database } {
  const raw = new DatabaseSync(':memory:');
  raw.exec(`
    CREATE TABLE comment_deliveries (
      trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('comment_rule','gate','gate_dm','scenario','scenario_dm')),
      trigger_id   TEXT NOT NULL,
      event_id     TEXT NOT NULL,
      igsid        TEXT NOT NULL,
      created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))),
      PRIMARY KEY (trigger_kind, trigger_id, event_id)
    );
    CREATE UNIQUE INDEX idx_comment_deliveries_rule_recipient
      ON comment_deliveries(trigger_id, igsid)
      WHERE trigger_kind = 'comment_rule';
    CREATE TABLE auto_send_ledger (
      id TEXT PRIMARY KEY,
      account_id TEXT NOT NULL,
      igsid TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at INTEGER NOT NULL
    );
    CREATE TABLE messages_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      follower_id INTEGER,
      direction TEXT NOT NULL,
      message_type TEXT NOT NULL,
      body TEXT NOT NULL,
      trigger_source TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
    );
  `);
  return { raw, db: d1(raw) };
}

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

describe('claimTriggerDelivery — real SQL idempotency', () => {
  it('claims once; webhook REDELIVERY of the same event is refused', async () => {
    const { db } = freshDb();
    const args = { kind: 'gate' as const, triggerId: 'g1', eventId: 'comment-1', igsid: 'IG1' };
    expect(await claimTriggerDelivery(db, args)).toBe(true);
    expect(await claimTriggerDelivery(db, args)).toBe(false); // redelivery → no second DM
  });

  it('8 concurrent claims for the same event → exactly ONE winner', async () => {
    const { db } = freshDb();
    const args = { kind: 'comment_rule' as const, triggerId: 'r1', eventId: 'c-1', igsid: 'IG1' };
    const results = await Promise.all(Array.from({ length: 8 }, () => claimTriggerDelivery(db, args)));
    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('comment_rule: same person via a DIFFERENT comment is refused (one DM per person per rule)', async () => {
    const { db } = freshDb();
    expect(await claimTriggerDelivery(db, { kind: 'comment_rule', triggerId: 'r1', eventId: 'c-1', igsid: 'IG1' })).toBe(true);
    expect(await claimTriggerDelivery(db, { kind: 'comment_rule', triggerId: 'r1', eventId: 'c-2', igsid: 'IG1' })).toBe(false);
    // …but a different person on the same rule is fine
    expect(await claimTriggerDelivery(db, { kind: 'comment_rule', triggerId: 'r1', eventId: 'c-3', igsid: 'IG2' })).toBe(true);
    // …and the same person on a DIFFERENT rule is fine
    expect(await claimTriggerDelivery(db, { kind: 'comment_rule', triggerId: 'r2', eventId: 'c-4', igsid: 'IG1' })).toBe(true);
  });

  it('gate kind: per-person uniqueness does NOT apply (allow_repeat gates stay possible), event dedup does', async () => {
    const { db } = freshDb();
    expect(await claimTriggerDelivery(db, { kind: 'gate', triggerId: 'g1', eventId: 'c-1', igsid: 'IG1' })).toBe(true);
    expect(await claimTriggerDelivery(db, { kind: 'gate', triggerId: 'g1', eventId: 'c-2', igsid: 'IG1' })).toBe(true);
    expect(await claimTriggerDelivery(db, { kind: 'gate', triggerId: 'g1', eventId: 'c-2', igsid: 'IG1' })).toBe(false);
  });

  it('fails CLOSED (false → no send) when the table is missing', async () => {
    const raw = new DatabaseSync(':memory:'); // no tables at all
    const db = d1(raw);
    expect(await claimTriggerDelivery(db, { kind: 'gate', triggerId: 'g', eventId: 'e', igsid: 'i' })).toBe(false);
  });
});

describe('reserveAutoSend — real SQL rolling caps', () => {
  const caps = { hourlyCap: 2, dailyCap: 3, recipientDailyCap: 10 };

  it('enforces the hourly cap and names it', async () => {
    const { db } = freshDb();
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    const a = (igsid: string, now: number) =>
      reserveAutoSend(db, { accountId: 'acc', igsid, kind: 'test', caps, now });
    expect((await a('u1', t0)).ok).toBe(true);
    expect((await a('u2', t0)).ok).toBe(true);
    const denied = await a('u3', t0);
    expect(denied).toEqual({ ok: false, reason: 'account_hourly' });
  });

  it('hourly window ROLLS OVER; then the daily cap binds; then IT rolls over', async () => {
    const { db } = freshDb();
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    const a = (igsid: string, now: number) =>
      reserveAutoSend(db, { accountId: 'acc', igsid, kind: 'test', caps, now });
    expect((await a('u1', t0)).ok).toBe(true);
    expect((await a('u2', t0)).ok).toBe(true);
    expect((await a('u3', t0)).ok).toBe(false);
    // +61 min: hourly window rolled (2 sends aged out of the hour) → allowed
    const t1 = t0 + 61 * 60 * 1000;
    expect((await a('u3', t1)).ok).toBe(true);
    // daily total is now 3 → the DAILY cap binds
    const denied = await a('u4', t1);
    expect(denied).toEqual({ ok: false, reason: 'account_daily' });
    // +25h from t0: everything aged out of the 24h window → allowed again
    const t2 = t0 + 25 * HOUR;
    expect((await a('u5', t2)).ok).toBe(true);
  });

  it('per-recipient daily cap: one person can never be flooded', async () => {
    const { db } = freshDb();
    const wide = { hourlyCap: 100, dailyCap: 100, recipientDailyCap: 2 };
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    const a = (now: number) =>
      reserveAutoSend(db, { accountId: 'acc', igsid: 'victim', kind: 'test', caps: wide, now });
    expect((await a(t0)).ok).toBe(true);
    expect((await a(t0)).ok).toBe(true);
    expect(await a(t0)).toEqual({ ok: false, reason: 'recipient_daily' });
    // other recipients are unaffected
    expect((await reserveAutoSend(db, { accountId: 'acc', igsid: 'other', kind: 'test', caps: wide, now: t0 })).ok).toBe(true);
    // 24h later the window rolls
    expect((await a(t0 + DAY + 1)).ok).toBe(true);
  });

  it('RESTART-SAFE: rows written by a previous process count against the caps (no in-memory state)', async () => {
    const { raw, db } = freshDb();
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    // Simulate spend recorded before a worker restart — directly in the table.
    for (let i = 0; i < 3; i++) {
      raw.prepare('INSERT INTO auto_send_ledger (id, account_id, igsid, kind, sent_at) VALUES (?,?,?,?,?)')
        .run(`old-${i}`, 'acc', `u${i}`, 'test', t0 - 10 * 60 * 1000);
    }
    const res = await reserveAutoSend(db, { accountId: 'acc', igsid: 'u9', kind: 'test', caps, now: t0 });
    expect(res.ok).toBe(false); // dailyCap=3 already consumed pre-"restart"
  });

  it('caps are PER ACCOUNT (one account cannot spend another account\'s budget)', async () => {
    const { db } = freshDb();
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    expect((await reserveAutoSend(db, { accountId: 'A', igsid: 'u1', kind: 'x', caps, now: t0 })).ok).toBe(true);
    expect((await reserveAutoSend(db, { accountId: 'A', igsid: 'u2', kind: 'x', caps, now: t0 })).ok).toBe(true);
    expect((await reserveAutoSend(db, { accountId: 'A', igsid: 'u3', kind: 'x', caps, now: t0 })).ok).toBe(false);
    expect((await reserveAutoSend(db, { accountId: 'B', igsid: 'u1', kind: 'x', caps, now: t0 })).ok).toBe(true);
  });

  it('8 concurrent reservations against 1 remaining slot → exactly one winner (atomic conditional INSERT)', async () => {
    const { db } = freshDb();
    const t0 = Date.parse('2026-07-22T00:00:00Z');
    const tight = { hourlyCap: 1, dailyCap: 1, recipientDailyCap: 1 };
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        reserveAutoSend(db, { accountId: 'acc', igsid: `u${i}`, kind: 'x', caps: tight, now: t0 })),
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it('fails CLOSED on store error', async () => {
    const raw = new DatabaseSync(':memory:');
    const db = d1(raw);
    const res = await reserveAutoSend(db, { accountId: 'a', igsid: 'i', kind: 'x', caps, now: Date.now() });
    expect(res).toEqual({ ok: false, reason: 'store_error' });
  });
});

describe('withinStandardWindow — real messages_log', () => {
  function seedInbound(raw: SqliteDb, followerId: number, createdAt: string, direction = 'in') {
    raw.prepare(
      `INSERT INTO messages_log (follower_id, direction, message_type, body, created_at) VALUES (?,?,?,?,?)`,
    ).run(followerId, direction, 'text', '{}', createdAt);
  }

  it('true within 24h of the last inbound message', async () => {
    const { raw, db } = freshDb();
    const now = Date.parse('2026-07-22T12:00:00Z');
    seedInbound(raw, 7, '2026-07-22T11:00:00Z');
    expect(await withinStandardWindow(db, 7, now)).toBe(true);
  });

  it('false after 24h / with no inbound / with only OUTBOUND traffic', async () => {
    const { raw, db } = freshDb();
    const now = Date.parse('2026-07-22T12:00:00Z');
    seedInbound(raw, 7, '2026-07-21T11:00:00Z');       // 25h ago
    seedInbound(raw, 8, '2026-07-22T11:59:00Z', 'out'); // outbound only
    expect(await withinStandardWindow(db, 7, now)).toBe(false);
    expect(await withinStandardWindow(db, 8, now)).toBe(false);
    expect(await withinStandardWindow(db, 9, now)).toBe(false);
  });

  it('uses the LATEST inbound (an old message does not mask a fresh one)', async () => {
    const { raw, db } = freshDb();
    const now = Date.parse('2026-07-22T12:00:00Z');
    seedInbound(raw, 7, '2026-07-20T11:00:00Z');
    seedInbound(raw, 7, '2026-07-22T11:30:00Z');
    expect(await withinStandardWindow(db, 7, now)).toBe(true);
  });

  it('fails CLOSED (outside) on store error', async () => {
    const raw = new DatabaseSync(':memory:');
    expect(await withinStandardWindow(d1(raw), 1, Date.now())).toBe(false);
  });
});

describe('reconcileDarkAutoSend — dark-transition disarm sweep (real SQL)', () => {
  /** Armed-entity tables + the audit table (schema.sql / migration 0022 shapes). */
  function sweepDb(): { raw: SqliteDb; db: D1Database } {
    const raw = new DatabaseSync(':memory:');
    raw.exec(`
      CREATE TABLE comment_rules (
        id TEXT PRIMARY KEY,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
      );
      CREATE TABLE engagement_gates (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','archived')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
      );
      CREATE TABLE scenarios (
        id TEXT PRIMARY KEY,
        is_active INTEGER DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')))
      );
      CREATE TABLE autodm_disarm_log (
        id          TEXT PRIMARY KEY,
        entity_kind TEXT NOT NULL CHECK(entity_kind IN ('comment_rule','engagement_gate','scenario')),
        entity_id   TEXT NOT NULL,
        disarmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))),
        restored_at TEXT
      );
      CREATE UNIQUE INDEX idx_autodm_disarm_open
        ON autodm_disarm_log(entity_kind, entity_id)
        WHERE restored_at IS NULL;
    `);
    return { raw, db: d1(raw) };
  }
  const openLog = (raw: SqliteDb, kind: string) =>
    (raw.prepare('SELECT COUNT(*) AS n FROM autodm_disarm_log WHERE entity_kind = ? AND restored_at IS NULL').get(kind) as { n: number }).n;

  it('disarms ARMED rows in all three tables and audits each flip', async () => {
    const { raw, db } = sweepDb();
    raw.exec(`
      INSERT INTO comment_rules (id, is_active) VALUES ('r1', 1), ('r2', 1);
      INSERT INTO engagement_gates (id, status) VALUES ('g1', 'active');
      INSERT INTO scenarios (id, is_active) VALUES ('s1', 1);
    `);
    const res = await reconcileDarkAutoSend(db);
    expect(res).toEqual({
      disarmed: { comment_rules: 2, engagement_gates: 1, scenarios: 1 },
      errors: [],
    });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM comment_rules WHERE is_active = 1').get() as { n: number }).n).toBe(0);
    expect((raw.prepare("SELECT status FROM engagement_gates WHERE id = 'g1'").get() as { status: string }).status).toBe('paused');
    expect((raw.prepare('SELECT COUNT(*) AS n FROM scenarios WHERE is_active = 1').get() as { n: number }).n).toBe(0);
    expect(openLog(raw, 'comment_rule')).toBe(2);
    expect(openLog(raw, 'engagement_gate')).toBe(1);
    expect(openLog(raw, 'scenario')).toBe(1);
  });

  it('is IDEMPOTENT: a second pass disarms 0 and writes no duplicate audit rows', async () => {
    const { raw, db } = sweepDb();
    raw.exec("INSERT INTO comment_rules (id, is_active) VALUES ('r1', 1)");
    await reconcileDarkAutoSend(db);
    const res = await reconcileDarkAutoSend(db);
    expect(res.disarmed).toEqual({ comment_rules: 0, engagement_gates: 0, scenarios: 0 });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM autodm_disarm_log').get() as { n: number }).n).toBe(1);
  });

  it('never touches or logs rows the OWNER already paused (only sweep-disarmed rows are restorable)', async () => {
    const { raw, db } = sweepDb();
    raw.exec(`
      INSERT INTO comment_rules (id, is_active) VALUES ('owner-paused', 0);
      INSERT INTO engagement_gates (id, status) VALUES ('owner-archived', 'archived'), ('owner-paused-g', 'paused');
      INSERT INTO scenarios (id, is_active) VALUES ('owner-off', 0);
    `);
    const res = await reconcileDarkAutoSend(db);
    expect(res.disarmed).toEqual({ comment_rules: 0, engagement_gates: 0, scenarios: 0 });
    expect((raw.prepare('SELECT COUNT(*) AS n FROM autodm_disarm_log').get() as { n: number }).n).toBe(0);
    // untouched states
    expect((raw.prepare("SELECT status FROM engagement_gates WHERE id = 'owner-archived'").get() as { status: string }).status).toBe('archived');
  });

  it('supports the disarm → go-live restore → dark-again lifecycle (partial unique index allows a NEW open row)', async () => {
    const { raw, db } = sweepDb();
    raw.exec("INSERT INTO comment_rules (id, is_active) VALUES ('r1', 1)");
    await reconcileDarkAutoSend(db);
    // Go-live restore procedure (documented in migration 0022)
    raw.exec(`
      UPDATE comment_rules SET is_active = 1
        WHERE id IN (SELECT entity_id FROM autodm_disarm_log WHERE entity_kind = 'comment_rule' AND restored_at IS NULL);
      UPDATE autodm_disarm_log SET restored_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')) WHERE restored_at IS NULL;
    `);
    expect((raw.prepare("SELECT is_active FROM comment_rules WHERE id = 'r1'").get() as { is_active: number }).is_active).toBe(1);
    // dark again → sweep re-disarms and opens a NEW audit row
    const res = await reconcileDarkAutoSend(db);
    expect(res.disarmed.comment_rules).toBe(1);
    expect(openLog(raw, 'comment_rule')).toBe(1);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM autodm_disarm_log').get() as { n: number }).n).toBe(2);
  });

  it('FAIL-SOFT on an unmigrated D1 (audit table missing): reports errors, throws nothing, disarms nothing', async () => {
    const { raw, db } = sweepDb();
    raw.exec("DROP INDEX idx_autodm_disarm_open; DROP TABLE autodm_disarm_log; INSERT INTO comment_rules (id, is_active) VALUES ('r1', 1)");
    const res = await reconcileDarkAutoSend(db);
    expect(res.errors).toEqual(['comment_rule', 'engagement_gate', 'scenario']);
    // audit-first ordering: no audit possible → no disarm (runtime gate remains the floor)
    expect((raw.prepare("SELECT is_active FROM comment_rules WHERE id = 'r1'").get() as { is_active: number }).is_active).toBe(1);
  });

  it('FAIL-SOFT per kind: one missing entity table does not stop the other sweeps', async () => {
    const { raw, db } = sweepDb();
    raw.exec("DROP TABLE comment_rules; INSERT INTO scenarios (id, is_active) VALUES ('s1', 1)");
    const res = await reconcileDarkAutoSend(db);
    expect(res.errors).toEqual(['comment_rule']);
    expect(res.disarmed.scenarios).toBe(1);
    expect(openLog(raw, 'scenario')).toBe(1);
  });
});

describe('env plumbing', () => {
  it('autoSendEnabled: ONLY the exact string "1" lights up', () => {
    expect(autoSendEnabled({})).toBe(false);
    expect(autoSendEnabled({ AUTO_DM_ENABLED: undefined })).toBe(false);
    expect(autoSendEnabled({ AUTO_DM_ENABLED: '' })).toBe(false);
    expect(autoSendEnabled({ AUTO_DM_ENABLED: '0' })).toBe(false);
    expect(autoSendEnabled({ AUTO_DM_ENABLED: 'true' })).toBe(false);
    expect(autoSendEnabled({ AUTO_DM_ENABLED: '1' })).toBe(true);
  });

  it('autoDmCaps: conservative defaults; invalid values fall back', () => {
    expect(autoDmCaps({})).toEqual(DEFAULT_AUTO_DM_CAPS);
    expect(autoDmCaps({ AUTO_DM_HOURLY_CAP: '-5', AUTO_DM_DAILY_CAP: 'abc', AUTO_DM_RECIPIENT_DAILY_CAP: '0' }))
      .toEqual(DEFAULT_AUTO_DM_CAPS);
    expect(autoDmCaps({ AUTO_DM_HOURLY_CAP: '50', AUTO_DM_DAILY_CAP: '150', AUTO_DM_RECIPIENT_DAILY_CAP: '3' }))
      .toEqual({ hourlyCap: 50, dailyCap: 150, recipientDailyCap: 3 });
  });
});
