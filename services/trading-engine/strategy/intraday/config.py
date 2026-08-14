"""Configuration for the intraday multi-timeframe strategy (Phase 25).

All thresholds are read-only inputs to signal generation. Position sizing,
per-symbol/day trade counters, and daily loss limits are enforced downstream
(Node phase25 risk controls + the Python risk engine), not here.
"""

from decimal import Decimal


class IntradaySessionConfig:
    """Regular US market session gating, expressed in UTC "HH:MM" strings to
    match the convention already used by RiskConfig.trading_session_start/end.

    Callers are responsible for supplying UTC-equivalent times for the
    regular 09:30-16:00 America/New_York session (accounting for DST); this
    config does not perform timezone conversion itself.
    """

    def __init__(
        self,
        *,
        market_open: str = "13:30",
        market_close: str = "20:00",
        no_new_trades_minutes_before_close: int = 15,
        force_close_before_close_minutes: int = 5,
        force_close_enabled: bool = True,
    ) -> None:
        if no_new_trades_minutes_before_close < 0:
            raise ValueError("no_new_trades_minutes_before_close must be non-negative")
        if force_close_before_close_minutes < 0:
            raise ValueError("force_close_before_close_minutes must be non-negative")
        if force_close_before_close_minutes > no_new_trades_minutes_before_close:
            raise ValueError(
                "force_close_before_close_minutes must not exceed"
                " no_new_trades_minutes_before_close"
            )
        self.market_open = market_open
        self.market_close = market_close
        self.no_new_trades_minutes_before_close = no_new_trades_minutes_before_close
        self.force_close_before_close_minutes = force_close_before_close_minutes
        self.force_close_enabled = force_close_enabled


class IntradayStrategyConfig:
    """Multi-timeframe entry parameters.

    trend (1h)  -> direction filter, via EMA fast/slow on 1h closes
    setup (15m) -> momentum + volume must agree with the 1h trend
    entry (5m)  -> momentum + volume timing trigger
    """

    def __init__(
        self,
        *,
        trend_ema_fast: int = 8,
        trend_ema_slow: int = 21,
        setup_momentum_window: int = 6,
        setup_volume_window: int = 20,
        entry_momentum_window: int = 3,
        entry_volume_window: int = 20,
        atr_window: int = 14,
        stop_atr_multiple: Decimal = Decimal("1.5"),
        take_profit_atr_multiple: Decimal = Decimal("3.0"),
        min_risk_reward: Decimal = Decimal("1.5"),
        max_spread_pct: Decimal = Decimal("0.5"),
        min_volume_ratio: Decimal = Decimal("1.0"),
        max_holding_minutes: int = 120,
        quantity: Decimal = Decimal("1"),
        session: IntradaySessionConfig | None = None,
    ) -> None:
        windows = [
            trend_ema_fast,
            trend_ema_slow,
            setup_momentum_window,
            setup_volume_window,
            entry_momentum_window,
            entry_volume_window,
            atr_window,
        ]
        if any(window < 2 for window in windows):
            raise ValueError("All indicator windows must be at least 2")
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
        if max_holding_minutes <= 0:
            raise ValueError("max_holding_minutes must be positive")
        if quantity <= 0:
            raise ValueError("quantity must be positive")

        self.trend_ema_fast = trend_ema_fast
        self.trend_ema_slow = trend_ema_slow
        self.setup_momentum_window = setup_momentum_window
        self.setup_volume_window = setup_volume_window
        self.entry_momentum_window = entry_momentum_window
        self.entry_volume_window = entry_volume_window
        self.atr_window = atr_window
        self.stop_atr_multiple = stop_atr_multiple
        self.take_profit_atr_multiple = take_profit_atr_multiple
        self.min_risk_reward = min_risk_reward
        self.max_spread_pct = max_spread_pct
        self.min_volume_ratio = min_volume_ratio
        self.max_holding_minutes = max_holding_minutes
        self.quantity = quantity
        self.session = session or IntradaySessionConfig()

    @property
    def required_1h_bars(self) -> int:
        return self.trend_ema_slow + 1

    @property
    def required_15m_bars(self) -> int:
        return max(self.setup_momentum_window, self.setup_volume_window) + 1

    @property
    def required_5m_bars(self) -> int:
        return max(self.entry_momentum_window, self.entry_volume_window, self.atr_window) + 1
