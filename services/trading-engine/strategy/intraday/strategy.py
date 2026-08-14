"""Strategy-registry wrapper around analyze_multi_timeframe.

Fetches fresh 1h/15m/5m historical bars on every call — the provider's
`get_historical_bars` already only returns bars up to "now", so no
additional statefulness (unlike the deque-based crossover strategies) is
required here.
"""

from datetime import UTC, datetime, timedelta

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from strategy.base import Strategy
from strategy.signal import Signal, SignalSide, SignalType

from .analysis import IntradayDecision, analyze_multi_timeframe
from .config import IntradayStrategyConfig

_TIMEFRAME_1H = "1Hour"
_TIMEFRAME_15M = "15Min"
_TIMEFRAME_5M = "5Min"


class IntradayMultiTimeframeStrategy(Strategy):
    """Long-only intraday entry strategy analyzing 1h/15m/5m together.

    Emits BUY entry signals only. Exits (bracket SL/TP, maximum holding
    time, end-of-day force-close) are handled automatically downstream, not
    via a second SELL signal from this strategy — see docs/PAPER_BROKER.md.
    """

    def __init__(
        self,
        symbol: str,
        *,
        config: IntradayStrategyConfig | None = None,
        now_override: datetime | None = None,
    ) -> None:
        self._symbol = symbol.upper()
        self._config = config or IntradayStrategyConfig()
        # Test-only override for "now" (mirrors risk.engine.evaluate's _now
        # param) — live callers never set this, so session gating always
        # reflects the real current time.
        self._now_override = now_override

    @property
    def name(self) -> str:
        return f"intraday_multi_timeframe_{self._symbol}"

    def generate_signals(self, market_data: MarketDataProvider) -> list[Signal]:
        try:
            snapshot = market_data.get_snapshot(self._symbol)
            bars_1h = market_data.get_historical_bars(
                self._symbol,
                timeframe=_TIMEFRAME_1H,
                start=_lookback_start(hours=self._config.required_1h_bars * 2),
                limit=self._config.required_1h_bars + 5,
            )
            bars_15m = market_data.get_historical_bars(
                self._symbol,
                timeframe=_TIMEFRAME_15M,
                start=_lookback_start(hours=self._config.required_15m_bars // 2 + 2),
                limit=self._config.required_15m_bars + 5,
            )
            bars_5m = market_data.get_historical_bars(
                self._symbol,
                timeframe=_TIMEFRAME_5M,
                start=_lookback_start(hours=self._config.required_5m_bars // 6 + 2),
                limit=self._config.required_5m_bars + 5,
            )
        except SymbolNotFoundError:
            return []
        except NotImplementedError:
            return []

        analysis = analyze_multi_timeframe(
            symbol=self._symbol,
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=snapshot,
            config=self._config,
            now=self._now_override,
        )
        if analysis.decision != IntradayDecision.BUY:
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
                    "setup_momentum_pct": str(analysis.setup_momentum_pct),
                    "entry_momentum_pct": str(analysis.entry_momentum_pct),
                    "volume_signal": analysis.volume_signal,
                    "atr": str(analysis.atr),
                    "stop_loss": str(analysis.stop_loss),
                    "take_profit": str(analysis.take_profit),
                    "risk_reward": str(analysis.risk_reward),
                    "expected_holding_minutes": str(analysis.expected_holding_minutes),
                    "session_status": analysis.session_status.value,
                },
            )
        ]


def _lookback_start(*, hours: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=max(hours, 1))).isoformat()
