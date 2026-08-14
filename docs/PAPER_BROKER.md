# PAPER_BROKER.md

## Overview

The Paper Broker simulates order execution without connecting to any real brokerage.
It is the **only** broker implementation in this codebase.

A `LiveBrokerAdapter` is **explicitly forbidden** until a separate architecture review and owner sign-off.

---

## Interface: BrokerAdapter

All broker interaction goes through the `BrokerAdapter` abstract interface.
This ensures the execution layer is broker-agnostic and a future live broker
can be added without touching execution logic.

```python
from abc import ABC, abstractmethod
from dataclasses import dataclass
from decimal import Decimal
from typing import Optional
from enum import Enum

class OrderSide(Enum):
    BUY = "BUY"
    SELL = "SELL"

class OrderType(Enum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"

class OrderStatus(Enum):
    PENDING = "PENDING"
    SUBMITTED = "SUBMITTED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    ERROR = "ERROR"

@dataclass
class OrderRequest:
    idempotency_key: str
    symbol: str
    side: OrderSide
    quantity: Decimal
    order_type: OrderType
    limit_price: Optional[Decimal] = None

@dataclass
class FillEvent:
    order_id: str
    fill_id: str
    quantity: Decimal
    price: Decimal
    fee: Decimal
    is_partial: bool
    filled_at: str  # ISO 8601 UTC

@dataclass
class OrderResult:
    broker_order_id: str
    status: OrderStatus
    fills: list[FillEvent]
    rejected_reason: Optional[str] = None
    error_message: Optional[str] = None

class BrokerAdapter(ABC):
    @abstractmethod
    def submit_order(self, request: OrderRequest) -> OrderResult:
        """Submit an order. Must be idempotent: same idempotency_key → same result."""
        ...

    @abstractmethod
    def get_order(self, broker_order_id: str) -> OrderResult:
        """Fetch current status of an order."""
        ...

    @abstractmethod
    def cancel_order(self, broker_order_id: str) -> OrderResult:
        """Request cancellation of an open order."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Health check — returns True if broker is operational."""
        ...
```

---

## PaperBrokerAdapter

The paper broker simulates realistic order processing deterministically.

### Configuration

```python
@dataclass
class PaperBrokerConfig:
    # Fee model
    fee_per_share: Decimal = Decimal("0.005")   # CONFIGURE: $0.005/share placeholder
    min_fee: Decimal = Decimal("1.00")           # CONFIGURE: $1.00 minimum fee placeholder

    # Slippage (applied to market orders only)
    slippage_bps: int = 5                        # CONFIGURE: 5 basis points placeholder

    # Partial fill simulation
    enable_partial_fills: bool = True
    partial_fill_probability: float = 0.1        # 10% chance of partial fill

    # Rejection simulation
    enable_rejections: bool = True
    rejection_probability: float = 0.01          # 1% random rejection rate

    # Determinism (for testing)
    random_seed: Optional[int] = None            # Set to fixed value in tests
```

All probability-based behavior is disabled when `random_seed` is set (for deterministic tests).
In test mode, partial fills and rejections are triggered by explicit test fixtures, not randomness.

### Phase 26: fractional quantities and percentage fees (crypto)

Two fields on `OrderRequest` (`broker/types.py`), both defaulting to values
that leave existing US stock behavior completely unchanged:

- **`fractionable: bool = False`.** When `True` (set by the Node API for
  every crypto order), partial-fill rounding in `_resolve_quantity` uses 8
  decimal places instead of the nearest whole unit — whole-unit rounding
  would zero out a partial fill on a sub-1 BTC/ETH order. Stock orders never
  set this, so `floor(quantity/2)`-style whole-share rounding is unchanged.
- **`fee_bps: int | None = None`.** When set, the fee for a fill is
  `quantity × price × fee_bps / 10000` instead of
  `max(quantity × fee_per_share, min_fee)` — a flat `$1.00` minimum fee is
  disproportionate on a fraction of a BTC. Carried through bracket exit legs
  too (`_BracketLegs.fee_bps`, set from the entry order's `fee_bps` at
  registration time), so a crypto bracket's SL/TP exit uses the same
  percentage fee model as its entry.

Both fields are populated by the Node crypto risk-controls layer — see
"Phase 26 Crypto Risk Controls" in `docs/RISK_ENGINE.md` and
`docs/PHASE_26_CRYPTO_TRADING.md`.

### Simulation Logic

**Market Order:**
1. Determine fill price: `reference_price × (1 + slippage_bps/10000)` for BUY,
   `reference_price × (1 - slippage_bps/10000)` for SELL.
2. Calculate fee: `max(quantity × fee_per_share, min_fee)`.
3. Check simulated cash (BUY): `cash >= quantity × fill_price + fee`. Reject if insufficient.
4. Check simulated position (SELL): `position >= quantity`. Reject if insufficient.
5. If partial fill mode and randomly triggered: fill `floor(quantity/2)`, mark as `PARTIALLY_FILLED`.
6. Otherwise: full fill, mark as `FILLED`.

**Limit Order:**
1. Immediately filled only if `limit_price >= current_price` (BUY) or `limit_price <= current_price` (SELL).
2. Otherwise placed in pending queue and filled when price crosses.
3. In current paper trading phase, limit orders are either immediately filled or queued.
4. Queued orders require a price update tick to trigger fill evaluation.

**Idempotency:**
- `submit_order` checks its internal order store by `idempotency_key`.
- If an order with the same key already exists, return the existing `OrderResult`.
- This prevents duplicate fills on retry.

### Paper Cash and Positions

The paper broker maintains:
- `paper_cash`: Starting balance from `system_settings.initial_paper_cash`.
- `paper_positions`: `Dict[symbol, Decimal]` — current holdings.

These are reconciled against the PostgreSQL `positions` table after every fill.
PostgreSQL is the source of truth; the paper broker's in-memory state is derived.

---

## Simulated Error Scenarios

For testing, the paper broker supports explicit error injection:

```python
# In test setup
broker = PaperBrokerAdapter(config=PaperBrokerConfig(random_seed=42))
broker.inject_error("NEXT_ORDER", BrokerError.INSUFFICIENT_FUNDS)
broker.inject_partial_fill("NEXT_ORDER", fill_fraction=Decimal("0.5"))
broker.inject_rejection("NEXT_ORDER", reason="Symbol not tradeable")
broker.inject_unavailable(duration_seconds=5)
```

These injection methods are only available in test/simulation mode,
controlled by a `simulation_mode: bool` flag on the adapter.

---

## Bracket Orders (Stop-Loss / Take-Profit)

Added in phase 22/23 alongside the AI-assisted decision layer. A bracket order is
a BUY entry paired with a stop-loss and a take-profit exit price, computed
server-side by `phase22RiskControls` (Node) from `phase22_stop_loss_pct` /
`phase22_take_profit_pct`. Only BUY entries carry a bracket — the broker layer
never registers one for a SELL.

The broker-layer mechanism below is entirely generic — `phase25RiskControls`
(ATR-derived bracket, stocks) and `phase26RiskControls` (ATR-derived bracket,
crypto) both reuse it unmodified via the same `request.bracket` field. A
crypto SELL (closing an existing long) is not a bracket order — see
`docs/RISK_ENGINE.md` — and cancels no pending bracket of its own.

**local_paper (`PaperBrokerAdapter`, default `BROKER_PROVIDER`):**
- On a filled BUY entry with `request.bracket` set, the adapter fills the entry
  immediately (as any market order) and registers two virtual pending exit
  legs — `take_profit` and `stop_loss` — each with its own synthetic
  `broker_order_id`, returned to the caller as `bracket_order_ids: {parent,
  take_profit, stop_loss}`.
- The legs are evaluated **lazily** — the same pattern used for queued limit
  orders (`_lazy_fill_limit`) — inside `get_order`, `get_open_orders`, and
  `check_pending_orders`. There is no background scheduler in this service;
  a leg only resolves when something polls for order state.
- When the current price crosses the take-profit level (or drops to/below the
  stop-loss level), that leg fills at the trigger price (with the configured
  slippage/fee) and the opposite leg is marked `CANCELLED` — a local OCO
  (one-cancels-other) simulation.

**alpaca_paper (`AlpacaPaperBrokerAdapter`):**
- Submits a native Alpaca `order_class: "bracket"` order. Alpaca hosts the
  OCO relationship **server-side** — the stop-loss and take-profit legs live
  and resolve on Alpaca's infrastructure independent of whether this app is
  running.
- `_map_order` reads Alpaca's `legs` array on the parent order response to
  recover each leg's own `broker_order_id`, populating the same
  `bracket_order_ids` shape as the local broker so the rest of the stack does
  not need to special-case which broker is active.

**Reconciliation (both brokers):** the Node API never learns about a filled
exit leg on its own — something has to ask. `reconcileBracketOrders`
(`apps/api/src/services/trade-execution-service.ts`) finds every locally-open
bracket (entry `FILLED`, both leg IDs present, no exit recorded yet), polls
`GET /broker/orders/:id` for each leg, and calls `recordApprovedBracketExit`
with the correct `TAKE_PROFIT`/`STOP_LOSS` reason and fill data the moment a
leg reports `FILLED`. It runs once at API process startup (restart recovery)
and again on every `GET /dashboard/paper` request, so bracket state self-heals
without any dedicated scheduler. It is idempotent (keyed by the broker's own
`fill_id`) and never lets one bracket's error block the rest.

### Bracket cancellation (Phase 25)

`cancel_order` on a bracket leg — or on the parent entry order id, which
also maps to itself in the adapter's internal `_bracket_leg_parent` index —
now cancels the **whole bracket**: both legs are marked `CANCELLED` and the
bracket is removed from the adapter's pending-bracket registry.

Before Phase 25 this only flipped the status of the one order object passed
in; the pending-bracket registry entry (and the *other* leg) were untouched.
Because `_evaluate_bracket` checks that registry — not the individual order
objects — a later price cross could still call `_fill_bracket_leg` and apply
a phantom fill on top of a position that had already been closed some other
way, corrupting `paper_positions`/`paper_cash` (that internal fill path has
no `_check_funds` guard, unlike every order-submission path). This mattered
once Phase 25 needed to close a bracketed position early (maximum holding
time / end-of-day force-close, see `docs/PHASE_25_INTRADAY_TRADING.md`) —
the fix makes `cancel_order` the correct, safe way to do that for any
future caller, not just Phase 25's reconciler.

`AlpacaPaperBrokerAdapter.cancel_order` needed no equivalent change — Alpaca
already resolves each leg independently via `DELETE /orders/:id`, and
cancelling one side of a live Alpaca bracket already stops the other from
firing on Alpaca's own infrastructure.

### Automatic exits beyond SL/TP (Phase 25)

Maximum holding time and end-of-day force-close (Phase 25) execute the same
way bracket SL/TP already did: **without requesting a new owner approval.**
This is a deliberate architecture decision, not an oversight — the original
entry approval already covers the position's complete exit plan (bracket
prices, max holding time, force-close policy), all frozen into the
proposal's `riskSnapshot` at creation time. Treating a risk-mandated
automatic exit as requiring fresh approval would be inconsistent with how
bracket SL/TP already behaves, and would leave a window where a position
that has breached its own configured safety limit sits open waiting on a
human. See "Unresolved decisions" in `docs/PHASE_25_INTRADAY_TRADING.md`.

---

## API Endpoints (trading-engine internal)

```
POST /broker/orders              — submit an order
GET  /broker/orders/:id          — get order status
POST /broker/orders/:id/cancel   — cancel an order
GET  /broker/health              — broker availability check
GET  /broker/paper-portfolio     — current simulated cash and positions
```

These endpoints are internal-only (not reachable from the internet).
The `apps/api` service calls them; the frontend never calls them.

---

## Future: LiveBrokerAdapter

When (and only when) authorized for live trading:

1. Create `LiveBrokerAdapter` implementing `BrokerAdapter`.
2. Route only through this interface — no changes to execution logic needed.
3. Require a separate architecture review document.
4. Require explicit owner approval.
5. Require separate test environment (paper mode must remain the default).

See `docs/FUTURE_LIVE_TRADING_REQUIREMENTS.md` for full requirements.

---

## Unresolved Decisions

- **Fee model:** Flat per-share vs percentage-based vs fixed per order.
  Placeholder is per-share. Owner must select before trading meaningful volumes.
- **Initial paper cash balance:** Owner must set `initial_paper_cash` in system_settings.
- **Limit order queue persistence:** Queue currently in-memory. A restart loses pending limits.
  This is acceptable for paper trading MVP but must be addressed for production.
