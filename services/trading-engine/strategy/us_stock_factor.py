import math
from collections import deque
from decimal import Decimal

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketSnapshot
from strategy.base import Strategy
from strategy.signal import Signal, SignalSide, SignalType


class USStockFactorConfig:
    def __init__(
        self,
        *,
        trend_window: int = 20,
        momentum_window: int = 10,
        volatility_window: int = 20,
        volume_window: int = 20,
        short_window: int = 5,
        long_window: int = 20,
        min_trend_pct: Decimal = Decimal("0"),
        min_momentum_pct: Decimal = Decimal("0"),
        max_volatility_pct: Decimal = Decimal("100"),
        min_volume_ratio: Decimal = Decimal("0"),
        exit_trend_pct: Decimal = Decimal("0"),
        exit_momentum_pct: Decimal = Decimal("0"),
    ) -> None:
        windows = [
            trend_window,
            momentum_window,
            volatility_window,
            volume_window,
            short_window,
            long_window,
        ]
        if any(window < 2 for window in windows):
            raise ValueError("All factor windows must be at least 2")
        if short_window >= long_window:
            raise ValueError("short_window must be less than long_window")
        if max_volatility_pct < 0:
            raise ValueError("max_volatility_pct must be non-negative")
        if min_volume_ratio < 0:
            raise ValueError("min_volume_ratio must be non-negative")

        self.trend_window = trend_window
        self.momentum_window = momentum_window
        self.volatility_window = volatility_window
        self.volume_window = volume_window
        self.short_window = short_window
        self.long_window = long_window
        self.min_trend_pct = min_trend_pct
        self.min_momentum_pct = min_momentum_pct
        self.max_volatility_pct = max_volatility_pct
        self.min_volume_ratio = min_volume_ratio
        self.exit_trend_pct = exit_trend_pct
        self.exit_momentum_pct = exit_momentum_pct

    @property
    def required_history(self) -> int:
        return max(
            self.trend_window,
            self.momentum_window,
            self.volatility_window,
            self.long_window,
        )


class USStockFactorStrategy(Strategy):
    """Read-only US stock factor strategy.

    Uses trend, momentum, volatility, volume, and moving-average filters for
    configurable entry/exit rules. This class emits proposals only; it cannot
    execute orders.
    """

    def __init__(
        self,
        symbol: str,
        *,
        quantity: Decimal = Decimal("1"),
        config: USStockFactorConfig | None = None,
    ) -> None:
        if quantity <= 0:
            raise ValueError("quantity must be positive")
        self._symbol = symbol.upper()
        self._quantity = quantity
        self._config = config or USStockFactorConfig()
        self._prices: deque[Decimal] = deque(maxlen=self._config.required_history + 1)
        self._volumes: deque[int] = deque(maxlen=self._config.volume_window + 1)
        self._in_position = False

    @property
    def name(self) -> str:
        return (
            f"us_stock_factor_{self._symbol}"
            f"_{self._config.short_window}_{self._config.long_window}"
        )

    def generate_signals(self, market_data: MarketDataProvider) -> list[Signal]:
        try:
            snapshot = market_data.get_snapshot(self._symbol)
        except SymbolNotFoundError:
            return []

        self._prices.append(snapshot.price)
        self._volumes.append(snapshot.volume)
        if len(self._prices) < self._config.required_history + 1:
            return []
        if len(self._volumes) < self._config.volume_window + 1:
            return []

        features = _features(self._config, list(self._prices), list(self._volumes))
        entry = (
            features["trend_pct"] >= self._config.min_trend_pct
            and features["momentum_pct"] >= self._config.min_momentum_pct
            and features["volatility_pct"] <= self._config.max_volatility_pct
            and features["volume_ratio"] >= self._config.min_volume_ratio
            and features["short_ma"] > features["long_ma"]
        )
        exit_rule = (
            features["trend_pct"] <= self._config.exit_trend_pct
            or features["momentum_pct"] <= self._config.exit_momentum_pct
            or features["short_ma"] < features["long_ma"]
        )

        if not self._in_position and entry:
            self._in_position = True
            return [self._signal(snapshot, SignalSide.BUY, features)]
        if self._in_position and exit_rule:
            self._in_position = False
            return [self._signal(snapshot, SignalSide.SELL, features)]
        return []

    def _signal(
        self,
        snapshot: MarketSnapshot,
        side: SignalSide,
        features: dict[str, Decimal],
    ) -> Signal:
        return Signal.make(
            strategy_name=self.name,
            symbol=self._symbol,
            side=side,
            quantity=self._quantity,
            signal_type=SignalType.MARKET,
            reference_price=snapshot.price,
            confidence=_confidence(features),
            metadata={key: str(value) for key, value in features.items()},
        )


def _features(
    config: USStockFactorConfig,
    prices: list[Decimal],
    volumes: list[int],
) -> dict[str, Decimal]:
    current = prices[-1]
    trend_base = prices[-1 - config.trend_window]
    momentum_base = prices[-1 - config.momentum_window]
    returns = [
        (current_price / previous_price) - Decimal("1")
        for previous_price, current_price in zip(
            prices[-1 - config.volatility_window : -1],
            prices[-config.volatility_window :],
            strict=False,
        )
        if previous_price != 0
    ]
    previous_volumes = volumes[-1 - config.volume_window : -1]
    return {
        "trend_pct": _pct_change(current, trend_base),
        "momentum_pct": _pct_change(current, momentum_base),
        "volatility_pct": _std(returns) * Decimal("100"),
        "volume_ratio": Decimal(volumes[-1]) / _avg_volume(previous_volumes),
        "short_ma": sum(prices[-config.short_window :], Decimal("0"))
        / Decimal(config.short_window),
        "long_ma": sum(prices[-config.long_window :], Decimal("0"))
        / Decimal(config.long_window),
    }


def _pct_change(current: Decimal, previous: Decimal) -> Decimal:
    if previous == 0:
        return Decimal("0")
    return (current / previous - Decimal("1")) * Decimal("100")


def _avg_volume(values: list[int]) -> Decimal:
    if not values:
        return Decimal("1")
    average = Decimal(sum(values)) / Decimal(len(values))
    return average if average > 0 else Decimal("1")


def _std(values: list[Decimal]) -> Decimal:
    if len(values) < 2:
        return Decimal("0")
    float_values = [float(value) for value in values]
    mean = sum(float_values) / len(float_values)
    variance = sum((value - mean) ** 2 for value in float_values) / (len(float_values) - 1)
    return Decimal(str(math.sqrt(variance)))


def _confidence(features: dict[str, Decimal]) -> float:
    trend = max(Decimal("0"), features["trend_pct"]) / Decimal("10")
    momentum = max(Decimal("0"), features["momentum_pct"]) / Decimal("10")
    volume = min(features["volume_ratio"], Decimal("3")) / Decimal("3")
    raw = min(Decimal("1"), (trend + momentum + volume) / Decimal("3"))
    return float(raw)
