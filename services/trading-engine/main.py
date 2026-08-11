from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from decimal import Decimal

from fastapi import FastAPI

from broker.registry import init_broker
from market_data.registry import init_provider
from routers.broker import router as broker_router
from routers.health import router as health_router
from routers.market_data import router as market_data_router
from routers.signals import router as signals_router
from strategy.moving_average_crossover import MovingAverageCrossoverStrategy
from strategy.registry import register_strategy


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

    yield


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


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "trading-engine",
        "mode": "PAPER",
        "note": "Internal service — not exposed to the internet",
    }
