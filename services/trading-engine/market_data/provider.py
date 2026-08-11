"""Abstract interface for all market data providers.

Strategy and risk engine code depend only on this interface —
never on a concrete implementation.
"""

from abc import ABC, abstractmethod

from .snapshot import MarketBar, MarketQuote, MarketSnapshot, MarketTrade


class SymbolNotFoundError(Exception):
    pass


class MarketDataRateLimitError(Exception):
    def __init__(self, message: str, retry_after_seconds: float | None = None) -> None:
        super().__init__(message)
        self.retry_after_seconds = retry_after_seconds


class MarketDataProviderError(Exception):
    pass


class MarketDataProvider(ABC):
    @abstractmethod
    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        """Return the current market snapshot for a symbol.

        Raises SymbolNotFoundError if the symbol is not tracked.
        """

    @abstractmethod
    def get_all_snapshots(self) -> list[MarketSnapshot]:
        """Return snapshots for all tracked symbols."""

    @abstractmethod
    def tracked_symbols(self) -> list[str]:
        """Return the list of symbols this provider tracks."""

    def get_historical_bars(
        self,
        symbol: str,
        *,
        timeframe: str,
        start: str,
        end: str | None = None,
        limit: int = 100,
    ) -> list[MarketBar]:
        raise NotImplementedError("Historical bars are not supported by this provider")

    def get_latest_quote(self, symbol: str) -> MarketQuote:
        raise NotImplementedError("Latest quotes are not supported by this provider")

    def get_latest_trade(self, symbol: str) -> MarketTrade:
        raise NotImplementedError("Latest trades are not supported by this provider")
