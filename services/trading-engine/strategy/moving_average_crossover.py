from collections import deque
from decimal import Decimal

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from strategy.base import Strategy
from strategy.signal import Signal, SignalSide, SignalType


class MovingAverageCrossoverStrategy(Strategy):
    """Generates BUY/SELL signals on short/long simple moving average crossovers.

    BUY  when the short MA crosses above the long MA.
    SELL when the short MA crosses below the long MA.
    No signal is emitted while the price history is shorter than long_window.
    """

    def __init__(
        self,
        symbol: str,
        short_window: int = 5,
        long_window: int = 20,
        quantity: Decimal = Decimal("10"),
    ) -> None:
        if short_window >= long_window:
            raise ValueError(
                f"short_window ({short_window}) must be less than long_window ({long_window})"
            )
        self._symbol = symbol
        self._short_window = short_window
        self._long_window = long_window
        self._quantity = quantity
        self._prices: deque[Decimal] = deque(maxlen=long_window)
        self._prev_short_ma: Decimal | None = None
        self._prev_long_ma: Decimal | None = None

    @property
    def name(self) -> str:
        return (
            f"moving_average_crossover"
            f"_{self._symbol}"
            f"_{self._short_window}"
            f"_{self._long_window}"
        )

    def generate_signals(self, market_data: MarketDataProvider) -> list[Signal]:
        try:
            snapshot = market_data.get_snapshot(self._symbol)
        except SymbolNotFoundError:
            return []

        current_price = snapshot.price
        self._prices.append(current_price)

        if len(self._prices) < self._long_window:
            return []

        prices_list = list(self._prices)
        short_ma = sum(prices_list[-self._short_window :]) / Decimal(self._short_window)
        long_ma = sum(prices_list) / Decimal(self._long_window)

        signals: list[Signal] = []
        prev_short = self._prev_short_ma
        prev_long = self._prev_long_ma

        if prev_short is not None and prev_long is not None:
            divergence = abs(float(short_ma - long_ma) / float(long_ma))

            if prev_short <= prev_long and short_ma > long_ma:
                signals.append(
                    Signal.make(
                        strategy_name=self.name,
                        symbol=self._symbol,
                        side=SignalSide.BUY,
                        quantity=self._quantity,
                        signal_type=SignalType.MARKET,
                        reference_price=current_price,
                        confidence=min(1.0, divergence),
                        metadata={
                            "short_ma": str(short_ma),
                            "long_ma": str(long_ma),
                        },
                    )
                )
            elif prev_short >= prev_long and short_ma < long_ma:
                signals.append(
                    Signal.make(
                        strategy_name=self.name,
                        symbol=self._symbol,
                        side=SignalSide.SELL,
                        quantity=self._quantity,
                        signal_type=SignalType.MARKET,
                        reference_price=current_price,
                        confidence=min(1.0, divergence),
                        metadata={
                            "short_ma": str(short_ma),
                            "long_ma": str(long_ma),
                        },
                    )
                )

        self._prev_short_ma = short_ma
        self._prev_long_ma = long_ma

        return signals
