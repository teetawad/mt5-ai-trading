"""Module-level singleton registry for the active MarketDataProvider.

Initialised once at application startup in main.py.
All routers and services import `get_provider()` to access market data.
"""

import os
from pathlib import Path
from typing import Any

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


def get_market_data_status() -> dict[str, Any]:
    """Report connection/freshness state for the active provider.

    Providers that stream (currently only AlpacaMarketDataProvider once a
    stream is attached) implement `connection_status()`. Pull-based providers
    (synthetic, CSV, Alpaca without a stream attached) have no persistent
    connection to be up/down, so they report as always "connected" — their
    per-symbol freshness is already covered by MarketSnapshot.is_stale.
    """
    provider = get_provider()
    status_fn = getattr(provider, "connection_status", None)
    if callable(status_fn):
        result: dict[str, Any] = status_fn()
        return result
    return {"mode": "poll", "connected": True, "last_message_at": None}
