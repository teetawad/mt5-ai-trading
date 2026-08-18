-- Pending-order confirmation/reconciliation fix: persists MT5's
-- MqlTradeResult.request_id for diagnostics/correlation only (never treated
-- as an order ticket — see mt5/adapter.py's execute_pending_order) and
-- widens ai_trade_plans.blocked_reason usage to the new distinct outcomes
-- (PENDING_ORDER_NOT_CONFIRMED / PENDING_ORDER_CONFIRMATION_AMBIGUOUS /
-- PENDING_ORDER_REJECTED) — blocked_reason is already a free-text column,
-- so no constraint change is needed for those, only the new column.

ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS mt5_request_id TEXT;
