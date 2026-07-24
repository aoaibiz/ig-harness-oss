/**
 * END-TO-END proof of the auto-send safety layer at the WEBHOOK boundary,
 * against the REAL consolidated schema (packages/db/schema.sql) on a real
 * SQLite engine and the REAL InstagramClient (Graph calls captured via a
 * stubbed global fetch):
 *
 *  (1) RUNTIME DARK-GATE — a pre-ARMED ACTIVE comment rule in D1 does NOT
 *      fire while AUTO_DM_ENABLED is unset (dark = dark even for armed rules).
 *  (2) PRIVATE REPLY SHAPE — when lit, the comment→DM leaves as
 *      POST /{IG_ID}/messages with recipient:{comment_id} (never {id}).
 *  (3) REDELIVERY DEDUP — the same signed webhook delivered twice produces
 *      exactly ONE outbound DM.
 *  (4) PER-RECIPIENT DEDUP — a second comment by the same person on the same
 *      rule produces no second DM.
 *  (5) POSTBACK DARK-GATE — an armed gate's CHECK_FOLLOW button produces no
 *      sends while dark, and the reward flows when lit.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const IG_USER_ID = '17841400000000001';
const ACCOUNT = {
  id: 'acc-1',
  ig_user_id: IG_USER_ID,
  username: 'test_creator',
  access_token: 'test-token',
  token_expires_at: null,
  token_refreshed_at: null,
  app_secret: null,
  verify_token: null,
  is_active: 1,
  is_default: 1,
  created_at: '',
  updated_at: '',
};

// Accounts lib is mocked (identity resolution is not under test); everything
// else — db helpers, engagement-gate service, InstagramClient — is REAL.
vi.mock('../../lib/accounts.js', async () => {
  const { InstagramClient } = await import('@ig-harness/ig-sdk');
  return {
    ensureDefaultAccount: vi.fn(async () => undefined),
    pickAccountForEntry: vi.fn((_accounts: unknown[], entryId: string) =>
      entryId === IG_USER_ID ? ACCOUNT : null),
    toIgAccountRef: vi.fn(() => ({ id: 'acc-1', igUserId: IG_USER_ID, username: 'test_creator' })),
    getAccountClient: vi.fn(async () =>
      new InstagramClient({ accessToken: ACCOUNT.access_token, igUserId: ACCOUNT.ig_user_id })),
  };
});
vi.mock('../../lib/health.js', () => ({
  recordWebhookReceived: vi.fn(async () => undefined),
  recordDmFailure: vi.fn(async () => undefined),
}));

type SqliteStmt = { run: (...a: unknown[]) => { changes: number | bigint }; get: (...a: unknown[]) => unknown; all: (...a: unknown[]) => unknown[] };
type SqliteDb = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStmt };
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as {
  DatabaseSync: new (p: string) => SqliteDb;
};

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

/** Load the REAL consolidated schema — the exact DDL a fresh deploy gets. */
function freshDbWithRealSchema(): { raw: SqliteDb; db: D1Database } {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(
    path.resolve(here, '../../../../../packages/db/schema.sql'),
    'utf8',
  );
  const raw = new DatabaseSync(':memory:');
  raw.exec(schema);
  return { raw, db: d1(raw) };
}

async function signBody(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  return 'sha256=' + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const SECRET = 'whsec-test';

interface GraphCall { method: string; url: string; body: unknown }
function stubGraph(): { calls: GraphCall[]; messageSends: () => GraphCall[] } {
  const calls: GraphCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (input instanceof Request ? input.method : init?.method) ?? 'GET';
    let body: unknown = null;
    const rawBody = input instanceof Request ? await input.text().catch(() => null) : init?.body;
    if (typeof rawBody === 'string') { try { body = JSON.parse(rawBody); } catch { body = rawBody; } }
    calls.push({ method, url, body });
    if (url.includes('/messages')) {
      return new Response(JSON.stringify({ recipient_id: 'r', message_id: 'm' }), { status: 200 });
    }
    if (url.includes('/replies') || url.includes('/comments')) {
      return new Response(JSON.stringify({ id: 'reply-1' }), { status: 200 });
    }
    // profile lookups etc.
    return new Response(JSON.stringify({}), { status: 200 });
  }));
  return {
    calls,
    messageSends: () => calls.filter((c) => c.method === 'POST' && /\/messages$/.test(new URL(c.url).pathname)),
  };
}

async function postWebhook(
  db: D1Database,
  payload: unknown,
  env: Record<string, string | undefined>,
): Promise<Response> {
  const { Hono } = await import('hono');
  const { webhook } = await import('../webhook.js');
  const app = new Hono<never>();
  app.route('/', webhook);
  const body = JSON.stringify(payload);
  const waits: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => { waits.push(p.catch(() => {})); },
    passThroughOnException: () => {},
  } as unknown as ExecutionContext;
  const res = await app.fetch(
    new Request('http://localhost/webhook', {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': await signBody(body, SECRET), 'content-type': 'application/json' },
      body,
    }),
    { DB: db, IG_APP_SECRET: SECRET, IG_VERIFY_TOKEN: 'v', WORKER_URL: 'https://test.workers.dev', ...env },
    ctx,
  );
  await Promise.all(waits); // drain async processing before asserting
  return res;
}

function commentPayload(commentId: string, text = '特典ください') {
  return {
    object: 'instagram',
    entry: [{
      id: IG_USER_ID,
      time: 0,
      changes: [{
        field: 'comments',
        value: {
          id: commentId,
          text,
          from: { id: 'IGSID-COMMENTER', username: 'commenter' },
          media: { id: 'media-1' },
          created_time: '2026-07-22T00:00:00+0000',
        },
      }],
    }],
  };
}

function seedArmedCommentRule(raw: SqliteDb) {
  // NOTE: comment_rules.id is INTEGER PRIMARY KEY in this repo's schema.
  raw.prepare(
    `INSERT INTO comment_rules (id, name, keyword, match_type, response_type, response_body, delay_seconds, is_active, account_id)
     VALUES (1, 'armed', '特典', 'contains', 'text', ?, 0, 1, 'acc-1')`,
  ).run(JSON.stringify({ text: 'DMです {{username}}' }));
}

describe('webhook auto-send safety (real schema, real client)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.unstubAllGlobals());

  it('(1) DARK: an ARMED ACTIVE comment rule does NOT fire while AUTO_DM_ENABLED is unset', async () => {
    const { raw, db } = freshDbWithRealSchema();
    seedArmedCommentRule(raw);
    const graph = stubGraph();

    const res = await postWebhook(db, commentPayload('c-dark-1'), {});
    expect(res.status).toBe(200);

    // ZERO outbound DMs, zero public replies — nothing left the worker.
    expect(graph.messageSends()).toHaveLength(0);
    expect(graph.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // No delivery claim, no ledger spend — truly inert.
    expect(raw.prepare('SELECT COUNT(*) AS n FROM comment_deliveries').get()).toEqual({ n: 0 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM auto_send_ledger').get()).toEqual({ n: 0 });
    // The commenter IS still recorded as a follower (CRM keeps working dark).
    expect((raw.prepare('SELECT COUNT(*) AS n FROM followers').get() as { n: number }).n).toBe(1);
  });

  it('(2) LIT: the comment DM leaves as a PRIVATE REPLY — recipient:{comment_id}, never {id}', async () => {
    const { raw, db } = freshDbWithRealSchema();
    seedArmedCommentRule(raw);
    const graph = stubGraph();

    const res = await postWebhook(db, commentPayload('c-lit-1'), { AUTO_DM_ENABLED: '1' });
    expect(res.status).toBe(200);

    const sends = graph.messageSends();
    expect(sends).toHaveLength(1);
    // Exact policy shape (verified 2026-07-22 against Meta docs):
    //   POST graph.instagram.com/v21.0/{IG_ID}/messages
    //   { recipient: { comment_id }, message: { text } }
    expect(new URL(sends[0]!.url).pathname).toBe(`/v21.0/${IG_USER_ID}/messages`);
    const body = sends[0]!.body as { recipient: Record<string, string>; message: { text: string } };
    expect(body.recipient).toEqual({ comment_id: 'c-lit-1' });
    expect(body.recipient).not.toHaveProperty('id');
    expect(body.message.text).toContain('DMです');
    expect(body.message.text).toContain('commenter'); // {{username}} expanded

    // Claim + ledger row recorded (durable accounting).
    expect(raw.prepare("SELECT COUNT(*) AS n FROM comment_deliveries WHERE trigger_kind='comment_rule'").get()).toEqual({ n: 1 });
    expect(raw.prepare('SELECT COUNT(*) AS n FROM auto_send_ledger').get()).toEqual({ n: 1 });
    // Outbound logged for the operator audit trail.
    expect((raw.prepare("SELECT COUNT(*) AS n FROM messages_log WHERE direction='out' AND trigger_source='comment_rule'").get() as { n: number }).n).toBe(1);
  });

  it('(3) REDELIVERY: the same webhook delivered TWICE produces exactly ONE DM', async () => {
    const { raw, db } = freshDbWithRealSchema();
    seedArmedCommentRule(raw);
    const graph = stubGraph();

    await postWebhook(db, commentPayload('c-re-1'), { AUTO_DM_ENABLED: '1' });
    await postWebhook(db, commentPayload('c-re-1'), { AUTO_DM_ENABLED: '1' });

    expect(graph.messageSends()).toHaveLength(1);
    expect((raw.prepare('SELECT COUNT(*) AS n FROM auto_send_ledger').get() as { n: number }).n).toBe(1);
  });

  it('(4) PER-RECIPIENT: a second, DIFFERENT comment by the same person on the same rule sends nothing', async () => {
    const { raw, db } = freshDbWithRealSchema();
    seedArmedCommentRule(raw);
    const graph = stubGraph();

    await postWebhook(db, commentPayload('c-a'), { AUTO_DM_ENABLED: '1' });
    await postWebhook(db, commentPayload('c-b'), { AUTO_DM_ENABLED: '1' });

    expect(graph.messageSends()).toHaveLength(1);
  });

  it('(5) POSTBACK: armed gate reward does NOT send while dark; sends when lit', async () => {
    const { raw, db } = freshDbWithRealSchema();
    // Armed gate + an issued CTA delivery (as if armed before the dark switch).
    raw.prepare(
      `INSERT INTO engagement_gates (id, name, status, trigger_type, trigger_keyword, require_follow,
         initial_dm_text, initial_dm_button_label, follow_reminder_dm_text, follow_reminder_button_label,
         reward_dm_text, reward_url, max_loops, account_id)
       VALUES ('gate-1','g','active','comment_on_post','k',0,'cta','btn','rem','rbtn','ここが特典です',NULL,0,'acc-1')`,
    ).run();
    raw.prepare(
      `INSERT INTO followers (id, igsid, account_id) VALUES (42, 'IGSID-COMMENTER', 'acc-1')`,
    ).run();
    raw.prepare(
      `INSERT INTO gate_deliveries (id, gate_id, follower_id, igsid, status) VALUES ('d-1','gate-1',42,'IGSID-COMMENTER','cta_sent')`,
    ).run();

    const postback = {
      object: 'instagram',
      entry: [{
        id: IG_USER_ID,
        time: 0,
        messaging: [{
          sender: { id: 'IGSID-COMMENTER' },
          recipient: { id: IG_USER_ID },
          timestamp: 0,
          postback: { title: 'btn', payload: 'CHECK_FOLLOW:gate-1:d-1' },
        }],
      }],
    };

    const dark = stubGraph();
    await postWebhook(db, postback, {});
    expect(dark.messageSends()).toHaveLength(0);
    vi.unstubAllGlobals();

    const lit = stubGraph();
    await postWebhook(db, postback, { AUTO_DM_ENABLED: '1' });
    const sends = lit.messageSends();
    expect(sends).toHaveLength(1); // require_follow=0 → reward text directly
    const body = sends[0]!.body as { recipient: Record<string, string>; message: { text: string } };
    // Postback press = user interaction → in-window recipient:{id} is the
    // correct, compliant shape HERE (not a private reply).
    expect(body.recipient).toEqual({ id: 'IGSID-COMMENTER' });
    expect(body.message.text).toContain('ここが特典です');
  });

  it('(6) POSTBACK REDELIVERY: the SAME button press (same mid) delivered twice sends ONE reminder', async () => {
    const { raw, db } = freshDbWithRealSchema();
    // require_follow=1 + max_loops=0 (unlimited) + a not-following user → the
    // press produces a REMINDER and parks the delivery at 'pending_follow'
    // (non-terminal), so the status guard alone does NOT block a redelivery.
    // Only the postback-mid claim does. Profile GET is stubbed to {} →
    // is_user_follow_business falsy → not following.
    raw.prepare(
      `INSERT INTO engagement_gates (id, name, status, trigger_type, trigger_keyword, require_follow,
         initial_dm_text, initial_dm_button_label, follow_reminder_dm_text, follow_reminder_button_label,
         reward_dm_text, reward_url, max_loops, account_id)
       VALUES ('gate-1','g','active','comment_on_post','k',1,'cta','btn','フォローしてね','確認','ここが特典です',NULL,0,'acc-1')`,
    ).run();
    raw.prepare(
      `INSERT INTO followers (id, igsid, account_id) VALUES (42, 'IGSID-COMMENTER', 'acc-1')`,
    ).run();
    raw.prepare(
      `INSERT INTO gate_deliveries (id, gate_id, follower_id, igsid, status) VALUES ('d-1','gate-1',42,'IGSID-COMMENTER','cta_sent')`,
    ).run();

    const postback = {
      object: 'instagram',
      entry: [{
        id: IG_USER_ID,
        time: 0,
        messaging: [{
          sender: { id: 'IGSID-COMMENTER' },
          recipient: { id: IG_USER_ID },
          timestamp: 0,
          postback: { mid: 'pb-mid-1', title: 'btn', payload: 'CHECK_FOLLOW:gate-1:d-1' },
        }],
      }],
    };

    const graph = stubGraph();
    await postWebhook(db, postback, { AUTO_DM_ENABLED: '1' });
    await postWebhook(db, postback, { AUTO_DM_ENABLED: '1' }); // redelivery, same mid

    // Exactly ONE reminder DM despite the duplicate delivery.
    expect(graph.messageSends()).toHaveLength(1);
    // One reserve (the redelivery never reached reserveAutoSend).
    expect((raw.prepare('SELECT COUNT(*) AS n FROM auto_send_ledger').get() as { n: number }).n).toBe(1);
    // The postback-mid claim row is recorded (durable dedup key).
    expect(
      (raw.prepare("SELECT COUNT(*) AS n FROM comment_deliveries WHERE trigger_kind='gate' AND event_id='pb:pb-mid-1'").get() as { n: number }).n,
    ).toBe(1);
  });
});
