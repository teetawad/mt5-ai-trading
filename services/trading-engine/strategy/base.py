from abc import ABC, abstractmethod

from market_data.provider import MarketDataProvider
from strategy.signal import Signal


class Strategy(ABC):
    @property
    @abstractmethod
    def name(self) -> str:
        """Unique strategy name used for identification and logging."""
        ...

    @abstractmethod
    def generate_signals(self, market_data: MarketDataProvider) -> list[Signal]:
        """Generate trading signals from current market data.

        Read-only access to market_data only.
        Must NOT import or call broker, execution, or order management code.
        """
        ...
