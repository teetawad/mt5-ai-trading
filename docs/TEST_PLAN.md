# Test Plan

Required coverage:

- MT5 unavailable, reconnect, DEMO accepted, REAL blocked, wrong login/server blocked, trading disabled blocked.
- Completed H1 candle only, duplicate candle protection, decision persistence.
- Risk sizing, stale quote, spread, margin, daily loss, drawdown, cooldown, max trades, duplicate position/order, kill switch.
- Execution order_check failure, order_send failure, AUTO-DEMO idempotency, SL/TP, reconciliation/restart recovery.
- Learning dataset, chronological split, leakage prevention, challenger rejection and promotion gate.
- Frontend disconnected MT5, blocked real account, scanner, AUTO-DEMO, AI Lab, null/error handling.
