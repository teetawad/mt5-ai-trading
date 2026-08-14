"""Configuration for the crypto multi-timeframe strategy (Phase 26).

Same 1h-trend/15m-setup/5m-entry structure as
strategy/intraday/config.py::IntradayStrategyConfig, minus session gating —
crypto markets trade 24/7, so there is no market-open/close window to
configure. Position sizing, per-symbol/day trade counters, and loss limits
are enforced downstream (Node phase26 risk controls), not here.
"""

from decimal import Decimal


class CryptoStrategyConfig:
    """Multi-timeframe parameters, bidirectional (BUY entries / SELL exits).

    trend (1h)  -> direction filter, via EMA fast/slow on 1h closes
    setup (15m) -> momentum + volume must agree with the 1h trend direction
    entry (5m)  -> momentum + volume timing trigger, same direction
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
        max_spread_pct: Decimal = Decimal("0.75"),
        min_volume_ratio: Decimal = Decimal("1.0"),
        quantity: Decimal = Decimal("0.01"),
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
        self.quantity = quantity

    @property
    def required_1h_bars(self) -> int:
        return self.trend_ema_slow + 1

    @property
    def required_15m_bars(self) -> int:
        return max(self.setup_momentum_window, self.setup_volume_window) + 1

    @property
    def required_5m_bars(self) -> int:
        return max(self.entry_momentum_window, self.entry_volume_window, self.atr_window) + 1
