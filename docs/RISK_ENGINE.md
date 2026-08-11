# RISK_ENGINE.md

## Overview

The Risk Engine is a deterministic, rule-based system.
It evaluates whether a proposed trade is safe to proceed given current market and portfolio conditions.
**No ML, statistical models, or AI are used in the risk engine at this stage.**

The Risk Engine is implemented in Python (`services/trading-engine`) and invoked by the Node API.

---

## When Risk Is Evaluated

Risk is evaluated **twice** per proposal lifecycle:

1. **PRE_PROPOSAL** — after a signal is generated, before a proposal is created.
2. **PRE_EXECUTION** — after owner approval, before the paper broker executes.

Both checks use the **current** market snapshot and **current** portfolio state at evaluation time.
A PASS on the first check does not guarantee a PASS on the second.

---

## Risk Result Schema

Every evaluation produces a structured result:

```json
{
  "result": "PASS" | "REJECT",
  "stage": "PRE_PROPOSAL" | "PRE_EXECUTION",
  "rules_checked": ["MAX_ORDER_NOTIONAL", "MAX_POSITION_SIZE", ...],
  "failed_rules": ["MAX_DAILY_LOSS"],
  "reason": "Daily loss limit exceeded: $1,200 of $1,000 limit",
  "market_snapshot": { "symbol": "AAPL", "price": 150.25, "timestamp": "..." },
  "portfolio_snapshot": { "cash": 50000.00, "equity": 100000.00, ... },
  "evaluated_at": "2024-01-15T10:30:00Z"
}
```

Every result is persisted to `risk_checks` table regardless of PASS or REJECT.

---

## Risk Rules

All thresholds are loaded from `system_settings` at evaluation time (not hardcoded).
Values marked **CONFIGURE BEFORE USE** are development placeholders that the owner must review.

### Rule 1: KILL_SWITCH
- **Description:** Global trading kill switch must be enabled.
- **Check:** `system_settings.trading_kill_switch_enabled = true`
- **Fail action:** REJECT immediately; no further rules evaluated.
- **Priority:** Always evaluated first.

### Rule 2: TRADING_MODE
- **Description:** System must be in PAPER mode.
- **Check:** `system_settings.trading_mode = 'PAPER'`
- **Fail action:** REJECT immediately.

### Rule 3: PROPOSAL_EXPIRATION
- **Description:** Proposal must not have expired.
- **Check:** `trade_proposals.expires_at > NOW()`
- **Stage:** PRE_EXECUTION only.

### Rule 4: MARKET_DATA_FRESHNESS
- **Description:** Market data must be recent.
- **Check:** `market_snapshot.timestamp > NOW() - staleness_threshold`
- **Threshold:** `market_data_staleness_seconds` (default: 60s — **CONFIGURE**)

### Rule 5: PRICE_DRIFT
- **Description:** Current price must be within acceptable drift of reference price.
- **Check:** `|current_price - reference_price| / reference_price <= drift_threshold`
- **Threshold:** `price_drift_threshold_pct` (default: 2% — **CONFIGURE**)
- **Stage:** PRE_EXECUTION only.
- **Why:** Prevents executing at a materially different price than the owner approved.

### Rule 6: MAX_ORDER_NOTIONAL
- **Description:** Order notional value must not exceed the per-order limit.
- **Check:** `quantity × current_price <= max_order_notional_usd`
- **Threshold:** `max_order_notional_usd` (default: $10,000 — **CONFIGURE**)

### Rule 7: AVAILABLE_CASH (BUY orders)
- **Description:** Portfolio must have sufficient paper cash for the order.
- **Check:** `portfolio.cash_balance >= quantity × current_price + estimated_fee`
- **Note:** Includes pending order cash reservation.

### Rule 8: AVAILABLE_POSITION (SELL orders)
- **Description:** Portfolio must hold sufficient quantity to sell.
- **Check:** `positions[symbol].quantity >= quantity`

### Rule 9: MAX_POSITION_SIZE
- **Description:** Resulting position value must not exceed limit.
- **Check:** `(existing_quantity + quantity) × current_price <= max_position_size_usd`
- **Threshold:** `max_position_size_usd` (default: $50,000 — **CONFIGURE**)

### Rule 10: MAX_PORTFOLIO_CONCENTRATION
- **Description:** Single symbol must not exceed % of total portfolio equity.
- **Check:** `new_position_value / portfolio_equity <= max_concentration_pct`
- **Threshold:** `max_portfolio_concentration_pct` (default: 20% — **CONFIGURE**)

### Rule 11: MAX_OPEN_POSITIONS
- **Description:** Number of symbols with non-zero positions must not exceed limit.
- **Check:** `count(positions where quantity > 0) < max_open_positions`
- **Threshold:** `max_open_positions` (default: 10 — **CONFIGURE**)
- **Note:** Only applies to BUY orders opening new positions.

### Rule 12: MAX_DAILY_LOSS
- **Description:** Total realized + unrealized P&L loss today must not exceed limit.
- **Check:** `daily_pnl >= -max_daily_loss_usd`
- **Threshold:** `max_daily_loss_usd` (default: $1,000 — **CONFIGURE**)
- **Note:** When this rule fails, the kill switch is also automatically disabled.

### Rule 13: DUPLICATE_EXPOSURE
- **Description:** A pending proposal for the same symbol and side must not already exist.
- **Check:** No proposals in `[PENDING_APPROVAL, APPROVED, REVALIDATING, SUBMITTING, SUBMITTED, PARTIALLY_FILLED]` exist for same `(symbol, side)`.
- **Why:** Prevents accidentally doubling a position while one order is pending.

### Rule 14: TRADING_SESSION
- **Description:** Only permit trades during configured market hours.
- **Check:** Current time falls within `trading_session_start` and `trading_session_end`.
- **Note:** Paper trading — can be configured to allow 24/7 or restricted hours.
- **Default:** No session restriction (all hours allowed — **CONFIGURE**)

### Rule 15: COOLDOWN
- **Description:** Minimum time between orders (if configured).
- **Check:** Last filled order for this symbol was > `cooldown_seconds` ago.
- **Threshold:** `cooldown_between_trades_seconds` (default: 0 = disabled — **CONFIGURE**)

---

## Rule Evaluation Order

Rules are evaluated in this order for PRE_PROPOSAL:
1. KILL_SWITCH
2. TRADING_MODE
3. MARKET_DATA_FRESHNESS
4. MAX_ORDER_NOTIONAL
5. AVAILABLE_CASH / AVAILABLE_POSITION
6. MAX_POSITION_SIZE
7. MAX_PORTFOLIO_CONCENTRATION
8. MAX_OPEN_POSITIONS
9. MAX_DAILY_LOSS
10. DUPLICATE_EXPOSURE
11. TRADING_SESSION
12. COOLDOWN

For PRE_EXECUTION, additionally evaluate:
3a. PROPOSAL_EXPIRATION (after TRADING_MODE, before MARKET_DATA_FRESHNESS)
5a. PRICE_DRIFT (after MARKET_DATA_FRESHNESS)

All rules run unless a REJECT is encountered. Early exit only for KILL_SWITCH and TRADING_MODE.
Recording all failed rules (not just the first) provides better operator feedback.

---

## Kill Switch

The kill switch is a system-wide boolean flag stored in `system_settings`.

- **Enabled:** Proposals can proceed to execution.
- **Disabled:** All proposals are blocked at the REVALIDATING stage.
- **Auto-disable triggers:**
  - Daily loss limit exceeded.
  - EXECUTION_ERROR count exceeds threshold (future).
- **Manual re-enable:** Owner must explicitly re-enable via the settings API.
- **Dashboard:** Kill switch state is prominently displayed on the dashboard.

Kill switch state is always checked **server-side**. Frontend display is informational only.

---

## Risk Configuration API

```
GET  /risk/settings           — current risk parameters
PUT  /risk/settings/:key      — update a risk parameter (owner only, audit logged)
GET  /risk/kill-switch        — current kill switch state
PUT  /risk/kill-switch        — enable or disable (owner only, audit logged)
GET  /risk/checks             — list recent risk evaluations
GET  /risk/checks/:id         — specific risk check detail
```

---

## Unresolved Decisions

- **Trading session timezone:** Which timezone should `trading_session_start/end` use?
  Owner must decide. Defaulting to UTC until configured.
- **Cooldown granularity:** Per-symbol, per-strategy, or global? Currently per-symbol.
- **Max daily loss auto-reset:** Does the daily loss counter reset at midnight UTC?
  Currently yes — needs owner confirmation.
- **Concentration calculation:** Does it include pending orders in notional?
  Currently yes (conservative) — needs owner confirmation.
