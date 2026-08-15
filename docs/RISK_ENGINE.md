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

> **Unit convention note:** `system_settings` stores two different
> percentage conventions and they must not be confused. `max_portfolio_concentration_pct`
> and `price_drift_threshold_pct` are stored as a **0–1 fraction** (`0.20` =
> 20%) — `riskConfig()` in `trade-proposal-service.ts` multiplies by 100
> before handing the value to this engine. The `phase22_*` thresholds
> (`phase22_stop_loss_pct`, `phase22_take_profit_pct`,
> `phase22_max_bid_ask_spread_pct`, `phase22_estimated_slippage_pct`,
> `phase22_max_estimated_slippage_pct`) are instead stored as a **whole-number
> percent** (`0.5` = 0.5%) and passed through unconverted. The `PUT
> /risk/settings/:key` API rejects values above `1` for the two
> fraction-convention keys specifically to catch a value entered under the
> wrong convention (e.g. `5` meant as "5%") before it silently becomes an
> unenforceable 500% cap.

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

## Phase 22 Advanced Risk Controls (Node-side)

A second layer of risk controls runs entirely in `apps/api`
(`phase22RiskControls` in `trade-proposal-service.ts`), in addition to the
Python rules above — both must PASS for a proposal to proceed. Unlike the
Python rules, these are computed fresh at both proposal-creation and
approval-revalidation time using live bid/ask data:

- **PHASE22_FRESH_MARKET_DATA** — market snapshot must not be stale.
- **PHASE22_BID_ASK_SPREAD** — spread must stay under `phase22_max_bid_ask_spread_pct`.
- **PHASE22_ESTIMATED_SLIPPAGE** — estimated slippage must stay under `phase22_max_estimated_slippage_pct`.
- **PHASE22_DUPLICATE_PENDING_ORDER** — no other non-terminal order may exist for the same symbol.
- **PHASE22_DUPLICATE_EXPOSURE** — no existing position or pending BUY proposal for the symbol (when `phase22_prevent_duplicate_exposure` is enabled).
- **PHASE22_COOLDOWN** — time since the symbol's last fill must exceed `cooldown_between_trades_seconds`.
- **PHASE22_MAX_DAILY_LOSS** — same day-boundary `dailyPnl` used by the Python `MAX_DAILY_LOSS` rule (see below) must stay within `max_daily_loss_usd`.
- **PHASE22_MAX_LOSS_PER_TRADE** — position size is sized down so that `quantity × (entry − stopLoss)` stays within `phase22_max_loss_per_trade_usd`; if the resulting quantity is 0, **PHASE22_POSITION_SIZE** also fails.

This layer also computes the stop-loss/take-profit prices
(`phase22_stop_loss_pct` / `phase22_take_profit_pct` from entry) that become
the bracket order sent to the broker on approval — see "Bracket Orders" in
`docs/PAPER_BROKER.md`. These prices are frozen into the proposal's
`riskSnapshot` at creation time and are immutable once `PENDING_APPROVAL`
(enforced by a DB trigger) — approval re-validates that the trade is still
within risk limits at the current price, but does not silently substitute new
SL/TP numbers for what the owner reviewed.

### Daily P&L and the auto-disable circuit breaker

`daily_pnl` (Python) / the dailyPnl used by `PHASE22_MAX_DAILY_LOSS` (Node)
is **not** cumulative P&L since account inception — it is `current equity −
equity at the start of the current UTC day`, computed from the latest
`portfolio_snapshots` row older than today (falling back to
`initial_paper_cash_usd` on day one). The reset boundary is midnight UTC.

When either `MAX_DAILY_LOSS` (Python) or `PHASE22_MAX_DAILY_LOSS` (Node)
fails, `trading_kill_switch_enabled` is set to `false` server-side
(`maybeAutoDisableKillSwitchOnDailyLoss` in `trade-proposal-service.ts`) and
an audit event (`KILL_SWITCH_AUTO_DISABLED_DAILY_LOSS`) is recorded — this is
the "Auto-disable triggers: Daily loss limit exceeded" behavior referenced
below, now implemented rather than just documented. It halts **all** further
trading platform-wide, not just the triggering proposal; the owner must
manually re-enable the kill switch via Settings.

---

## AI-Assisted Decision Layer (phase 23)

`ai-decision-service.ts`'s `analyzeUsStock` is a pure, deterministic function
(BUY/SELL/HOLD + confidence + reasons from market snapshot data). It has no
import of, or call into, any broker/execution module — it only returns an
`AiDecision` that `createAiDecisionAndProposal` feeds through the exact same
signal → risk (Python + phase22) → proposal pipeline as a manually-created
signal. A HOLD decision creates no signal or proposal at all. The AI can
neither bypass risk evaluation nor execute a trade directly, and once a
proposal reaches `PENDING_APPROVAL` its AI-suggested quantity/SL/TP are
covered by the same field-immutability trigger as any other proposal.

---

## Phase 25 Intraday Risk Controls (Node-side)

A third advanced-risk-controls layer, `phase25RiskControls` in
`intraday-decision-service.ts`, runs in place of `phase22RiskControls` for
proposals created via `POST /signals/intraday-decision` — same two-layer
(Python + Node) evaluation model, same immutable-at-`PENDING_APPROVAL`
bracket snapshot, but the bracket comes from ATR-derived analysis rather
than a fixed percentage, and this layer adds per-day trade-count caps:

- **PHASE25_INTRADAY_MODE_DISABLED** — master toggle (`phase25_intraday_mode_enabled`).
- **PHASE25_SESSION_STATUS** — must be `OPEN_FOR_ENTRIES` (see below).
- **PHASE25_ESTIMATED_SLIPPAGE** — `phase25_estimated_slippage_pct` must not
  exceed `phase25_max_estimated_slippage_pct` (mirrors Phase 22).
- **PHASE25_MIN_RISK_REWARD** — `(takeProfit − entry) / (entry − stopLoss)` must clear `phase25_min_risk_reward`.
- **PHASE25_MAX_LOSS_PER_TRADE**, **PHASE25_MAX_DAILY_LOSS**, **PHASE25_COOLDOWN**,
  **PHASE25_DUPLICATE_EXPOSURE**, **PHASE25_DUPLICATE_PENDING_ORDER** — same
  shape as the equivalent Phase 22 rules, using `phase25_*`-prefixed settings.
- **PHASE25_MAX_TRADES_PER_SYMBOL_PER_DAY**, **PHASE25_MAX_TRADES_PER_DAY_TOTAL**
  — new: caps intraday-strategy proposals created today (UTC), scoped to the
  intraday strategy only.

Full detail, the multi-timeframe signal layer, session gating, and the
automatic (no-new-approval) exit mechanisms live in
`docs/PHASE_25_INTRADAY_TRADING.md`.

---

## Phase 26 Crypto Risk Controls (Node-side)

A fourth advanced-risk-controls layer, `phase26RiskControls` in
`crypto-decision-service.ts`, runs for proposals created via
`POST /signals/crypto-decision` (BTC/USD, ETH/USD). Same two-layer
(Python + Node) evaluation model as Phase 22/25, but with three
market-specific differences documented here because they are the concrete
answer to "how does the risk engine support market-specific rules":

- **No `TRADING_SESSION` gating.** `riskConfig(db, assetClass)` takes an
  `AssetClass` parameter; when `'CRYPTO'`, it forces
  `trading_session_start`/`trading_session_end` to `undefined` in the
  `RiskEvaluationRequest` sent to the shared Python `risk.engine.evaluate`,
  regardless of the stock session configured in `system_settings` — crypto
  markets trade 24/7. This bypass happens entirely at the Node call site; the
  shared Python risk engine itself is unmodified, so stock session gating is
  unaffected.
- **Fractional position sizing.** Every other sizing path in this codebase
  rounds `quantity` to whole units (`toDecimalPlaces(0, ROUND_DOWN)`) — correct
  for stock shares, wrong for a fraction of a BTC. `phase26RiskControls` rounds
  to 8 decimal places instead. The same distinction exists at the broker layer:
  `OrderRequest.fractionable` (Python, `broker/types.py`) defaults to `false`
  (unchanged stock behavior) and is only set `true` for crypto orders — see
  `docs/PAPER_BROKER.md`.
- **Bidirectional decision, single-sided risk.** `analyze_crypto_multi_timeframe`
  (Python, `strategy/crypto/analysis.py`) can emit BUY, SELL, or HOLD — SELL
  means "close an existing long on a confirmed bearish reversal," never a new
  short (this PAPER broker cannot short — see `_check_funds` in
  `broker/paper_broker.py`). `phase26RiskControls` only computes a risk-budgeted
  bracket for BUY; a SELL is sized to whatever quantity is already held
  (`PHASE26_NO_POSITION_TO_SELL` if none) and carries no bracket
  (`orderClass: 'SINGLE'`).

Failed-rule vocabulary (`phase26_*`-prefixed settings unless noted):

- **PHASE26_CRYPTO_TRADING_DISABLED** — master toggle (`phase26_crypto_trading_enabled`).
- **PHASE26_NO_ENTRY_SIGNAL** — the Python analysis decision no longer matches
  the side requested (re-evaluated fresh on every proposal creation and again
  on approval).
- **PHASE26_ESTIMATED_SLIPPAGE**, **PHASE26_BID_ASK_SPREAD**,
  **PHASE26_INVALID_STOP_DISTANCE**, **PHASE26_MIN_RISK_REWARD** (BUY only),
  **PHASE26_MAX_LOSS_PER_TRADE** (BUY only), **PHASE26_COOLDOWN**,
  **PHASE26_DUPLICATE_EXPOSURE** (BUY only), **PHASE26_DUPLICATE_PENDING_ORDER**,
  **PHASE26_MAX_TRADES_PER_SYMBOL_PER_DAY**, **PHASE26_MAX_TRADES_PER_DAY_TOTAL**
  — same shape as the equivalent Phase 22/25 rules.
- **PHASE26_NO_POSITION_TO_SELL** — SELL requested with no (or zero) held quantity.
- **PHASE26_PLATFORM_MAX_DAILY_LOSS** — the existing platform-wide
  `max_daily_loss_usd` / kill-switch-auto-disable circuit breaker, evaluated
  the same way for crypto as for every other trade.
- **PHASE26_CRYPTO_MAX_DAILY_LOSS** — an *additional*, crypto-specific budget
  (`phase26_max_daily_loss_usd`), layered on top of (never replacing) the
  platform-wide check above. Documented decision: this reuses the
  whole-portfolio `dailyPnl` figure (there is no crypto-only P&L ledger), so it
  is a tighter or looser *threshold* the owner can set for crypto, not an
  independently-measured crypto P&L. Acceptable for PAPER; would need a
  per-asset-class P&L breakdown before any live-trading consideration.

Full detail, the multi-timeframe signal layer, and the 24/7 market model live
in `docs/PHASE_26_CRYPTO_TRADING.md`.

---

## Phase 27 Hourly Risk Controls (Node-side)

A fifth advanced-risk-controls layer, `phase27RiskControls` in
`hourly-decision-service.ts`, runs for proposals created via
`POST /signals/hourly-decision` — either by an owner clicking "Submit for
Approval" on `/hourly`, or by the Phase 27 hourly scheduler itself (see
`docs/PHASE_27_HOURLY_TRADING.md`). Same two-layer (Python + Node)
evaluation model and immutable-at-`PENDING_APPROVAL` bracket snapshot as
Phase 22/25/26, bidirectional like Phase 26 but sized in **whole shares**
like Phase 25 (US stocks, not fractional):

- **PHASE27_HOURLY_MODE_DISABLED** — master toggle (`phase27_hourly_mode_enabled`,
  default **on** — this is the primary strategy family).
- **PHASE27_NO_ENTRY_SIGNAL** — the Python analysis decision no longer
  matches the side requested.
- **PHASE27_SESSION_STATUS** — must be `OPEN_FOR_ENTRIES`.
- **PHASE27_FRESH_MARKET_DATA**, **PHASE27_BID_ASK_SPREAD**,
  **PHASE27_ESTIMATED_SLIPPAGE**, **PHASE27_LIQUIDITY** — re-checked
  server-side against live market data, same defense-in-depth reasoning as
  the equivalent Phase 25/26 rules.
- **PHASE27_INVALID_STOP_DISTANCE**, **PHASE27_MIN_RISK_REWARD** (BUY only).
- **PHASE27_POSITION_SIZE**, **PHASE27_MAX_LOSS_PER_TRADE** (BUY only) —
  quantity sized down from `phase27_default_quantity` by risk-per-trade
  (`phase27_max_loss_per_trade_usd`), available cash,
  `max_position_size_usd`, and `max_portfolio_concentration_pct`, then
  rounded **down to whole shares** (`toDecimalPlaces(0, ROUND_DOWN)`).
- **PHASE27_NO_POSITION_TO_SELL** — SELL requested with no (or zero) held
  quantity; SELL is sized to `min(requested, held)`, never risk-budgeted.
- **PHASE27_MAX_DAILY_LOSS** — same day-boundary `dailyPnl` used everywhere
  else, the platform-wide `max_daily_loss_usd`. Unlike Phase 26, no
  additional hourly-specific daily-loss budget was added.
- **PHASE27_DUPLICATE_EXPOSURE** (BUY only), **PHASE27_DUPLICATE_PENDING_ORDER**.
- **PHASE27_COOLDOWN** — `phase27_cooldown_seconds_per_symbol` (default
  3600s, one candle), independent of the global cooldown setting.
- **PHASE27_MAX_TRADES_PER_SYMBOL_PER_DAY**, **PHASE27_MAX_TRADES_PER_DAY_TOTAL**
  — same shape as the equivalent Phase 25/26 rules, scoped to the hourly
  strategy only.

These, plus the unmodified, shared Python risk engine's 14 rules above,
cover the full required risk list without any change to `risk/engine.py`.

Full detail — the single-timeframe signal layer, the hourly scheduler that
drives most proposals through this pipeline without an owner click, and the
higher-timeframe confirmation veto — live in
`docs/PHASE_27_HOURLY_TRADING.md`.

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
- **Max daily loss auto-reset:** Resolved — resets at midnight UTC, computed from
  the latest `portfolio_snapshots` row before the current UTC day. See
  "Daily P&L and the auto-disable circuit breaker" above.
- **Concentration calculation:** Does it include pending orders in notional?
  Currently yes (conservative) — needs owner confirmation.
- **Crypto daily-loss measurement (Phase 26):** `PHASE26_CRYPTO_MAX_DAILY_LOSS`
  compares against whole-portfolio `dailyPnl`, not a crypto-only figure —
  see "Phase 26 Crypto Risk Controls" above. Owner should decide whether a
  true per-asset-class P&L ledger is worth building before this graduates
  past PAPER.
- **Crypto fee model (Phase 26):** simulated as a flat `phase26_fee_bps`
  (basis points of notional) rather than modeling maker/taker spread or
  per-exchange fee tiers. Reasonable for PAPER-only realism; would need
  revisiting for any live-trading consideration.
