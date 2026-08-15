import asyncio
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from decimal import Decimal
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

_ROOT_ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if _ROOT_ENV_PATH.exists():
    load_dotenv(_ROOT_ENV_PATH)

from broker.registry import init_broker  # noqa: E402
from market_data.alpaca import AlpacaMarketDataProvider  # noqa: E402
from market_data.registry import get_provider, init_provider  # noqa: E402
from routers.broker import router as broker_router  # noqa: E402
from routers.crypto import router as crypto_router  # noqa: E402
from routers.health import router as health_router  # noqa: E402
from routers.hourly import router as hourly_router  # noqa: E402
from routers.intraday import router as intraday_router  # noqa: E402
from routers.market_data import router as market_data_router  # noqa: E402
from routers.risk import router as risk_router  # noqa: E402
from routers.signals import router as signals_router  # noqa: E402
from strategy.crypto.strategy import CryptoMultiTimeframeStrategy  # noqa: E402
from strategy.hourly.strategy import HourlyTrendStrategy  # noqa: E402
from strategy.intraday.strategy import IntradayMultiTimeframeStrategy  # noqa: E402
from strategy.moving_average_crossover import MovingAverageCrossoverStrategy  # noqa: E402
from strategy.registry import register_strategy  # noqa: E402


def _stream_enabled() -> bool:
    return os.environ.get("MARKET_DATA_STREAM_ENABLED", "true").strip().lower() not in {
        "false",
        "0",
        "no",
    }


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    init_provider()
    init_broker()

    # Register default strategies
    register_strategy(
        MovingAverageCrossoverStrategy(
            symbol="AAPL",
            short_window=5,
            long_window=20,
            quantity=Decimal("10"),
        )
    )
    register_strategy(IntradayMultiTimeframeStrategy(symbol="AAPL"))
    register_strategy(CryptoMultiTimeframeStrategy(symbol="BTC/USD"))
    register_strategy(CryptoMultiTimeframeStrategy(symbol="ETH/USD"))
    register_strategy(HourlyTrendStrategy(symbol="AAPL"))

    # Activate the real-time market-data stream (Alpaca only) — this is the
    # single market-data connection this service opens; get_snapshot prefers
    # it over REST once connected (see AlpacaMarketDataProvider.attach_stream).
    stream_task: asyncio.Task[None] | None = None
    stop_event = asyncio.Event()
    provider = get_provider()
    if _stream_enabled() and isinstance(provider, AlpacaMarketDataProvider):
        stream = provider.create_stream()
        provider.attach_stream(stream)
        stream_task = asyncio.create_task(
            stream.run_forever(symbols=provider.tracked_symbols(), stop_event=stop_event)
        )

    yield

    if stream_task is not None:
        stop_event.set()
        try:
            await asyncio.wait_for(stream_task, timeout=5.0)
        except (TimeoutError, asyncio.CancelledError):
            stream_task.cancel()


app = FastAPI(
    title="Trading Engine",
    description="Internal paper trading engine — PAPER MODE ONLY",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(market_data_router)
app.include_router(broker_router)
app.include_router(signals_router)
app.include_router(risk_router)
app.include_router(intraday_router)
app.include_router(crypto_router)
app.include_router(hourly_router)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "trading-engine",
        "mode": "PAPER",
        "note": "Internal service — not exposed to the internet",
    }
