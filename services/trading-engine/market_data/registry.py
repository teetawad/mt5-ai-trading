"""Module-level singleton registry for the active MarketDataProvider.

Initialised once at application startup in main.py.
All routers and services import `get_provider()` to access market data.
"""

import os
from pathlib import Path

from .provider import MarketDataProvider
from .synthetic import SyntheticMarketDataProvider

_provider: MarketDataProvider | None = None


def init_provider(provider: MarketDataProvider | None = None) -> None:
    """Initialise the registry.  Call once at startup."""
    global _provider
    if provider is not None:
        _provider = provider
        return

    mode = os.environ.get("MARKET_DATA_PROVIDER", "synthetic").lower()

    if mode == "csv":
        from .csv_provider import CSVMarketDataProvider

        data_dir = Path(os.environ.get("MARKET_DATA_DIR", "data/market_data"))
        staleness = int(os.environ.get("MARKET_DATA_STALENESS_SECONDS", "60"))
        _provider = CSVMarketDataProvider(
            data_dir=data_dir,
            staleness_threshold_seconds=staleness,
        )
    elif mode == "alpaca":
        from .alpaca import AlpacaMarketDataProvider

        _provider = AlpacaMarketDataProvider.from_env()
    else:
        staleness = int(os.environ.get("MARKET_DATA_STALENESS_SECONDS", "60"))
        _provider = SyntheticMarketDataProvider(
            staleness_threshold_seconds=staleness,
        )


def get_provider() -> MarketDataProvider:
    if _provider is None:
        raise RuntimeError("MarketDataProvider has not been initialised — call init_provider()")
    return _provider
