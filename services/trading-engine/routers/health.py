from datetime import UTC, datetime

from fastapi import APIRouter

router = APIRouter(prefix="/health", tags=["health"])


@router.get("")
async def health_check() -> dict[str, str]:
    return {
        "status": "ok",
        "service": "trading-engine",
        "mode": "MT5_DEMO_ONLY",
        "timestamp": datetime.now(UTC).isoformat(),
    }
