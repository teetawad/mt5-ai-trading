"""Pure indicator functions used by the intraday multi-timeframe strategy.

All functions operate on already-closed bars/values only — callers are
responsible for not passing an in-progress bar (see analysis.py).
"""

import math
from decimal import Decimal

from market_data.snapshot import MarketBar


def ema(values: list[Decimal], period: int) -> Decimal:
    """Exponential moving average, seeded with the first value.

    Seeding with the first observation (rather than an initial SMA) keeps
    this deterministic for short series and simple to unit test; it slightly
    under-weights the earliest values relative to textbook EMA, which is
    immaterial once `values` is a few multiples of `period` long.
    """
    if not values:
        raise ValueError("values must not be empty")
    k = 2.0 / (period + 1)
    current = float(values[0])
    for value in values[1:]:
        current = float(value) * k + current * (1 - k)
    return Decimal(str(current))


def roc_pct(values: list[Decimal], window: int) -> Decimal:
    """Rate of change (percent) between the latest value and `window` bars back."""
    if len(values) < window + 1:
        raise ValueError("not enough values for the requested window")
    current = values[-1]
    previous = values[-1 - window]
    if previous == 0:
        return Decimal("0")
    return (current / previous - Decimal("1")) * Decimal("100")


def volume_ratio(volumes: list[int], window: int) -> Decimal:
    """Latest volume divided by the average of the preceding `window` volumes."""
    if len(volumes) < window + 1:
        raise ValueError("not enough volumes for the requested window")
    previous = volumes[-1 - window : -1]
    avg = Decimal(sum(previous)) / Decimal(len(previous)) if previous else Decimal("0")
    if avg <= 0:
        return Decimal("1")
    return Decimal(volumes[-1]) / avg


def atr(bars: list[MarketBar], period: int) -> Decimal:
    """Average True Range over the last `period` bars (simple average of TR)."""
    if len(bars) < period + 1:
        raise ValueError("not enough bars for the requested ATR period")
    true_ranges: list[Decimal] = []
    for previous, current in zip(bars[-period - 1 : -1], bars[-period:], strict=True):
        true_ranges.append(
            max(
                current.high - current.low,
                abs(current.high - previous.close),
                abs(current.low - previous.close),
            )
        )
    return sum(true_ranges, Decimal("0")) / Decimal(len(true_ranges))


def stddev_pct(values: list[Decimal]) -> Decimal:
    """Sample standard deviation of period-over-period percent returns."""
    if len(values) < 3:
        return Decimal("0")
    returns = [
        float(current / previous - Decimal("1"))
        for previous, current in zip(values[:-1], values[1:], strict=False)
        if previous != 0
    ]
    if len(returns) < 2:
        return Decimal("0")
    mean = sum(returns) / len(returns)
    variance = sum((value - mean) ** 2 for value in returns) / (len(returns) - 1)
    return Decimal(str(math.sqrt(variance) * 100))
