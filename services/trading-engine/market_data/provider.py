"""Abstract interface for all market data providers.

Strategy and risk engine code depend only on this interface —
never on a concrete implementation.
"""

from abc import ABC, abstractmethod

from .snapshot import MarketSnapshot


class SymbolNotFoundError(Exception):
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
