# Phase 26 — Crypto PAPER Trading

PAPER TRADING ONLY. This phase adds crypto PAPER trading (BTC/USD, ETH/USD)
alongside the existing US Stocks pipeline. No live trading endpoint,
credential, or SDK is introduced, and US Stock logic is unchanged — every
market-specific behavior is additive and gated on `assetClass`/`fractionable`
flags that default to the pre-existing STOCK behavior.

## Flow

Realtime Market Data (24/7) → Crypto AI/Strategy (Python) → Risk Engine +
Phase 26 Risk Controls (Node) → Fractional Position Sizing (Node) → Trade
Proposal → Owner Approval → PAPER Bracket Order (BUY) or Single Order (SELL)
→ automatic Stop Loss / Take Profit exit.

The crypto strategy never has execution access — it only produces a
`CryptoAnalysis` (Python) that Node turns into a signal + proposal through
the same `createSignalAndProposal` pipeline every other signal source uses.
A `BUY` or `SELL` decision always lands in `PENDING_APPROVAL`; the owner
approves or rejects it exactly like any other proposal.

## Multi-timeframe analysis (`services/trading-engine/strategy/crypto/`)

- **1h** → trend direction, via EMA(`trend_ema_fast`) vs EMA(`trend_ema_slow`)
  — `UP`, `DOWN`, or `FLAT`.
- **15m** → setup confirmation: momentum + volume must agree with the 1h
  trend direction (either direction, not up-only).
- **5m** → entry timing: momentum + volume trigger, same direction.
- **ATR** (on 5m bars) sizes the stop (`stop_atr_multiple`) and target
  (`take_profit_atr_multiple`) for a `BUY`; the resulting risk/reward must
  clear `min_risk_reward` or the decision is `HOLD`.
- Spread/liquidity filter (`max_spread_pct`) can also force `HOLD`.
- **No session gating** — `market_status` is always `"OPEN_24_7"` (kept as an
  explicit field for UI parity with intraday's session badge, not because
  crypto has a session concept). This is the concrete answer to "24/7 market
  handling": the shared Python risk engine's `TRADING_SESSION` rule is
  bypassed at the Node call site (`riskConfig(db, 'CRYPTO')`) rather than
  ever being evaluated for crypto proposals.
- **Bidirectional, not short-capable:** `BUY` opens/adds to a long with a
  bracket. `SELL` means "close an existing long because the 1h trend
  reversed down" — it is only emitted when the caller confirms
  `has_open_position=true`. This PAPER broker cannot short (see
  `_check_funds` in `broker/paper_broker.py`), so a bearish reversal with no
  position held resolves to `HOLD`, never a new short.
- The registry-facing `CryptoMultiTimeframeStrategy` (used by the generic
  `/signals/generate` batch path) only ever emits `BUY` — it has no
  portfolio/position context, mirroring why `IntradayMultiTimeframeStrategy`
  is long-only. The bidirectional BUY/SELL/HOLD product path is the
  dedicated `/crypto/analyze` endpoint, called directly by Node (which does
  have portfolio context) — see `routers/crypto.py`.
- **Confidence** (`CryptoAnalysis.confidence`, `[0, 1]`) mirrors intraday's
  deterministic formula for `BUY`: below all three timeframe confirmations
  it is capped at `confirmations / 3 * 0.5`; with all three confirmed it
  scales from `0.5` up to `1.0` with how far the ATR-derived risk/reward
  clears `min_risk_reward`. A `SELL` has no risk/reward of its own, so a
  fully-confirmed `SELL` is capped at `0.75` — a lower-stakes "close what you
  have" action, not a new risk-budgeted entry.

**No look-ahead:** every bar list passed to `analyze_crypto_multi_timeframe`
is trimmed to timestamps ≤ `now` before any indicator is computed, and only
the live snapshot (never historical bars) supplies the current entry price /
spread — identical guarantee to `strategy/intraday/analysis.py`.

## Fractional quantities and percentage fees

Every other risk-controls/sizing path in this codebase rounds `quantity` to
whole units — correct for stock shares, wrong for a fraction of a BTC.

- `phase26RiskControls` (Node, `crypto-decision-service.ts`) rounds sized
  quantity to **8 decimal places** instead of 0.
- `OrderRequest.fractionable` (Python, `broker/types.py`) defaults to
  `false`; Node sets it `true` only for crypto orders. When `true`,
  `PaperBrokerAdapter._resolve_quantity`'s partial-fill rounding uses 8dp
  instead of the nearest whole unit — whole-unit rounding would zero out a
  partial fill on a sub-1 BTC/ETH order.
- `OrderRequest.fee_bps` (percentage-of-notional, e.g. `phase26_fee_bps` =
  10 → 0.10%) replaces the flat per-share fee + $1.00 minimum for crypto
  orders — a flat minimum is disproportionate on a fraction of a BTC. Carried
  through bracket exit legs via `_BracketLegs.fee_bps`, set from the entry
  order at registration time.

See "Phase 26: fractional quantities and percentage fees" in
`docs/PAPER_BROKER.md` for the exact broker-layer mechanics.

## Server-side risk controls (Node, `crypto-decision-service.ts`)

`phase26RiskControls` runs at both proposal-creation and
approval-revalidation time, mirroring the existing Phase 22/25 pattern:

- `PHASE26_CRYPTO_TRADING_DISABLED` — master toggle (`phase26_crypto_trading_enabled`).
- `PHASE26_NO_ENTRY_SIGNAL`, `PHASE26_FRESH_MARKET_DATA`, `PHASE26_BID_ASK_SPREAD`,
  `PHASE26_LIQUIDITY` — re-check the same conditions server-side using
  Node's own live market fetch (defense in depth against staleness between
  the Python analysis call and this one).
- `PHASE26_ESTIMATED_SLIPPAGE` — `phase26_estimated_slippage_pct` must not
  exceed `phase26_max_estimated_slippage_pct`.
- `PHASE26_INVALID_STOP_DISTANCE`, `PHASE26_MIN_RISK_REWARD` — BUY only.
- `PHASE26_POSITION_SIZE`, `PHASE26_MAX_LOSS_PER_TRADE` — BUY quantity is
  sized down from `phase26_default_quantity` by risk-per-trade
  (`phase26_max_loss_per_trade_usd`), available cash, `max_position_size_usd`,
  and `max_portfolio_concentration_pct`, then rounded to 8dp.
- `PHASE26_NO_POSITION_TO_SELL` — SELL requested with no (or zero) quantity
  held; SELL is sized to `min(requested, held)`, never risk-budgeted.
- `PHASE26_PLATFORM_MAX_DAILY_LOSS` — the existing platform-wide
  `max_daily_loss_usd` / kill-switch-auto-disable circuit breaker.
- `PHASE26_CRYPTO_MAX_DAILY_LOSS` — an *additional* crypto-specific budget
  (`phase26_max_daily_loss_usd`), layered on top of the platform-wide check.
- `PHASE26_DUPLICATE_EXPOSURE` (BUY only), `PHASE26_DUPLICATE_PENDING_ORDER`.
- `PHASE26_COOLDOWN` — `phase26_cooldown_seconds_per_symbol`, independent of
  the global `cooldown_between_trades_seconds`.
- `PHASE26_MAX_TRADES_PER_SYMBOL_PER_DAY`, `PHASE26_MAX_TRADES_PER_DAY_TOTAL`
  — counts proposals created today (UTC) for the crypto strategy
  (`countProposalsForStrategyToday`), excluding ones that never passed risk.

All Phase 26 system settings are listed in
`database/migrations/0022_phase26_crypto_trading.sql`.

## Automatic exits

Only one exit path — no max-holding-time or end-of-day force-close exists
for crypto (there is no "end of day"):

1. **Bracket SL/TP** — same mechanism as Phase 22/23/25, registered on the
   `PaperBrokerAdapter` when a BUY entry fills, reconciled by the existing
   `reconcileBracketOrders` unmodified.

A `SELL` decision is a manual/AI-triggered close, not an automatic exit — it
still requires owner approval like any other proposal, exactly as a bracket
entry does. This is a narrower automatic-exit surface than Phase 25's, by
design: crypto's 24/7 nature removes the "end of day" concept, and no
maximum-holding-time requirement was specified for this phase.

## `asset_class` throughout the stack

Denormalized onto `signals`, `trade_proposals`, `orders`, `positions`
(`database/migrations/0022_phase26_crypto_trading.sql`), matching this
schema's existing convention of denormalizing `symbol` onto every
trade-lifecycle table. Defaults to `'STOCK'`, so every pre-Phase-26 row and
code path is unaffected. Derived server-side from the symbol
(`assetClassForSymbol` in `apps/api/src/services/asset-class.ts`) — never
accepted as client input, so a caller cannot spoof a stock proposal as
`CRYPTO` (or vice versa) to bypass market-specific risk rules.

Surfaced in the UI as a badge next to the symbol on the Positions, Orders,
Proposals, and Dashboard tables, plus the dedicated `/crypto` page.

## Endpoints

```
POST /crypto/analyze              (trading-engine, internal) — stateless multi-timeframe analysis
GET  /crypto/symbols              (Node, auth) — configured crypto symbols + master-toggle state
GET  /crypto/analysis/:symbol     (Node, auth) — analysis + sizing preview, no proposal created
POST /signals/crypto-decision     (Node, owner) — runs analysis; BUY/SELL creates a PENDING_APPROVAL proposal
GET  /settings/crypto-trading-mode (Node, auth) — current master-toggle state
PUT  /settings/crypto-trading-mode (Node, owner) — enable/disable, audit logged
```

## UI (`apps/web/pages/crypto.vue`)

Master toggle, a symbol analysis panel (timeframe/trend/momentum/ATR/volume
signal/entry/SL/TP/risk-reward/position size preview/open-position
indicator), a market-status badge (always "OPEN 24/7"), a "Submit for
Approval" action enabled for both BUY and SELL decisions, and a read-only
table of the current `phase26_*` settings — consistent with how Phase 22/25
settings are displayed (`apps/web/pages/settings.vue`).

## Testing

- Python (`services/trading-engine/tests/test_crypto.py`): multi-timeframe
  analysis (BUY/SELL/HOLD, no-look-ahead, spread/liquidity, min risk/reward),
  the registry strategy wrapper (BUY-only, never emits SELL), and the
  `/crypto/analyze` endpoint (including `has_open_position` gating SELL).
  Extended `test_broker.py` (fractional partial fills, `fee_bps`, bracket
  exit fee propagation) and `test_market_data.py` (BTC/USD, ETH/USD default
  tracking).
- Node (`apps/api/src/__tests__/crypto.test.ts`): the full
  signal → risk → proposal → approval → execution flow for BUY and SELL,
  master-toggle gating, slippage/trade-count rejection, and asset-class
  isolation from the stock pipeline — mirrors `intraday.test.ts`'s structure
  and DB-backed (`TEST_DATABASE_URL`) skip pattern.

## Unresolved decisions

- **Crypto daily-loss measurement.** `PHASE26_CRYPTO_MAX_DAILY_LOSS` compares
  against whole-portfolio `dailyPnl`, not a crypto-only figure — there is no
  per-asset-class P&L ledger. Acceptable for PAPER; would need revisiting
  before any live-trading consideration. See `docs/RISK_ENGINE.md`.
- **Crypto fee model.** Simulated as a flat `phase26_fee_bps` rather than
  modeling maker/taker spread or per-exchange fee tiers.
- **Live crypto market data is out of scope for this phase.** The synthetic
  provider tracks BTC/USD and ETH/USD by default (24/7, matching real crypto
  markets structurally); `market_data/alpaca.py`'s `DEFAULT_SYMBOLS` was
  intentionally left stock-only — Alpaca crypto data uses a different feed/
  auth surface than Alpaca's US-equities market data. Wiring a real crypto
  market-data provider is a natural follow-up phase, analogous to how Phase
  14 (Alpaca stocks) followed the initial synthetic-only MVP.
- **SELL semantics.** A `SELL` decision closes an existing long on a
  confirmed bearish reversal; it is never a new short position. This
  followed directly from the PAPER broker's existing inability to short
  (`_check_funds` rejects a SELL exceeding the tracked position) rather than
  introducing short-selling support in this phase.
