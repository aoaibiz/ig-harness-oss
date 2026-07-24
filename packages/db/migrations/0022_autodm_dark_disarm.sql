-- 0022_autodm_dark_disarm.sql — dark-state reconcile sweep audit (2026-07-22).
-- Companion to 0021: AUTO_DM_ENABLED only gates FIRING at runtime; rows armed
-- BEFORE the capability went dark stay is_active=1 / status='active' in D1.
-- The cron sweep (services/auto-send-safety.ts reconcileDarkAutoSend) disarms
-- them while dark and audits each flip here, so go-live can restore EXACTLY the
-- sweep-disarmed set — and never anything the owner paused deliberately.
--
-- An OPEN row (restored_at IS NULL) = "this entity is currently disarmed by
-- the sweep". The partial unique index allows a full disarm→restore→disarm
-- lifecycle while dedup-ing concurrent/crash-retried sweep inserts.
CREATE TABLE IF NOT EXISTS autodm_disarm_log (
  id          TEXT PRIMARY KEY,
  entity_kind TEXT NOT NULL CHECK(entity_kind IN ('comment_rule','engagement_gate','scenario')),
  entity_id   TEXT NOT NULL,
  disarmed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))),
  restored_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_autodm_disarm_open
  ON autodm_disarm_log(entity_kind, entity_id)
  WHERE restored_at IS NULL;

-- Go-live restore procedure (operator step, run in ONE D1 session; do NOT
-- automate inside the worker — going live is a human-gated transition):
--   UPDATE comment_rules SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
--     WHERE id IN (SELECT entity_id FROM autodm_disarm_log WHERE entity_kind = 'comment_rule' AND restored_at IS NULL);
--   UPDATE engagement_gates SET status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
--     WHERE status = 'paused'
--       AND id IN (SELECT entity_id FROM autodm_disarm_log WHERE entity_kind = 'engagement_gate' AND restored_at IS NULL);
--   UPDATE scenarios SET is_active = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now'))
--     WHERE id IN (SELECT entity_id FROM autodm_disarm_log WHERE entity_kind = 'scenario' AND restored_at IS NULL);
--   UPDATE autodm_disarm_log SET restored_at = strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now')) WHERE restored_at IS NULL;
