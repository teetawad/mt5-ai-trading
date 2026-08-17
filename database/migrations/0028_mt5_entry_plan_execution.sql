-- EntryPlanWatcher execution lifecycle.
-- Additive/alter only: preserves existing mt5_entry_plans/trade_outcomes rows.
-- Adds a strict EXECUTING state, an idempotency key, and actual MT5 execution
-- facts so the watcher can claim a plan exactly once and reconcile safely
-- after a worker/API restart or an order_send timeout.

ALTER TABLE mt5_entry_plans DROP CONSTRAINT IF EXISTS mt5_entry_plans_status_check;
ALTER TABLE mt5_entry_plans ADD CONSTRAINT mt5_entry_plans_status_check
  CHECK (status IN ('WAITING','READY','TRIGGERED','EXECUTING','EXECUTED','EXPIRED','CANCELLED','BLOCKED'));

ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS executing_at TIMESTAMPTZ;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS blocked_at TIMESTAMPTZ;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS block_reason TEXT;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS execution_key TEXT;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS order_ticket TEXT;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS deal_ticket TEXT;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS retcode INTEGER;
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS actual_entry NUMERIC(18,8);
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS final_volume NUMERIC(18,8);
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS target_profit NUMERIC(18,8);
ALTER TABLE mt5_entry_plans ADD COLUMN IF NOT EXISTS model_version TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS mt5_entry_plans_execution_key_uidx
  ON mt5_entry_plans(execution_key) WHERE execution_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS mt5_entry_plans_executing_idx
  ON mt5_entry_plans(status, executing_at) WHERE status = 'EXECUTING';

ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS entry_plan_id UUID REFERENCES mt5_entry_plans(id);
ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS deal_ticket TEXT;
ALTER TABLE trade_outcomes ADD COLUMN IF NOT EXISTS retcode INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS trade_outcomes_entry_plan_uidx
  ON trade_outcomes(entry_plan_id) WHERE entry_plan_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS trade_outcomes_open_symbol_idx
  ON trade_outcomes(symbol, opened_at DESC) WHERE closed_at IS NULL;

INSERT INTO system_settings(key, value, description)
VALUES
  ('mt5_entry_watcher_interval_ms', '15000'::jsonb, 'Poll interval for the EntryPlanWatcher that monitors WAITING/READY/TRIGGERED plans.'),
  ('mt5_entry_watcher_reconcile_grace_seconds', '120'::jsonb, 'How long an EXECUTING plan may remain unresolved before the watcher attempts reconciliation.')
ON CONFLICT (key) DO NOTHING;
