-- Pending-order reconciliation fix: persists the safe diagnostic subset of
-- MT5's MqlTradeResult (retcode, retcode name, order/deal tickets,
-- request_id, comment, retcode_external, price, volume, bid, ask, and which
-- reconciliation source confirmed it) for every order_send attempt —
-- success or failure — so a case like PENDING_ORDER_NOT_CONFIRMED is always
-- diagnosable after the fact. Never contains credentials/secrets — MT5's own
-- MqlTradeResult never carries any. Additive only.
ALTER TABLE ai_trade_plans ADD COLUMN IF NOT EXISTS execution_snapshot JSONB;
