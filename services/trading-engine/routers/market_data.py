import os

from fastapi import APIRouter, Depends, Header, HTTPException

from market_data.provider import (
    MarketDataProviderError,
    MarketDataRateLimitError,
    SymbolNotFoundError,
)
from market_data.registry import get_provider
from market_data.snapshot import MarketBar, MarketQuote, MarketSnapshot, MarketTrade

router = APIRouter(prefix="/market-data", tags=["market-data"])


def _verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


def _provider_error(exc: Exception) -> HTTPException:
    if isinstance(exc, SymbolNotFoundError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, NotImplementedError):
        return HTTPException(status_code=501, detail=str(exc))
    if isinstance(exc, MarketDataRateLimitError):
        headers = {}
        if exc.retry_after_seconds is not None:
            headers["Retry-After"] = str(exc.retry_after_seconds)
        return HTTPException(status_code=429, detail=str(exc), headers=headers)
    if isinstance(exc, MarketDataProviderError):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=503, detail="Market data provider unavailable")


@router.get("/snapshot/{symbol}", response_model=MarketSnapshot)
async def get_snapshot(
    symbol: str,
    _: None = Depends(_verify_internal_token),
) -> MarketSnapshot:
    try:
        return get_provider().get_snapshot(symbol.upper())
    except SymbolNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {symbol}") from exc
    except (MarketDataProviderError, MarketDataRateLimitError) as exc:
        raise _provider_error(exc) from exc


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


@router.get("/bars/{symbol}", response_model=list[MarketBar])
async def get_historical_bars(
    symbol: str,
    timeframe: str,
    start: str,
    end: str | None = None,
    limit: int = 100,
    _: None = Depends(_verify_internal_token),
) -> list[MarketBar]:
    if limit < 1 or limit > 10_000:
        raise HTTPException(status_code=422, detail="limit must be between 1 and 10000")
    try:
        return get_provider().get_historical_bars(
            symbol.upper(),
            timeframe=timeframe,
            start=start,
            end=end,
            limit=limit,
        )
    except Exception as exc:
        raise _provider_error(exc) from exc


@router.get("/quote/{symbol}", response_model=MarketQuote)
async def get_latest_quote(
    symbol: str,
    _: None = Depends(_verify_internal_token),
) -> MarketQuote:
    try:
        return get_provider().get_latest_quote(symbol.upper())
    except Exception as exc:
        raise _provider_error(exc) from exc


@router.get("/trade/{symbol}", response_model=MarketTrade)
async def get_latest_trade(
    symbol: str,
    _: None = Depends(_verify_internal_token),
) -> MarketTrade:
    try:
        return get_provider().get_latest_trade(symbol.upper())
    except Exception as exc:
        raise _provider_error(exc) from exc
