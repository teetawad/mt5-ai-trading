import os

from fastapi import APIRouter, Depends, Header, HTTPException

from market_data.provider import SymbolNotFoundError
from market_data.registry import get_provider
from market_data.snapshot import MarketSnapshot

router = APIRouter(prefix="/market-data", tags=["market-data"])


def _verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.get("/snapshot/{symbol}", response_model=MarketSnapshot)
async def get_snapshot(
    symbol: str,
    _: None = Depends(_verify_internal_token),
) -> MarketSnapshot:
    try:
        return get_provider().get_snapshot(symbol.upper())
    except SymbolNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {symbol}") from exc


@router.get("/snapshots", response_model=list[MarketSnapshot])
async def get_all_snapshots(
    _: None = Depends(_verify_internal_token),
) -> list[MarketSnapshot]:
    return get_provider().get_all_snapshots()


@router.get("/symbols", response_model=list[str])
async def get_tracked_symbols(
    _: None = Depends(_verify_internal_token),
) -> list[str]:
    return get_provider().tracked_symbols()
