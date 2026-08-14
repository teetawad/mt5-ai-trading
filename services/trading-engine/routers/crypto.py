from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import verify_internal_token
from market_data.provider import SymbolNotFoundError
from market_data.registry import get_provider
from strategy.crypto.analysis import CryptoAnalysis, analyze_crypto_multi_timeframe
from strategy.crypto.config import CryptoStrategyConfig

router = APIRouter(prefix="/crypto", tags=["crypto"])

_TIMEFRAME_1H = "1Hour"
_TIMEFRAME_15M = "15Min"
_TIMEFRAME_5M = "5Min"


class CryptoConfigRequest(BaseModel):
    trend_ema_fast: int = 8
    trend_ema_slow: int = 21
    setup_momentum_window: int = 6
    setup_volume_window: int = 20
    entry_momentum_window: int = 3
    entry_volume_window: int = 20
    atr_window: int = 14
    stop_atr_multiple: Decimal = Decimal("1.5")
    take_profit_atr_multiple: Decimal = Decimal("3.0")
    min_risk_reward: Decimal = Decimal("1.5")
    max_spread_pct: Decimal = Decimal("0.75")
    min_volume_ratio: Decimal = Decimal("1.0")
    quantity: Decimal = Decimal("0.01")

    model_config = {"arbitrary_types_allowed": True}

    def to_config(self) -> CryptoStrategyConfig:
        return CryptoStrategyConfig(
            trend_ema_fast=self.trend_ema_fast,
            trend_ema_slow=self.trend_ema_slow,
            setup_momentum_window=self.setup_momentum_window,
            setup_volume_window=self.setup_volume_window,
            entry_momentum_window=self.entry_momentum_window,
            entry_volume_window=self.entry_volume_window,
            atr_window=self.atr_window,
            stop_atr_multiple=self.stop_atr_multiple,
            take_profit_atr_multiple=self.take_profit_atr_multiple,
            min_risk_reward=self.min_risk_reward,
            max_spread_pct=self.max_spread_pct,
            min_volume_ratio=self.min_volume_ratio,
            quantity=self.quantity,
        )


class CryptoAnalyzeRequest(BaseModel):
    symbol: str
    config: CryptoConfigRequest = CryptoConfigRequest()
    has_open_position: bool = False
    now: str | None = None  # ISO 8601 UTC override, for tests only


def _lookback_start(hours: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=max(hours, 1))).isoformat()


@router.post("/analyze", response_model=CryptoAnalysis)
async def analyze(
    request: CryptoAnalyzeRequest,
    _: None = Depends(verify_internal_token),
) -> CryptoAnalysis:
    symbol = request.symbol.upper()
    config = request.config.to_config()
    provider = get_provider()

    try:
        snapshot = provider.get_snapshot(symbol)
        bars_1h = provider.get_historical_bars(
            symbol,
            timeframe=_TIMEFRAME_1H,
            start=_lookback_start(config.required_1h_bars * 2),
            limit=config.required_1h_bars + 5,
        )
        bars_15m = provider.get_historical_bars(
            symbol,
            timeframe=_TIMEFRAME_15M,
            start=_lookback_start(config.required_15m_bars // 2 + 2),
            limit=config.required_15m_bars + 5,
        )
        bars_5m = provider.get_historical_bars(
            symbol,
            timeframe=_TIMEFRAME_5M,
            start=_lookback_start(config.required_5m_bars // 6 + 2),
            limit=config.required_5m_bars + 5,
        )
    except SymbolNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {symbol}") from exc
    except NotImplementedError as exc:
        raise HTTPException(
            status_code=501,
            detail="Historical bars are not supported by the active market data provider",
        ) from exc

    now = datetime.fromisoformat(request.now) if request.now else None
    return analyze_crypto_multi_timeframe(
        symbol=symbol,
        bars_1h=bars_1h,
        bars_15m=bars_15m,
        bars_5m=bars_5m,
        snapshot=snapshot,
        config=config,
        has_open_position=request.has_open_position,
        now=now,
    )
