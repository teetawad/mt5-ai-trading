from datetime import UTC, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import verify_internal_token
from market_data.provider import SymbolNotFoundError
from market_data.registry import get_provider
from strategy.hourly.analysis import HourlyAnalysis, analyze_hourly
from strategy.hourly.config import HourlyStrategyConfig
from strategy.intraday.config import IntradaySessionConfig

router = APIRouter(prefix="/hourly", tags=["hourly"])

_TIMEFRAME_1H = "1Hour"


class HourlySessionConfigRequest(BaseModel):
    market_open: str = "13:30"
    market_close: str = "20:00"
    no_new_trades_minutes_before_close: int = 60
    force_close_before_close_minutes: int = 30
    force_close_enabled: bool = True


class HourlyConfigRequest(BaseModel):
    trend_ema_fast: int = 8
    trend_ema_slow: int = 21
    momentum_window: int = 3
    volume_window: int = 20
    breakout_lookback_bars: int = 20
    min_volume_ratio: Decimal = Decimal("1.0")
    atr_window: int = 14
    stop_atr_multiple: Decimal = Decimal("1.5")
    take_profit_atr_multiple: Decimal = Decimal("3.0")
    min_risk_reward: Decimal = Decimal("1.5")
    max_spread_pct: Decimal = Decimal("0.5")
    higher_tf_bars_per_candle: int = 4
    higher_tf_confirmation_required: bool = True
    max_holding_hours: int = 8
    quantity: Decimal = Decimal("1")
    session: HourlySessionConfigRequest = HourlySessionConfigRequest()

    model_config = {"arbitrary_types_allowed": True}

    def to_config(self) -> HourlyStrategyConfig:
        return HourlyStrategyConfig(
            trend_ema_fast=self.trend_ema_fast,
            trend_ema_slow=self.trend_ema_slow,
            momentum_window=self.momentum_window,
            volume_window=self.volume_window,
            breakout_lookback_bars=self.breakout_lookback_bars,
            min_volume_ratio=self.min_volume_ratio,
            atr_window=self.atr_window,
            stop_atr_multiple=self.stop_atr_multiple,
            take_profit_atr_multiple=self.take_profit_atr_multiple,
            min_risk_reward=self.min_risk_reward,
            max_spread_pct=self.max_spread_pct,
            higher_tf_bars_per_candle=self.higher_tf_bars_per_candle,
            higher_tf_confirmation_required=self.higher_tf_confirmation_required,
            max_holding_hours=self.max_holding_hours,
            quantity=self.quantity,
            session=IntradaySessionConfig(
                market_open=self.session.market_open,
                market_close=self.session.market_close,
                no_new_trades_minutes_before_close=self.session.no_new_trades_minutes_before_close,
                force_close_before_close_minutes=self.session.force_close_before_close_minutes,
                force_close_enabled=self.session.force_close_enabled,
            ),
        )


class HourlyAnalyzeRequest(BaseModel):
    symbol: str
    config: HourlyConfigRequest = HourlyConfigRequest()
    has_open_position: bool = False
    now: str | None = None  # ISO 8601 UTC override, for tests only


def _lookback_start(hours: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=max(hours, 1))).isoformat()


@router.post("/analyze", response_model=HourlyAnalysis)
async def analyze(
    request: HourlyAnalyzeRequest,
    _: None = Depends(verify_internal_token),
) -> HourlyAnalysis:
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
    except SymbolNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Symbol not found: {symbol}") from exc
    except NotImplementedError as exc:
        raise HTTPException(
            status_code=501,
            detail="Historical bars are not supported by the active market data provider",
        ) from exc

    now = datetime.fromisoformat(request.now) if request.now else None
    return analyze_hourly(
        symbol=symbol,
        bars_1h=bars_1h,
        snapshot=snapshot,
        config=config,
        has_open_position=request.has_open_position,
        now=now,
    )
