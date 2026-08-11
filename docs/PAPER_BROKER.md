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
