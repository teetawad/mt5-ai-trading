"""Strategy-registry wrapper around analyze_crypto_multi_timeframe.

Mirrors strategy/intraday/strategy.py: fetches fresh 1h/15m/5m historical
bars on every call. Registry-based strategies only ever emit entry (BUY)
signals — the registered `Strategy.generate_signals` interface has no
portfolio/position context, so a SELL (position-close) decision cannot be
evaluated safely here. The dedicated `/crypto/analyze` endpoint (called
directly by the Node API, which does have portfolio context) is the actual
product path for bidirectional BUY/SELL/HOLD decisions — see routers/crypto.py.
"""

from datetime import UTC, datetime, timedelta

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from strategy.base import Strategy
from strategy.signal import Signal, SignalSide, SignalType

from .analysis import CryptoDecision, analyze_crypto_multi_timeframe
from .config import CryptoStrategyConfig

_TIMEFRAME_1H = "1Hour"
_TIMEFRAME_15M = "15Min"
_TIMEFRAME_5M = "5Min"


class CryptoMultiTimeframeStrategy(Strategy):
    """Long-only crypto entry strategy analyzing 1h/15m/5m together, 24/7.

    Emits BUY entry signals only. Exits (bracket SL/TP, or an explicit SELL
    decision from `/crypto/analyze` when a position is open) are handled
    downstream, not via this registry path.
    """

    def __init__(
        self,
        symbol: str,
        *,
        config: CryptoStrategyConfig | None = None,
        now_override: datetime | None = None,
    ) -> None:
        self._symbol = symbol.upper()
        self._config = config or CryptoStrategyConfig()
        self._now_override = now_override

    @property
    def name(self) -> str:
        return f"crypto_multi_timeframe_{self._symbol.replace('/', '_')}"

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

        analysis = analyze_crypto_multi_timeframe(
            symbol=self._symbol,
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=snapshot,
            config=self._config,
            has_open_position=False,
            now=self._now_override,
        )
        if analysis.decision != CryptoDecision.BUY:
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
                    "market_status": analysis.market_status,
                },
            )
        ]


def _lookback_start(*, hours: int) -> str:
    return (datetime.now(tz=UTC) - timedelta(hours=max(hours, 1))).isoformat()
