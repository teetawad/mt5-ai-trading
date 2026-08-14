# Phase 25 — Intraday Trading Mode

PAPER TRADING ONLY. This phase adds a short-term intraday trading mode for
US stocks on top of the existing paper-trading pipeline. No live trading
endpoint, credential, or SDK is introduced.

## Flow

Realtime Market Data → Intraday AI/Strategy (Python) → Risk Engine + Phase 25
Risk Controls (Node) → Position Sizing (Node) → Trade Proposal → Owner
Approval → PAPER Bracket Order → automatic Stop Loss / Take Profit / max
holding time / end-of-day exit.

The intraday strategy never has execution access — it only produces an
`IntradayAnalysis` (Python) that Node turns into a signal + proposal through
the same `createSignalAndProposal` pipeline every other signal source uses.
A `BUY` decision always lands in `PENDING_APPROVAL`; the owner approves or
rejects it exactly like any other proposal.

## Multi-timeframe analysis (`services/trading-engine/strategy/intraday/`)

- **1h** → trend direction, via EMA(`trend_ema_fast`) vs EMA(`trend_ema_slow`).
- **15m** → setup confirmation: momentum + volume must agree with the 1h trend.
- **5m** → entry timing: momentum + volume trigger.
- **ATR** (on 5m bars) sizes the stop (`stop_atr_multiple`) and target
  (`take_profit_atr_multiple`); the resulting risk/reward must clear
  `min_risk_reward` or the decision is `HOLD`.
- Spread/liquidity filter (`max_spread_pct`) and session gating (see below)
  can also force `HOLD`.
- Long-only: the strategy only ever emits `BUY` entries. Exits are handled
  automatically downstream (bracket SL/TP, max holding time, end-of-day
  force-close) rather than a second strategy-emitted `SELL` signal — see
  "Automatic exits" in `docs/PAPER_BROKER.md`.

**No look-ahead:** every bar list passed to `analyze_multi_timeframe` is
trimmed to timestamps ≤ `now` before any indicator is computed, and only the
live snapshot (never historical bars) supplies the current entry price /
spread. The backtest engine (`backtesting/intraday.py`) enforces the same
property structurally: 15m/1h bars are derived from the 5m stream via
`BarResampler`, which only emits a coarser bar once it is fully covered by
finer bars already processed, and every entry decision executes at the
*next* bar's open — never the bar that produced the signal.

## Session rules

Configured via `phase25_session_market_open` / `_close` (UTC `HH:MM`),
`phase25_no_new_trades_minutes_before_close`,
`phase25_force_close_before_close_minutes`, `phase25_force_close_enabled`.

`session_status()` (mirrored in both Python
`strategy/intraday/analysis.py` and Node
`intraday-decision-service.ts::computeIntradaySessionStatus` — the two must
stay in lockstep) returns one of:

- `CLOSED` — outside the regular session; no entries, existing positions are
  swept by the `FORCE_CLOSE_WINDOW` path on the next reconciliation pass.
- `NO_NEW_TRADES_NEAR_CLOSE` — inside the pre-close buffer; no new entries,
  existing positions untouched.
- `FORCE_CLOSE_WINDOW` — inside the force-close buffer; no new entries, and
  open intraday positions are automatically closed (see below).
- `OPEN_FOR_ENTRIES` — the only state that allows a `BUY` decision.

## Server-side risk controls (Node, `intraday-decision-service.ts`)

`phase25RiskControls` runs at both proposal-creation and approval-revalidation
time, mirroring the existing Phase 22 pattern (`phase22RiskControls`) but
keyed off the ATR-derived analysis instead of a fixed percentage, plus new
per-day trade-count limits:

- `PHASE25_INTRADAY_MODE_DISABLED` — master toggle (`phase25_intraday_mode_enabled`).
- `PHASE25_NO_ENTRY_SIGNAL`, `PHASE25_SESSION_STATUS`, `PHASE25_FRESH_MARKET_DATA`,
  `PHASE25_BID_ASK_SPREAD`, `PHASE25_LIQUIDITY` — re-check the same
  conditions server-side using Node's own live market fetch (defense in
  depth against staleness between the Python analysis call and this one).
- `PHASE25_INVALID_STOP_DISTANCE`, `PHASE25_MIN_RISK_REWARD`.
- `PHASE25_POSITION_SIZE`, `PHASE25_MAX_LOSS_PER_TRADE` — quantity is sized
  down from `phase25_default_quantity` by risk-per-trade
  (`phase25_max_loss_per_trade_usd`), available cash, `max_position_size_usd`,
  and `max_portfolio_concentration_pct`, exactly like Phase 22.
  `phase25_default_quantity` is the *requested* ceiling before sizing, not a
  guaranteed fill quantity.
- `PHASE25_MAX_DAILY_LOSS` — same day-boundary `dailyPnl` as Phase 22.
- `PHASE25_DUPLICATE_EXPOSURE`, `PHASE25_DUPLICATE_PENDING_ORDER`.
- `PHASE25_COOLDOWN` — `phase25_cooldown_seconds_per_symbol`, independent of
  the global `cooldown_between_trades_seconds`.
- `PHASE25_MAX_TRADES_PER_SYMBOL_PER_DAY`, `PHASE25_MAX_TRADES_PER_DAY_TOTAL`
  — counts proposals created today (UTC) for the intraday strategy
  (`countProposalsForStrategyToday`), excluding ones that never passed risk
  (`RISK_REJECTED`) so an earlier rejection doesn't consume a trade slot.

All Phase 25 system settings are listed in
`database/migrations/0020_phase25_intraday_settings.sql`.

## Automatic exits

Three independent exit paths, all server-side, none requiring a fresh owner
approval (the entry approval already covers the position's full exit plan —
see the architecture note in `docs/PAPER_BROKER.md`):

1. **Bracket SL/TP** — same mechanism as Phase 22/23, registered on the
   `PaperBrokerAdapter` (or the Alpaca paper OCO) when the entry fills.
2. **Maximum holding time** — `reconcileIntradayTimeExits` (called on every
   `GET /dashboard/paper`, same pattern as `reconcileBracketOrders`) finds
   open Phase 25 positions and closes any whose elapsed time since entry
   exceeds `maxHoldingMinutes` (frozen into the proposal's `riskSnapshot` at
   creation, falling back to the live setting).
3. **End-of-day force-close** — same reconciler; closes any open position
   when the session is in `FORCE_CLOSE_WINDOW` or `CLOSED`, if
   `forceCloseEnabled`.

Both (2) and (3) first cancel the pending bracket (both legs) before
submitting the MARKET SELL — see the `cancel_order`/bracket-cancellation fix
in `docs/PAPER_BROKER.md`, which this depends on for correctness.

`orders.exit_reason` gained two new values for this: `MAX_HOLDING_TIME`,
`END_OF_DAY` (see `docs/ORDER_STATE_MACHINE.md`).

## Endpoints

```
POST /intraday/analyze            (trading-engine, internal) — stateless multi-timeframe analysis
GET  /intraday/analysis/:symbol   (Node, owner) — analysis + sizing preview, no proposal created
POST /intraday/reconcile-time-exits (Node, owner) — manual trigger for the time/EOD exit sweep
POST /signals/intraday-decision   (Node, owner) — runs analysis; BUY creates a PENDING_APPROVAL proposal
GET  /settings/intraday-mode      (Node, auth) — current master-toggle state
PUT  /settings/intraday-mode      (Node, owner) — enable/disable, audit logged
```

## Backtesting (`services/trading-engine/backtesting/intraday.py`)

`run_intraday_backtest(bars_5m, config, backtest_config, entry_timeframe_minutes=5|15|60)`
walks a single 5-minute series (resampling internally into coarser bars for
the two non-canonical `entry_timeframe_minutes` values) with ATR-based
intrabar SL/TP checks, max-holding-time and end-of-day forced exits, and
reuses `backtesting.engine.calculate_metrics` for the same metric
definitions as every other strategy. `compare_intraday_timeframes` runs all
three granularities over the same historical data and returns them keyed by
`"5m"` / `"15m"` / `"1h"` for side-by-side comparison — this is the "compare
5m/15m/1h configurations" requirement. Annualization uses a
session-bars-per-day figure derived from `entry_timeframe_minutes`, not the
day-based `252` used by the daily-bar strategies.

## UI (`apps/web/pages/intraday.vue`)

Master toggle, a symbol analysis panel (timeframe/trend/momentum/ATR/volume
signal/entry/SL/TP/expected holding period/risk-reward/position size
preview/session status), a "Submit for Approval" action, and a read-only
table of the current `phase25_*` settings (consistent with how Phase 22
settings are displayed — see `apps/web/pages/settings.vue`).

## Unresolved decisions

- **Automatic exits do not require a new owner approval.** This follows the
  existing bracket-SL/TP precedent (Phase 22/23) rather than introducing a
  new approval-required exit path. Documented here as a deliberate,
  owner-reviewable architecture decision per CLAUDE.md's guidance to record
  the safer choice and flag it rather than leave it implicit.
- **Session config is UTC-only**, matching the existing
  `trading_session_start/end` convention — it does not account for US
  Eastern Time DST transitions. The owner is responsible for updating
  `phase25_session_market_open/close` twice a year (13:30–20:00 UTC for
  EDT, 14:30–21:00 UTC for EST) until DST-aware scheduling is built.
- **Trade-count limits scope to the intraday strategy only** (via
  `strategy_id`), not to manual/AI-assisted signals on the same symbol —
  consistent with these being intraday-mode-specific safety limits, not a
  platform-wide trade cap.
