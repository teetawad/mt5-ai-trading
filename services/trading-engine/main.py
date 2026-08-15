from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

_ROOT_ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if _ROOT_ENV_PATH.exists():
    load_dotenv(_ROOT_ENV_PATH)

from market_data.registry import init_provider  # noqa: E402
from routers.health import router as health_router  # noqa: E402
from routers.market_data import router as market_data_router  # noqa: E402
from routers.mt5 import router as mt5_router  # noqa: E402
from routers.risk import router as risk_router  # noqa: E402
from routers.signals import router as signals_router  # noqa: E402
from strategy.moving_average_crossover import MovingAverageCrossoverStrategy  # noqa: E402
from strategy.registry import register_strategy  # noqa: E402


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    init_provider()

    # Legacy synthetic strategy remains available for local smoke tests only.
    # MT5 execution and MT5 analysis use routers.mt5 and DemoExecutionGateway.
    register_strategy(
        MovingAverageCrossoverStrategy(
            symbol="DEMO",
            short_window=5,
            long_window=20,
        )
    )
    yield


app = FastAPI(
    title="Trading Engine",
    description="Internal MT5 AI DEMO trading engine — DEMO ONLY",
    version="0.1.0",
    lifespan=lifespan,
)

app.include_router(health_router)
app.include_router(market_data_router)
app.include_router(signals_router)
app.include_router(risk_router)
app.include_router(mt5_router)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "trading-engine",
        "mode": "MT5_DEMO_ONLY",
        "note": "Internal service — not exposed to the internet",
    }
