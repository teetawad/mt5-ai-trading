"""Synthetic market data provider using a geometric random walk.

Prices are simulated with configurable per-tick volatility. Each symbol
maintains its own last price; a new price is generated whenever the tick
interval elapses since the previous update.

This is intentionally non-deterministic in production. Pass a fixed
`random_seed` in tests to make behaviour deterministic.
"""

import math
import random
import threading
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from .provider import MarketDataProvider, SymbolNotFoundError
from .snapshot import MarketSnapshot

# Default seed prices (USD). Approximate 2024 levels; for paper trading only.
DEFAULT_SYMBOLS: dict[str, Decimal] = {
    "AAPL": Decimal("175.00"),
    "MSFT": Decimal("380.00"),
    "GOOGL": Decimal("175.00"),
    "AMZN": Decimal("185.00"),
    "META": Decimal("505.00"),
    "TSLA": Decimal("250.00"),
    "NVDA": Decimal("900.00"),
    "SPY": Decimal("520.00"),
    "QQQ": Decimal("445.00"),
}


class SyntheticMarketDataProvider(MarketDataProvider):
    """Generates synthetic prices using a discrete geometric random walk.

    price_new = price_old * exp(σ * Z)
    where Z ~ N(0, 1) and σ is `tick_volatility`.

    Prices are cached for `tick_interval_seconds` to avoid changing on every
    call within the same tick window.
    """

    def __init__(
        self,
        symbols: dict[str, Decimal] | None = None,
        tick_volatility: float = 0.001,
        half_spread_pct: float = 0.0005,
        tick_interval_seconds: float = 5.0,
        staleness_threshold_seconds: int = 60,
        random_seed: int | None = None,
    ) -> None:
        self._prices: dict[str, Decimal] = dict(symbols or DEFAULT_SYMBOLS)
        self._tick_volatility = tick_volatility
        self._half_spread = Decimal(str(half_spread_pct))
        self._tick_interval = tick_interval_seconds
        self._staleness_threshold = staleness_threshold_seconds
        self._last_tick: dict[str, datetime] = {}
        self._lock = threading.Lock()
        self._rng = random.Random(random_seed)

    def _advance_price(self, symbol: str) -> None:
        """Generate a new price tick (called while lock is held)."""
        old = self._prices[symbol]
        z = self._rng.gauss(0.0, 1.0)
        factor = Decimal(str(math.exp(self._tick_volatility * z)))
        new_price = (old * factor).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        self._prices[symbol] = max(new_price, Decimal("0.01"))
        self._last_tick[symbol] = datetime.now(UTC)

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol not in self._prices:
            raise SymbolNotFoundError(f"Symbol not tracked: {symbol}")

        with self._lock:
            now = datetime.now(UTC)
            last = self._last_tick.get(symbol)
            if last is None or (now - last).total_seconds() >= self._tick_interval:
                self._advance_price(symbol)

            price = self._prices[symbol]
            tick_time = self._last_tick[symbol]

        bid = (price * (1 - self._half_spread)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        ask = (price * (1 + self._half_spread)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        age_seconds = (datetime.now(UTC) - tick_time).total_seconds()

        return MarketSnapshot(
            symbol=symbol,
            price=price,
            bid=bid,
            ask=ask,
            volume=self._rng.randint(1_000, 100_000),
            timestamp=tick_time,
            is_stale=age_seconds > self._staleness_threshold,
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self.get_snapshot(sym) for sym in self._prices]

    def tracked_symbols(self) -> list[str]:
        return list(self._prices.keys())
