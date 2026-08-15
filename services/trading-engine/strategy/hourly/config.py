"""Configuration for the hourly trend strategy (Phase 27).

Single primary timeframe (1H) — a higher timeframe (N closed 1H bars folded
into one, see strategy.intraday.bars.resample_closed_bars) may only CONFIRM
or VETO a signal, never trigger one on its own. Position sizing,
per-symbol/day trade counters, and daily loss limits are enforced downstream
(Node phase27 risk controls + the Python risk engine), not here.
"""

from decimal import Decimal

from strategy.intraday.config import IntradaySessionConfig


class HourlyStrategyConfig:
    """Single-timeframe entry/exit parameters.

    trend (1h)       -> direction filter, via EMA fast/slow on 1h closes
    structure (1h)   -> momentum + volume must agree with the trend;
                        breakout/pullback computed for diagnostics
    higher timeframe -> optional confirmation-only veto, resampled from the
                        same closed 1h series (never triggers on its own)
    """

    def __init__(
        self,
        *,
        trend_ema_fast: int = 8,
        trend_ema_slow: int = 21,
        momentum_window: int = 3,
        volume_window: int = 20,
        breakout_lookback_bars: int = 20,
        min_volume_ratio: Decimal = Decimal("1.0"),
        atr_window: int = 14,
        stop_atr_multiple: Decimal = Decimal("1.5"),
        take_profit_atr_multiple: Decimal = Decimal("3.0"),
        min_risk_reward: Decimal = Decimal("1.5"),
        max_spread_pct: Decimal = Decimal("0.5"),
        higher_tf_bars_per_candle: int = 4,
        higher_tf_confirmation_required: bool = True,
        max_holding_hours: int = 8,
        quantity: Decimal = Decimal("1"),
        session: IntradaySessionConfig | None = None,
    ) -> None:
        windows = [trend_ema_fast, trend_ema_slow, momentum_window, volume_window, atr_window]
        if any(window < 2 for window in windows):
            raise ValueError("All indicator windows must be at least 2")
        if breakout_lookback_bars < 2:
            raise ValueError("breakout_lookback_bars must be at least 2")
        if trend_ema_fast >= trend_ema_slow:
            raise ValueError("trend_ema_fast must be less than trend_ema_slow")
        if stop_atr_multiple <= 0:
            raise ValueError("stop_atr_multiple must be positive")
        if take_profit_atr_multiple <= 0:
            raise ValueError("take_profit_atr_multiple must be positive")
        if min_risk_reward <= 0:
            raise ValueError("min_risk_reward must be positive")
        if max_spread_pct < 0:
            raise ValueError("max_spread_pct must be non-negative")
        if min_volume_ratio < 0:
            raise ValueError("min_volume_ratio must be non-negative")
        if higher_tf_bars_per_candle < 1:
            raise ValueError("higher_tf_bars_per_candle must be at least 1")
        if max_holding_hours <= 0:
            raise ValueError("max_holding_hours must be positive")
        if quantity <= 0:
            raise ValueError("quantity must be positive")

        self.trend_ema_fast = trend_ema_fast
        self.trend_ema_slow = trend_ema_slow
        self.momentum_window = momentum_window
        self.volume_window = volume_window
        self.breakout_lookback_bars = breakout_lookback_bars
        self.min_volume_ratio = min_volume_ratio
        self.atr_window = atr_window
        self.stop_atr_multiple = stop_atr_multiple
        self.take_profit_atr_multiple = take_profit_atr_multiple
        self.min_risk_reward = min_risk_reward
        self.max_spread_pct = max_spread_pct
        self.higher_tf_bars_per_candle = higher_tf_bars_per_candle
        self.higher_tf_confirmation_required = higher_tf_confirmation_required
        self.max_holding_hours = max_holding_hours
        self.quantity = quantity
        # 60/30-minute close buffers (vs intraday's 15/5) — hourly entries
        # stop a full candle before close, and force-close half an hour out,
        # since a hopeful hourly entry near the bell has nowhere to run.
        self.session = session or IntradaySessionConfig(
            no_new_trades_minutes_before_close=60,
            force_close_before_close_minutes=30,
        )

    @property
    def required_1h_bars(self) -> int:
        return max(
            self.trend_ema_slow + 1,
            self.breakout_lookback_bars + 1,
            self.atr_window + 1,
            self.momentum_window + 1,
            self.volume_window + 1,
            self.higher_tf_bars_per_candle * (self.trend_ema_slow + 1),
        )
