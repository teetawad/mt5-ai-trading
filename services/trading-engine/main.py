from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from broker.registry import init_broker
from market_data.registry import init_provider
from routers.broker import router as broker_router
from routers.health import router as health_router
from routers.market_data import router as market_data_router


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    init_provider()
    init_broker()
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


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "trading-engine",
        "mode": "PAPER",
        "note": "Internal service — not exposed to the internet",
    }
