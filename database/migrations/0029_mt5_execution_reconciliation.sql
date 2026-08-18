-- MT5 execution reconciliation.
-- Fixes the root cause: DemoExecutionGateway used to treat an empty/None
-- order_check or order_send result (retcode falls back to 0) as success,
-- so trade_outcomes/mt5_entry_plans rows could be marked EXECUTED/OPEN with
-- no real MT5 position behind them. That gate is fixed in application code
-- (services/trading-engine/mt5/adapter.py). This migration:
--   1. adds a RECONCILIATION_FAILED terminal state so the app can represent
--      "looked executed but MT5 never confirmed it" instead of leaving a
--      trade stuck showing as open/still open forever, and
--   2. corrects the one known bad row (a non-numeric order_ticket is only
--      ever produced by the pre-fix fallback that used the execution_key
--      string in place of a real MT5 ticket — a real MT5 ticket is always
--      numeric), without deleting any audit/history evidence.

ALTER TABLE mt5_entry_plans DROP CONSTRAINT IF EXISTS mt5_entry_plans_status_check;
ALTER TABLE mt5_entry_plans ADD CONSTRAINT mt5_entry_plans_status_check
  CHECK (status IN ('WAITING','READY','TRIGGERED','EXECUTING','EXECUTED','EXPIRED','CANCELLED','BLOCKED','RECONCILIATION_FAILED'));

ALTER TABLE trade_outcomes DROP CONSTRAINT IF EXISTS trade_outcomes_exit_reason_check;
ALTER TABLE trade_outcomes ADD CONSTRAINT trade_outcomes_exit_reason_check
  CHECK (exit_reason IN ('STOP_LOSS','TAKE_PROFIT','MANUAL_CLOSE','TIME_EXIT','RISK_EXIT','BROKER_CLOSE','OTHER','RECONCILIATION_FAILED'));

-- One-time correction of any pre-fix rows: a real MT5 order ticket is always
-- a positive integer. Anything else (e.g. the "entry-plan:<uuid>:<ms>"
-- idempotency-key fallback used before this fix) proves order_send/positions
-- were never actually confirmed.
UPDATE trade_outcomes
SET closed_at = now(),
    exit_reason = 'RECONCILIATION_FAILED'
WHERE closed_at IS NULL
  AND (order_ticket IS NULL OR order_ticket !~ '^[0-9]+$');

UPDATE mt5_entry_plans
SET status = 'RECONCILIATION_FAILED',
    blocked_at = now(),
    block_reason = 'EXECUTION_NOT_CONFIRMED_BY_MT5',
    updated_at = now()
WHERE status = 'EXECUTED'
  AND id IN (
    SELECT entry_plan_id FROM trade_outcomes
    WHERE exit_reason = 'RECONCILIATION_FAILED' AND entry_plan_id IS NOT NULL
  );
