// =============================================================================
// auto-send-safety.ts — policy-compliance + abuse-resistance layer for every
// AUTOMATED outbound DM (comment rules, engagement gates + followup drip,
// scenarios, broadcasts, form acks). Built DARK 2026-07-22: nothing here turns
// any sender on — it makes the senders refuse to fire unless they are BOTH
// enabled at runtime AND inside policy/caps.
//
// Four independent mechanisms, all fail-closed:
//
// 1. RUNTIME DARK-GATE — autoSendEnabled(env): the worker itself refuses all
//    automated sends unless AUTO_DM_ENABLED === '1' (default unset = OFF).
//    This closes the "pre-armed rule" hole: an ACTIVE comment rule / gate /
//    scenario already sitting in this worker's D1 can NOT fire while the
//    switch is off — the capability itself is off inside the worker,
//    independent of anything upstream.
//
// 2. TRIGGER DEDUP — claimTriggerDelivery(): claim-before-send row in
//    comment_deliveries keyed (trigger_kind, trigger_id, event_id). Meta
//    webhooks are at-least-once; a REDELIVERED comment/message hits the
//    PRIMARY KEY → no second DM. comment_rule rows additionally carry a
//    partial UNIQUE (trigger_id, igsid) so one person is DM'd at most once
//    per rule, race-proof at the SQL layer (concurrent webhooks included).
//
// 3. OUTBOUND CAPS — reserveAutoSend(): rolling per-account 1h/24h + per-
//    recipient 24h budgets, enforced by a SINGLE conditional INSERT into
//    auto_send_ledger (atomic in SQLite → no check-then-insert race), rows
//    reserved BEFORE the Graph call and NEVER refunded on ambiguous outcomes
//    (deliberately conservative: a crash after reserve costs quota, never
//    costs a recipient spam).
//    D1 is durable storage: a worker restart / re-deploy cannot reset counts.
//
//    Default caps (env-overridable) and their basis — Meta platform
//    ceilings verified 2026-07-22: private replies 750 calls/hour/account,
//    text messaging 100 calls/second/account; the REAL enforcement trigger
//    is spam quality signals (user reports / blocks), so defaults sit far
//    below the technical ceilings:
//      AUTO_DM_HOURLY_CAP           = 100  sends/account/rolling hour
//      AUTO_DM_DAILY_CAP            = 300  sends/account/rolling 24h
//      AUTO_DM_RECIPIENT_DAILY_CAP  = 5    sends/recipient/rolling 24h
//    (5 per recipient covers a full legit gate flow: CTA → reminder →
//    reward → a couple of drip steps — anything past that is flooding.)
//
// 4. 24H STANDARD WINDOW — withinStandardWindow(): Meta only allows
//    recipient:{id} sends within 24h of the person's LAST inbound message
//    (messages_log direction='in' — inbound DMs and postback presses are
//    both logged there). Cron-shaped senders (scenario steps, followup
//    drip, broadcasts, form acks) must pass this check per recipient; the
//    only sanctioned OUT-of-window automated send is a Private Reply to a
//    comment (recipient:{comment_id}, ≤7 days, once per comment).
//
// 5. DARK-STATE RECONCILE SWEEP — reconcileDarkAutoSend(): the runtime gate
//    (1) only stops FIRING; rows armed BEFORE the capability went dark stay
//    is_active=1 / status='active' in D1. The cron calls this sweep on every
//    tick while dark: armed comment_rules / engagement_gates / scenarios are
//    flipped to their disarmed state, each audited in autodm_disarm_log so
//    go-live can restore EXACTLY what the sweep disarmed (and nothing the
//    owner paused themselves). Defense-in-depth: a future build regression that
//    loses the runtime gate finds no pre-armed rows to fire.
// =============================================================================

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Ledger retention: strictly more than the largest window so a prune can never
// erase in-window spend (erasing spend = cap bypass).
const PRUNE_MS = 25 * HOUR_MS;

export interface AutoDmCaps {
  hourlyCap: number;
  dailyCap: number;
  recipientDailyCap: number;
}

export const DEFAULT_AUTO_DM_CAPS: AutoDmCaps = {
  hourlyCap: 100,
  dailyCap: 300,
  recipientDailyCap: 5,
};

interface AutoDmEnvLike {
  AUTO_DM_ENABLED?: string;
  AUTO_DM_HOURLY_CAP?: string;
  AUTO_DM_DAILY_CAP?: string;
  AUTO_DM_RECIPIENT_DAILY_CAP?: string;
}

/**
 * Runtime dark-gate. '1' is the ONLY lit value; unset / '' / '0' / anything
 * else = dark. The operator sets this on their own worker only when they are
 * ready to go live — until then even pre-armed ACTIVE rules in D1 cannot
 * fire. OFF is the shipped default: a user who does nothing sends nothing.
 */
export function autoSendEnabled(env: AutoDmEnvLike): boolean {
  return env.AUTO_DM_ENABLED === '1';
}

/** Caps from env with conservative defaults. Invalid/non-positive → default. */
export function autoDmCaps(env: AutoDmEnvLike): AutoDmCaps {
  const n = (v: string | undefined, d: number): number => {
    const x = Number.parseInt(v ?? '', 10);
    return Number.isFinite(x) && x > 0 ? x : d;
  };
  return {
    hourlyCap: n(env.AUTO_DM_HOURLY_CAP, DEFAULT_AUTO_DM_CAPS.hourlyCap),
    dailyCap: n(env.AUTO_DM_DAILY_CAP, DEFAULT_AUTO_DM_CAPS.dailyCap),
    recipientDailyCap: n(env.AUTO_DM_RECIPIENT_DAILY_CAP, DEFAULT_AUTO_DM_CAPS.recipientDailyCap),
  };
}

export type TriggerKind = 'comment_rule' | 'gate' | 'gate_dm' | 'scenario' | 'scenario_dm';

/**
 * Claim-before-send idempotency. Returns true exactly once per
 * (kind, triggerId, eventId) — a webhook REDELIVERY of the same comment id /
 * message mid gets false and must NOT send. For kind='comment_rule' the
 * partial unique index also returns false when this rule already messaged
 * this igsid via a DIFFERENT comment (one DM per person per rule, ever).
 *
 * FAIL-CLOSED: any store error (e.g. missing table on an unmigrated D1)
 * returns false → no send. An automated DM without recorded accounting is
 * exactly the abuse we're preventing, so "can't record" must mean "don't send".
 */
export async function claimTriggerDelivery(
  db: D1Database,
  args: { kind: TriggerKind; triggerId: string; eventId: string; igsid: string },
): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT OR IGNORE INTO comment_deliveries (trigger_kind, trigger_id, event_id, igsid)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(args.kind, args.triggerId, args.eventId, args.igsid)
      .run();
    return (res.meta?.changes ?? 0) === 1;
  } catch (err) {
    console.error('[auto-send] claim failed (fail-closed, not sending):', err);
    return false;
  }
}

export type ReserveResult =
  | { ok: true }
  | { ok: false; reason: 'account_hourly' | 'account_daily' | 'recipient_daily' | 'store_error' };

/**
 * Reserve ONE automated send against the rolling budgets, atomically.
 * The conditional INSERT executes as a single SQLite statement, so the cap
 * check and the reservation cannot race (two concurrent webhook events can
 * never both squeeze past the last remaining slot). The row is written
 * BEFORE the Graph call; the caller never refunds on a failed/ambiguous
 * send (conservative: a crash costs quota, never costs a recipient spam).
 *
 * FAIL-CLOSED: store errors deny the send.
 */
export async function reserveAutoSend(
  db: D1Database,
  args: { accountId: string; igsid: string; kind: string; caps: AutoDmCaps; now?: number },
): Promise<ReserveResult> {
  const now = args.now ?? Date.now();
  const { hourlyCap, dailyCap, recipientDailyCap } = args.caps;
  try {
    // Prune expired rows first (bounded table). 25h retention > 24h window so
    // in-window spend is never erased.
    await db
      .prepare('DELETE FROM auto_send_ledger WHERE sent_at < ?')
      .bind(now - PRUNE_MS)
      .run();

    const res = await db
      .prepare(
        `INSERT INTO auto_send_ledger (id, account_id, igsid, kind, sent_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM auto_send_ledger WHERE account_id = ? AND sent_at > ?) < ?
           AND (SELECT COUNT(*) FROM auto_send_ledger WHERE account_id = ? AND sent_at > ?) < ?
           AND (SELECT COUNT(*) FROM auto_send_ledger WHERE account_id = ? AND igsid = ? AND sent_at > ?) < ?`,
      )
      .bind(
        crypto.randomUUID(), args.accountId, args.igsid, args.kind, now,
        args.accountId, now - HOUR_MS, hourlyCap,
        args.accountId, now - DAY_MS, dailyCap,
        args.accountId, args.igsid, now - DAY_MS, recipientDailyCap,
      )
      .run();
    if ((res.meta?.changes ?? 0) === 1) return { ok: true };

    // Denied — read the counters once more only to name the binding cap.
    const row = await db
      .prepare(
        `SELECT
           SUM(CASE WHEN sent_at > ? THEN 1 ELSE 0 END) AS hour_used,
           COUNT(*) AS day_used,
           SUM(CASE WHEN igsid = ? THEN 1 ELSE 0 END) AS recipient_used
         FROM auto_send_ledger WHERE account_id = ? AND sent_at > ?`,
      )
      .bind(now - HOUR_MS, args.igsid, args.accountId, now - DAY_MS)
      .first<{ hour_used: number; day_used: number; recipient_used: number }>();
    const reason =
      (row?.recipient_used ?? 0) >= recipientDailyCap ? 'recipient_daily'
      : (row?.hour_used ?? 0) >= hourlyCap ? 'account_hourly'
      : 'account_daily';
    console.warn(`[auto-send] cap denied account=${args.accountId} kind=${args.kind} reason=${reason}`);
    return { ok: false, reason };
  } catch (err) {
    console.error('[auto-send] reserve failed (fail-closed, not sending):', err);
    return { ok: false, reason: 'store_error' };
  }
}

/**
 * Standard messaging window: true iff this follower has an INBOUND message
 * (DM text or postback press — both are logged direction='in') within the
 * last 24h. recipient:{id} sends are policy-legal ONLY inside this window;
 * callers outside it must skip (or use a Private Reply where a comment id
 * exists and is ≤7 days old).
 *
 * FAIL-CLOSED: store errors and unparseable timestamps report "outside".
 */
export async function withinStandardWindow(
  db: D1Database,
  followerId: number | string,
  now = Date.now(),
): Promise<boolean> {
  try {
    const row = await db
      .prepare(
        `SELECT created_at FROM messages_log
         WHERE follower_id = ? AND direction = 'in'
         ORDER BY id DESC LIMIT 1`,
      )
      .bind(followerId)
      .first<{ created_at: string }>();
    if (!row?.created_at) return false;
    const t = Date.parse(row.created_at);
    if (!Number.isFinite(t)) return false;
    return now - t <= DAY_MS;
  } catch (err) {
    console.error('[auto-send] window check failed (fail-closed):', err);
    return false;
  }
}

export interface DarkReconcileResult {
  /** Rows flipped to disarmed by THIS run (0 on every later idempotent pass). */
  disarmed: { comment_rules: number; engagement_gates: number; scenarios: number };
  /** Entity kinds whose sweep errored (fail-soft; runtime gate still blocks firing). */
  errors: string[];
}

const SQL_NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))";

/**
 * Dark-transition reconcile sweep. Runs from the cron on every tick while
 * AUTO_DM_ENABLED is dark; disarms rows that are still ARMED in D1:
 *
 *   comment_rules    is_active 1 → 0
 *   engagement_gates status 'active' → 'paused'
 *   scenarios        is_active 1 → 0
 *
 * Each disarm is AUDITED first: an open row (restored_at IS NULL) per entity
 * in autodm_disarm_log records that the SWEEP — not the owner — paused it, so
 * go-live can restore exactly this set (see migration 0022 for the restore SQL)
 * and never re-arms anything the owner paused deliberately (owner-paused rows
 * are already inactive → never selected → never logged).
 *
 * Ordering & crash safety: audit INSERT (OR IGNORE against the open-row
 * partial unique index) comes BEFORE the UPDATE. A crash between the two
 * leaves an audit row for a still-armed entity — the next tick's UPDATE
 * (WHERE armed) heals it; the INSERT dedups. Both statements are idempotent,
 * so after the first full pass every statement touches 0 rows (cheap).
 *
 * FAIL-SOFT per entity kind: an error (e.g. autodm_disarm_log missing on an
 * unmigrated D1) skips the DISARM for that kind — never disarm without audit,
 * or go-live could not tell sweep-paused from owner-paused. Armed rows left
 * behind still cannot fire: the runtime gate is the floor, this sweep is the
 * belt-and-braces layer. Errors are reported, never thrown (the cron's token
 * liveness must survive a sweep failure).
 */
export async function reconcileDarkAutoSend(db: D1Database): Promise<DarkReconcileResult> {
  const result: DarkReconcileResult = {
    disarmed: { comment_rules: 0, engagement_gates: 0, scenarios: 0 },
    errors: [],
  };
  const sweeps: Array<{
    key: keyof DarkReconcileResult['disarmed'];
    kind: string;
    auditSql: string;
    disarmSql: string;
  }> = [
    {
      key: 'comment_rules',
      kind: 'comment_rule',
      auditSql: `INSERT OR IGNORE INTO autodm_disarm_log (id, entity_kind, entity_id)
                 SELECT lower(hex(randomblob(16))), 'comment_rule', id FROM comment_rules WHERE is_active = 1`,
      disarmSql: `UPDATE comment_rules SET is_active = 0, updated_at = ${SQL_NOW} WHERE is_active = 1`,
    },
    {
      key: 'engagement_gates',
      kind: 'engagement_gate',
      auditSql: `INSERT OR IGNORE INTO autodm_disarm_log (id, entity_kind, entity_id)
                 SELECT lower(hex(randomblob(16))), 'engagement_gate', id FROM engagement_gates WHERE status = 'active'`,
      disarmSql: `UPDATE engagement_gates SET status = 'paused', updated_at = ${SQL_NOW} WHERE status = 'active'`,
    },
    {
      key: 'scenarios',
      kind: 'scenario',
      auditSql: `INSERT OR IGNORE INTO autodm_disarm_log (id, entity_kind, entity_id)
                 SELECT lower(hex(randomblob(16))), 'scenario', id FROM scenarios WHERE is_active = 1`,
      disarmSql: `UPDATE scenarios SET is_active = 0, updated_at = ${SQL_NOW} WHERE is_active = 1`,
    },
  ];
  for (const s of sweeps) {
    try {
      await db.prepare(s.auditSql).run();
      const res = await db.prepare(s.disarmSql).run();
      const n = res.meta?.changes ?? 0;
      result.disarmed[s.key] = n;
      if (n > 0) console.warn(`[auto-send] dark sweep disarmed ${n} armed ${s.kind} row(s)`);
    } catch (err) {
      result.errors.push(s.kind);
      console.error(`[auto-send] dark sweep failed for ${s.kind} (armed rows left; runtime gate still blocks firing):`, err);
    }
  }
  return result;
}
