"""Strategy-registry wrapper around analyze_hourly.

Fetches a fresh 1H historical bar series on every call — a single request
per invocation, unlike the three-timeframe Phase 25/26 strategies. Registry-
based strategies only ever emit entry (BUY) signals — the registered
`Strategy.generate_signals` interface has no portfolio/position context, so
a SELL (position-close) decision cannot be evaluated safely here. The
dedicated `/hourly/analyze` endpoint (called directly by the Node API's
hourly scheduler, which does have portfolio context) is the actual product
path for bidirectional BUY/SELL/HOLD decisions — see routers/hourly.py.
"""

from datetime import UTC, datetime, timedelta

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from strategy.base import Strategy
from strategy.signal import Signal, SignalSide, SignalType

from .analysis import HourlyDecision, analyze_hourly
from .config import HourlyStrategyConfig

_TIMEFRAME_1H = "1Hour"


class HourlyTrendStrategy(Strategy):
    """Long-only hourly entry strategy analyzing a single closed 1H series.

    Emits BUY entry signals only. Exits (bracket SL/TP, an explicit SELL
    decision from `/hourly/analyze` when a position is open, maximum holding
    time, end-of-day force-close) are handled downstream, not via this
    registry path — see docs/PAPER_BROKER.md.
    """

    def __init__(
        self,
        symbol: str,
        *,
        config: HourlyStrategyConfig | None = None,
        now_override: datetime | None = None,
    ) -> None:
        self._symbol = symbol.upper()
        self._config = config or HourlyStrategyConfig()
        # Test-only override for "now" (mirrors intraday/crypto's own
        # now_override) — live callers never set this.
        self._now_override = now_override

    @property
    def name(self) -> str:
        return f"hourly_trend_{self._symbol}"

    def generate_signals(self, market_data: MarketDataProvider) -> list[Signal]:
        try:
            snapshot = market_data.get_snapshot(self._symbol)
            bars_1h = market_data.get_historical_bars(
                self._symbol,
                timeframe=_TIMEFRAME_1H,
                start=_lookback_start(hours=self._config.required_1h_bars * 2),
                limit=self._config.required_1h_bars + 5,
            )
        except SymbolNotFoundError:
            return []
        except NotImplementedError:
            return []

        analysis = analyze_hourly(
            symbol=self._symbol,
            bars_1h=bars_1h,
            snapshot=snapshot,
            config=self._config,
            has_open_position=False,
            now=self._now_override,
        )
        if analysis.decision != HourlyDecision.BUY:
            return []

        return [
            Signal.make(
                strategy_name=self.name,
                symbol=self._symbol,
                side=SignalSide.BUY,
                quantity=self._config.quantity,
                signal_type=SignalType.MARKET,
                reference_price=snapshot.price,
                confidence=analysis.confidence,
                metadata={
                    "trend_direction": analysis.trend_direction.value,
                    "trend_strength_pct": str(analysis.trend_strength_pct),
                    "momentum_pct": str(analysis.momentum_pct),
                    "volume_ratio": str(analysis.volume_ratio),
                    "atr": str(analysis.atr),
                    "stop_loss": str(analysis.stop_loss),
                    "take_profit": str(analysis.take_profit),
                    "risk_reward": str(analysis.risk_reward),
                    "expected_holding_hours": str(analysis.expected_holding_hours),
                    "candle_timestamp": analysis.candle_timestamp,
                    "session_status": analysis.session_status.value,
                },
            )
        ]


def _lookback_start(*, hours: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=max(hours, 1))).isoformat()
