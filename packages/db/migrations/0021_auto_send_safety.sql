-- 0021_auto_send_safety.sql — auto-send compliance hardening (2026-07-22).
-- Existing deploys get the same two tables the consolidated schema.sql ships for
-- fresh deploys. See schema.sql for the full design commentary.
--
-- comment_deliveries: trigger-level idempotency claims (claim-before-send).
--   PRIMARY KEY (trigger_kind, trigger_id, event_id) kills webhook REDELIVERY
--   (same comment/mid delivered again → INSERT conflicts → no second DM).
--   Partial UNIQUE (trigger_id, igsid) for comment_rule rows makes "one DM per
--   person per rule" race-proof at the SQL layer.
CREATE TABLE IF NOT EXISTS comment_deliveries (
  trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('comment_rule','gate','gate_dm','scenario','scenario_dm')),
  trigger_id   TEXT NOT NULL,
  event_id     TEXT NOT NULL,
  igsid        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))),
  PRIMARY KEY (trigger_kind, trigger_id, event_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_comment_deliveries_rule_recipient
  ON comment_deliveries(trigger_id, igsid)
  WHERE trigger_kind = 'comment_rule';
CREATE INDEX IF NOT EXISTS idx_comment_deliveries_igsid ON comment_deliveries(igsid);

-- auto_send_ledger: rolling outbound accounting (reserve-before-send) backing
-- the per-recipient and per-account hourly/daily caps for all automated DMs.
CREATE TABLE IF NOT EXISTS auto_send_ledger (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  igsid      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auto_send_ledger_account_time
  ON auto_send_ledger(account_id, sent_at);
CREATE INDEX IF NOT EXISTS idx_auto_send_ledger_recipient_time
  ON auto_send_ledger(account_id, igsid, sent_at);
