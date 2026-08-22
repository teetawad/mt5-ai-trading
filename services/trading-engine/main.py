import logging
import os
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI

_ROOT_ENV_PATH = Path(__file__).resolve().parent.parent.parent / ".env"
if _ROOT_ENV_PATH.exists():
    load_dotenv(_ROOT_ENV_PATH)

# CRITICAL: without this, Python's logging module has NO configured handler
# anywhere in this app — every logger.info()/logger.debug() call in
# mt5/adapter.py and routers/mt5.py (order_check/order_send diagnostics,
# raw MqlTradeResult dumps, reconciliation timing) was being silently
# discarded before it ever reached the console. This was the actual reason
# none of the "development diagnostics" added to mt5/adapter.py were ever
# visible during manual DEMO testing — not a missing log statement, a
# missing handler. MT5_LOG_LEVEL (default INFO) covers the whole app; the
# mt5.* namespace is always at least DEBUG so the raw order_send/order_check
# dumps (spec: "print in development") are never filtered out even if
# MT5_LOG_LEVEL is set coarser for the rest of the app.
logging.basicConfig(
    level=getattr(logging, os.environ.get("MT5_LOG_LEVEL", "INFO").upper(), logging.INFO),
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logging.getLogger("mt5").setLevel(logging.DEBUG)

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
