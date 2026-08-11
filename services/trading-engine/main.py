from fastapi import FastAPI

from routers.health import router as health_router

app = FastAPI(
    title="Trading Engine",
    description="Internal paper trading engine — PAPER MODE ONLY",
    version="0.1.0",
)

app.include_router(health_router)


@app.get("/")
async def root() -> dict[str, str]:
    return {
        "service": "trading-engine",
        "mode": "PAPER",
        "note": "Internal service — not exposed to the internet",
    }
