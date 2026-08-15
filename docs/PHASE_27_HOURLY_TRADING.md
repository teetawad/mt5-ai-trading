# Phase 27 — Hourly Intraday Trading

PAPER TRADING ONLY. This phase adds a server-side hourly trading system for
US stocks and makes it the platform's **primary** strategy architecture. No
live trading endpoint, credential, or SDK is introduced. Phase 25's
multi-timeframe intraday mode and Phase 26's crypto mode are untouched and
continue to exist — Phase 25 is deprecated (see "Relationship to Phase 25"
below), Phase 26 is out of scope for this phase entirely.

## Flow

Realtime Market Data → Hourly Scanner (Node scheduler) → Hourly AI/Strategy
(Python, single 1H timeframe) → Risk Engine + Phase 27 Risk Controls (Node)
→ Position Sizing (Node) → Trade Proposal → Owner Approval → PAPER Bracket
Order → automatic Stop Loss / Take Profit / max holding hours / end-of-day
exit.

The hourly strategy never has execution access — it only produces an
`HourlyAnalysis` (Python) that Node turns into a signal + proposal through
the same `createSignalAndProposal` pipeline every other signal source uses.
A `BUY`/`SELL` decision always lands in `PENDING_APPROVAL`; the owner
approves or rejects it exactly like any other proposal. The one structural
difference from every earlier phase: entries are not created only when an
owner clicks a button. A new server-side scheduler (`hourly-scheduler.ts`)
detects a newly closed 1H candle per watchlist symbol and drives this same
pipeline automatically — see "Hourly Scanner" below.

## Single-timeframe analysis (`services/trading-engine/strategy/hourly/`)

Unlike Phase 25/26's 1h/15m/5m composite, entry/exit decisions here come
entirely from **one** closed 1H candle series:

- **Trend** — EMA(`trend_ema_fast`) vs EMA(`trend_ema_slow`) on 1h closes:
  `UP`, `DOWN`, or `FLAT`.
- **Momentum** — rate-of-change over `momentum_window` 1h bars.
- **Volume** — latest-bar volume vs the average of the preceding
  `volume_window` bars; must clear `min_volume_ratio`.
- **Price structure** — `breakout` (latest close beyond the prior
  `breakout_lookback_bars`-bar high/low) and `pullback` (latest close still
  inside that range) are computed and returned as diagnostic fields; they do
  not themselves gate the decision.
- **ATR** (on 1h bars) sizes the stop (`stop_atr_multiple`) and target
  (`take_profit_atr_multiple`) for a `BUY`; the resulting risk/reward must
  clear `min_risk_reward` or the decision is `HOLD`.
- **Higher-timeframe confirmation** — every `higher_tf_bars_per_candle`
  closed 1h bars are folded into one coarser bar (via
  `strategy/intraday/bars.py::resample_closed_bars` — the first *live* use
  of that function; previously it was exercised only by the backtest
  engine). The EMA trend computed on this resampled series may only **veto**
  a signal (when `higher_tf_confirmation_required` is true and it disagrees
  with the 1h trend); it can never trigger one on its own.
- Spread/liquidity filter (`max_spread_pct`) and session gating (see below)
  can also force `HOLD`.
- **Bidirectional, not short-capable** — same shape as Phase 26: `BUY` opens
  a long with a bracket; `SELL` means "close an existing long because the 1h
  trend reversed down," and is only emitted when the caller confirms
  `has_open_position=true`. This PAPER broker cannot short (see
  `_check_funds` in `broker/paper_broker.py`), so a bearish reversal with no
  position held resolves to `HOLD`, never a new short.
- The registry-facing `HourlyTrendStrategy` (used by the generic
  `/signals/generate` batch path) only ever emits `BUY` — it has no
  portfolio/position context, mirroring why `IntradayMultiTimeframeStrategy`
  and `CryptoMultiTimeframeStrategy` are long-only in that path. The
  bidirectional BUY/SELL/HOLD product path is the dedicated
  `/hourly/analyze` endpoint, called directly by Node (which does have
  portfolio context) — see `routers/hourly.py`.
- **Confidence** (`HourlyAnalysis.confidence`, `[0, 1]`) mirrors Phase 26's
  deterministic formula: below all three confirmations (trend, structure,
  higher-timeframe) it is capped at `confirmations / 3 * 0.5`; with all
  three confirmed it scales from `0.5` up to `1.0` with how far the
  ATR-derived risk/reward clears `min_risk_reward`. A `SELL` has no
  risk/reward of its own, so a fully-confirmed `SELL` is capped at `0.75`.
- `HourlyAnalysis` carries a `candle_timestamp` field (the closed bar's own
  timestamp) and `strategy_version` ("27.0.0") — both new fields not present
  on `IntradayAnalysis`, added specifically so the candle a decision was
  based on is traceable end-to-end (dedup claim → analysis → risk snapshot →
  proposal reason string).

**No look-ahead:** every bar list passed to `analyze_hourly` is trimmed to
timestamps ≤ `now` before any indicator is computed, and only the live
snapshot (never historical bars) supplies the current entry price / spread
— identical guarantee to `strategy/intraday/analysis.py` and
`strategy/crypto/analysis.py`.

## Session rules

Configured via `phase27_session_market_open` / `_close` (UTC `HH:MM`),
`phase27_no_new_trades_minutes_before_close` (default 60 — a full candle,
vs Phase 25's 15), `phase27_force_close_before_close_minutes` (default 30,
vs Phase 25's 5), `phase27_force_close_enabled`.

Session-status gating was extracted into a shared module,
`strategy/common/session.py::session_status_for(session, now)`, so Phase 25
and Phase 27 no longer each carry their own copy of the same boundary math.
`strategy/intraday/analysis.py::session_status()` is now a one-line
delegator to it (verified zero-behavior-change against the existing
`test_intraday.py`/`test_intraday_backtest.py` suites). Node's
`hourly-decision-service.ts::computeHourlySessionStatus` is the JS mirror,
same relationship as Phase 25's `computeIntradaySessionStatus` — the two
must stay in lockstep. Returns one of `CLOSED`, `NO_NEW_TRADES_NEAR_CLOSE`,
`FORCE_CLOSE_WINDOW`, `OPEN_FOR_ENTRIES` (only state that allows a `BUY`).

## Hourly Scanner (`apps/api/src/services/hourly-scheduler.ts`)

The server-side component that makes entries possible without a browser
open (CLAUDE.md: "Browser must NOT be required for scanning. API + Trading
Engine must perform the hourly workflow."). No scheduler of any kind existed
anywhere in this codebase before this phase — `planning/DESIGN_DECISIONS.md`
DD-004 had deliberately deferred one. This is new infrastructure, not a
refactor of an existing job runner.

- `tick(pool)` runs once per interval. For each **enabled** watchlist symbol
  (skipped entirely, with `symbolsChecked` staying `0`, if
  `phase27_hourly_mode_enabled` is false): fetches the latest 1H bar via the
  already-existing `getHistoricalBars(symbol, {timeframe:'1Hour', limit:1})`
  (no new Python endpoint needed for detection), confirms the bar's *close*
  time (`timestamp + 1h`) is `<= now` (a defensive no-look-ahead guard, even
  though the provider should never return an in-progress bar), and compares
  it against `findLastProcessedCandle(symbol)`.
- If the candle is new, `tick` attempts `claimCandle(symbol, candleTimestamp)`
  — an `INSERT ... ON CONFLICT (symbol, candle_timestamp) DO NOTHING
  RETURNING id` against `hourly_candle_processing`. Only the caller whose
  INSERT succeeds may proceed; every dedup/restart-safety guarantee lives in
  this one DB constraint, not in any in-memory scheduler state. See
  "Database" below.
- On a successful claim, `tick` calls `createHourlyDecisionAndProposal`
  (the exact same function the manual "Analyze"/"Submit for Approval" UI
  flow calls via `POST /signals/hourly-decision`) and marks the claim row
  `ANALYZED` (with the resulting `signal_id`, if any) or `ERROR`. One
  symbol's failure is caught and recorded without blocking the others or
  crashing the interval — same defensive contract as
  `reconcileBracketOrders`/`reconcileIntradayTimeExits`.
- `startHourlyScheduler(pool)` wraps `tick` in a plain `setInterval` —
  deliberately not a cron library or queue, since the actual "exactly once
  per candle" guarantee is the database constraint, not scheduler timing.
  Gated by `HOURLY_SCHEDULER_ENABLED` (default `true`) and
  `HOURLY_SCHEDULER_TICK_MS` (default `60000` = 60s). See
  `docs/DEVELOPMENT.md`.
- Started only from `apps/api/src/index.ts`, after the existing bracket-
  reconciliation startup block — never from `app.ts`. `app.ts` is what the
  test suite imports (via `supertest`); `index.ts` is only ever executed by
  the real running server process. The scheduler therefore never runs during
  `npm test`.

## Server-side risk controls (Node, `hourly-decision-service.ts`)

`phase27RiskControls` runs at both proposal-creation and
approval-revalidation time, mirroring the existing Phase 22/25/26 pattern.
Sizing rounds to **whole shares** (US stocks), unlike Phase 26's 8dp
fractional rounding:

- `PHASE27_HOURLY_MODE_DISABLED` — master toggle (`phase27_hourly_mode_enabled`).
- `PHASE27_NO_ENTRY_SIGNAL`, `PHASE27_SESSION_STATUS`, `PHASE27_FRESH_MARKET_DATA`,
  `PHASE27_BID_ASK_SPREAD`, `PHASE27_LIQUIDITY` — re-check the same
  conditions server-side using Node's own live market fetch (defense in
  depth against staleness between the Python analysis call and this one).
- `PHASE27_ESTIMATED_SLIPPAGE` — `phase27_estimated_slippage_pct` must not
  exceed `phase27_max_estimated_slippage_pct`.
- `PHASE27_INVALID_STOP_DISTANCE`, `PHASE27_MIN_RISK_REWARD` — BUY only.
- `PHASE27_POSITION_SIZE`, `PHASE27_MAX_LOSS_PER_TRADE` — BUY quantity is
  sized down from `phase27_default_quantity` by risk-per-trade
  (`phase27_max_loss_per_trade_usd`), available cash, `max_position_size_usd`,
  and `max_portfolio_concentration_pct`, then rounded down to whole shares.
- `PHASE27_NO_POSITION_TO_SELL` — SELL requested with no (or zero) quantity
  held; SELL is sized to `min(requested, held)`, never risk-budgeted.
- `PHASE27_MAX_DAILY_LOSS` — same day-boundary `dailyPnl` as Phase 22/25,
  the platform-wide `max_daily_loss_usd`. No additional hourly-specific
  daily-loss budget was added (unlike Phase 26's crypto-specific layer).
- `PHASE27_DUPLICATE_EXPOSURE` (BUY only), `PHASE27_DUPLICATE_PENDING_ORDER`.
- `PHASE27_COOLDOWN` — `phase27_cooldown_seconds_per_symbol` (default 3600,
  one candle), independent of the global `cooldown_between_trades_seconds`.
- `PHASE27_MAX_TRADES_PER_SYMBOL_PER_DAY`, `PHASE27_MAX_TRADES_PER_DAY_TOTAL`
  — counts proposals created today (UTC) for the hourly strategy
  (`countProposalsForStrategyToday`), excluding ones that never passed risk.

These, plus the **unmodified, shared** Python `risk/engine.py` (kill switch,
trading mode, market-data freshness, price drift, max order notional,
available cash/position, max position size, max portfolio concentration,
max open positions, max daily loss, duplicate exposure, trading session,
cooldown — already asset/phase-agnostic and called identically to how Phase
25/26 call it today), together cover every item in the required risk list.
No change was needed to `risk/engine.py` for this phase.

All Phase 27 system settings are listed in
`database/migrations/0025_phase27_hourly_settings.sql`.

## Automatic exits

Three independent exit paths, all server-side, none requiring a fresh owner
approval (the entry approval already covers the position's full exit plan —
see the architecture note in `docs/PAPER_BROKER.md`):

1. **Bracket SL/TP** — same mechanism as Phase 22/23/25, registered on the
   `PaperBrokerAdapter` (or the Alpaca paper OCO) when the entry fills.
   `bracketFromProposal` (`trade-execution-service.ts`) now checks
   `riskSnapshot.phase27` first in its `phase27 ?? phase25 ?? phase26 ??
   phase22` lookup, so hourly BUY proposals route through the completely
   unmodified `executeApprovedProposal`/`reconcileBracketOrders` path — no
   new reconciliation code was needed for bracket TP/SL.
2. **Maximum holding hours** — `reconcileHourlyTimeExits` (called on every
   `GET /dashboard/paper`, same pattern as `reconcileIntradayTimeExits`)
   finds open Phase 27 positions (`findOpenHourlyPositions`, filtered on
   `risk_snapshot ? 'phase27'`) and closes any whose elapsed time since
   entry exceeds `maxHoldingHours` (frozen into the proposal's
   `riskSnapshot` at creation, falling back to the live setting). Hours, not
   minutes, are the unit here (vs Phase 25's `maxHoldingMinutes`).
3. **End-of-day force-close** — same reconciler; closes any open position
   when the session is in `FORCE_CLOSE_WINDOW` or `CLOSED`, if
   `forceCloseEnabled`.

Both (2) and (3) first cancel the pending bracket (both legs) before
submitting the MARKET SELL, exactly like Phase 25's `closeIntradayPosition`
— `closeHourlyPosition` is a near-verbatim copy of it. `orders.exit_reason`
needed no new values — `MAX_HOLDING_TIME` and `END_OF_DAY` already exist
from Phase 25 (see `docs/ORDER_STATE_MACHINE.md`).

## Watchlist (`hourly_watchlist`)

A configurable set of US stock symbols the scheduler evaluates — the
platform does not automatically scan the entire market. Seeded with `AAPL`
only (the sole symbol actually live-registered as a strategy in
`main.py` at the time this phase was built); an owner adds more via the
watchlist admin UI (`apps/web/pages/hourly.vue`) or `POST /hourly/watchlist`.
A disabled entry is skipped by the scheduler entirely — no analysis call is
made for it. See "Database" below for the table schema.

## Database

Two new tables (`database/migrations/0023`–`0024`):

- **`hourly_watchlist`** — `symbol` (unique), `enabled`, audit columns
  (`created_at`, `updated_at`, `updated_by`).
- **`hourly_candle_processing`** — `symbol`, `candle_timestamp`, `status`
  (`CLAIMED` / `ANALYZED` / `ERROR`), `signal_id`, `error_message`,
  `claimed_at`, `completed_at`, with `UNIQUE(symbol, candle_timestamp)`.
  This constraint is the entire "one signal max per symbol per completed 1H
  candle, restart-safe" guarantee — a fresh process asks the same question
  on its first tick ("is there a newer bar than what's claimed?") as it does
  on every subsequent one, so a restart cannot cause double-processing.
  Trade-off, accepted by design: a crash between `CLAIMED` and
  `ANALYZED`/`ERROR` permanently forfeits that one candle for that symbol —
  fail-safe over fail-duplicate.

See `docs/DATABASE.md` for full column listings.

## Endpoints

```
POST /hourly/analyze              (trading-engine, internal) — stateless single-timeframe analysis
GET  /hourly/watchlist            (Node, auth) — list watchlist symbols
POST /hourly/watchlist            (Node, owner) — add a symbol, enabled by default
PATCH /hourly/watchlist/:id       (Node, owner) — enable/disable a symbol
GET  /hourly/analysis/:symbol     (Node, auth) — analysis + sizing preview, no proposal created
POST /signals/hourly-decision     (Node, owner) — runs analysis; BUY/SELL creates a PENDING_APPROVAL proposal
GET  /settings/hourly-mode        (Node, auth) — current master-toggle state
PUT  /settings/hourly-mode        (Node, owner) — enable/disable, audit logged
```

## UI (`apps/web/pages/hourly.vue`)

Now the primary nav-linked page (`apps/web/layouts/default.vue`, positioned
right after Dashboard). Master toggle, watchlist admin (list, add, enable/
disable), a symbol analysis panel (candlestick chart with entry/SL/TP marker
lines via the new `CandlestickChart.vue` component, trend/momentum/volume/
structure/higher-timeframe/ATR/liquidity/entry/SL/TP/expected holding hours/
risk-reward, session status, position-open indicator), a "Submit for
Approval" action, and a read-only table of the current `phase27_*` settings
— consistent with how Phase 22/25/26 settings are displayed. The Dashboard
(`apps/web/pages/index.vue`) gained a summary card: session status, mode
enabled, next candle analysis time, watchlist chips with last-processed-
candle timestamps, daily loss used, and recent hourly signals.

## Relationship to Phase 25

Phase 27 is the platform's primary architecture; Phase 25 is deprecated but
not deleted:

- `phase27_hourly_mode_enabled` defaults **`true`**; `phase25_intraday_mode_
  enabled` already defaulted `false`. Only one strategy family is reachable
  through normal operation by default.
- `/intraday` was removed from the main navigation but remains fully
  functional at its direct URL, relabeled "Intraday Mode (Phase 25 —
  deprecated)" with a note pointing to `/hourly`, for debugging only.
- No Phase 25 backend code, settings, or its existing test suite
  (`test_intraday.py`, `test_intraday_backtest.py`,
  `__tests__/intraday.test.ts`) were modified, beyond the shared
  `session_status_for` extraction (verified behavior-identical).
- Phase 26 crypto trading is entirely out of scope for this phase and was
  not touched.

## Testing

- Python (`services/trading-engine/tests/test_hourly.py`): config
  validation, `resample_closed_bars` edge cases (too few bars to fill one
  higher-timeframe bucket — the first live use of that function outside the
  backtest engine), BUY/SELL/HOLD branches, no-look-ahead, session gating,
  wide spread, min risk/reward rejection, the higher-timeframe confirmation
  toggle, confidence scaling, the registry strategy wrapper (BUY-only), and
  the `/hourly/analyze` endpoint (200/404/403). `test_strategy.py`'s
  `TestArchitecturalBoundary` was broadened from `STRATEGY_DIR.glob("*.py")`
  (top-level only) to `STRATEGY_DIR.rglob("*.py")` so the same
  strategy-may-not-import-broker/routers check now covers the
  `strategy/hourly/` and `strategy/common/` subpackages too, instead of a
  fourth hand-rolled copy of the check.
- Node (`apps/api/src/__tests__/hourly.test.ts`): mode-disabled rejection,
  unsupported symbol, HOLD creates no proposal, risk rejection overrides a
  BUY decision (session-status gate), BUY creates a whole-share ATR-bracket
  `PENDING_APPROVAL` proposal, owner approval submits the bracket order and
  a duplicate approval (same `requestId`) is idempotent, SELL with an
  existing position closes it without a bracket, SELL without a position is
  rejected before any order is built, estimated-slippage rejection,
  per-symbol daily-trade-limit rejection, an approved-and-filled trade puts
  the symbol into cooldown for the next candle, `GET /hourly/analysis/:symbol`
  sizing preview, and watchlist CRUD (including non-owner 403).
- Node (`apps/api/src/__tests__/hourly-scheduler.test.ts`): `tick()` claims
  a newly closed candle and creates exactly one proposal; a second `tick()`
  call against the same latest candle claims nothing new (this **is** the
  restart-safety test — `tick()` carries no in-memory state between calls,
  so calling it twice simulates a process restart); a still-forming candle
  (bar close time in the future) is never claimed; a disabled watchlist
  symbol is skipped entirely; the whole tick is a no-op when
  `phase27_hourly_mode_enabled` is false.

## Unresolved decisions

- **Automatic exits do not require a new owner approval.** Same precedent
  as Phase 25 — the entry approval's frozen risk snapshot already covers
  the exit plan.
- **Session config is UTC-only**, same limitation as Phase 25 — does not
  account for US Eastern Time DST transitions; the owner must update
  `phase27_session_market_open/close` twice a year.
- **No NYSE holiday calendar awareness.** On a market holiday the scheduler
  simply never sees a new closed bar from Alpaca and fails safe (no
  trades), but the Dashboard's "next hourly analysis time" display will be
  cosmetically wrong on holidays.
- **Watchlist size is unbounded.** The admin UI lets an owner add symbols
  with no platform-enforced ceiling; each additional symbol scales the
  scheduler's per-tick Alpaca calls linearly. Acceptable at the current
  single-symbol default; worth a soft cap before large-scale use.
- **Single-instance scheduler assumption.** The `UNIQUE(symbol,
  candle_timestamp)` constraint still guarantees exactly-once processing if
  more than one Node API process ever ran the scheduler concurrently, but
  the losing instance's detection call to Alpaca would be wasted — an
  efficiency concern only, not a correctness one. Today's deployment is
  single-instance.
