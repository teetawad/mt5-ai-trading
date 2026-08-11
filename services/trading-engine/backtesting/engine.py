from __future__ import annotations

import math
from collections import deque
from decimal import Decimal

from market_data.snapshot import MarketBar

from .types import (
    BacktestConfig,
    BacktestMetrics,
    BacktestResult,
    BacktestSide,
    BacktestTrade,
    StrategyKind,
    StrategyParameters,
)


class BacktestError(ValueError):
    pass


def validate_bars(bars: list[MarketBar]) -> list[MarketBar]:
    if len(bars) < 2:
        raise BacktestError("At least two bars are required")
    ordered = sorted(bars, key=lambda bar: bar.timestamp)
    for prev, current in zip(ordered, ordered[1:], strict=False):
        if current.timestamp <= prev.timestamp:
            raise BacktestError("Bars must have unique increasing timestamps")
        if current.symbol != ordered[0].symbol:
            raise BacktestError("Backtests require a single symbol series")
    return ordered


class MovingAverageSignalModel:
    def __init__(self, params: StrategyParameters) -> None:
        if params.short_window >= params.long_window:
            raise BacktestError("short_window must be less than long_window")
        if params.quantity <= 0:
            raise BacktestError("quantity must be positive")
        self._params = params
        self._prices: deque[Decimal] = deque(maxlen=params.long_window)
        self._prev_short: Decimal | None = None
        self._prev_long: Decimal | None = None

    def on_bar_close(self, bar: MarketBar) -> BacktestSide | None:
        close_price = bar.close
        self._prices.append(close_price)
        if len(self._prices) < self._params.long_window:
            return None

        prices = list(self._prices)
        short = sum(prices[-self._params.short_window :]) / Decimal(self._params.short_window)
        long = sum(prices) / Decimal(self._params.long_window)
        side: BacktestSide | None = None

        if self._prev_short is not None and self._prev_long is not None:
            if self._prev_short <= self._prev_long and short > long:
                side = BacktestSide.BUY
            elif self._prev_short >= self._prev_long and short < long:
                side = BacktestSide.SELL

        self._prev_short = short
        self._prev_long = long
        return side


class USStockFactorSignalModel:
    """Trend, momentum, volatility, volume, and MA filter model.

    Signals are computed only from bars that have already closed. The backtest
    engine executes returned signals on the next bar open.
    """

    def __init__(self, params: StrategyParameters) -> None:
        _validate_factor_params(params)
        self._params = params
        self._closes: deque[Decimal] = deque(maxlen=_required_history(params) + 1)
        self._volumes: deque[int] = deque(maxlen=params.volume_window + 1)
        self._in_position = False

    def on_bar_close(self, bar: MarketBar) -> BacktestSide | None:
        self._closes.append(bar.close)
        self._volumes.append(bar.volume)
        if len(self._closes) < _required_history(self._params) + 1:
            return None
        if len(self._volumes) < self._params.volume_window + 1:
            return None

        features = _features(self._params, list(self._closes), list(self._volumes))
        entry = (
            features["trend_pct"] >= self._params.min_trend_pct
            and features["momentum_pct"] >= self._params.min_momentum_pct
            and features["volatility_pct"] <= self._params.max_volatility_pct
            and features["volume_ratio"] >= self._params.min_volume_ratio
            and features["fast_ma"] > features["slow_ma"]
        )
        exit_rule = (
            features["trend_pct"] <= self._params.exit_trend_pct
            or features["momentum_pct"] <= self._params.exit_momentum_pct
            or features["fast_ma"] < features["slow_ma"]
        )

        if not self._in_position and entry:
            self._in_position = True
            return BacktestSide.BUY
        if self._in_position and exit_rule:
            self._in_position = False
            return BacktestSide.SELL
        return None


def _validate_factor_params(params: StrategyParameters) -> None:
    windows = [
        params.short_window,
        params.long_window,
        params.trend_window,
        params.momentum_window,
        params.volatility_window,
        params.volume_window,
    ]
    if any(window < 2 for window in windows):
        raise BacktestError("All factor windows must be at least 2")
    if params.short_window >= params.long_window:
        raise BacktestError("short_window must be less than long_window")
    if params.quantity <= 0:
        raise BacktestError("quantity must be positive")
    if params.max_volatility_pct < 0:
        raise BacktestError("max_volatility_pct must be non-negative")
    if params.min_volume_ratio < 0:
        raise BacktestError("min_volume_ratio must be non-negative")


def _required_history(params: StrategyParameters) -> int:
    return max(
        params.long_window,
        params.trend_window,
        params.momentum_window,
        params.volatility_window,
    )


def _features(
    params: StrategyParameters,
    closes: list[Decimal],
    volumes: list[int],
) -> dict[str, Decimal]:
    current = closes[-1]
    trend_base = closes[-1 - params.trend_window]
    momentum_base = closes[-1 - params.momentum_window]
    fast_prices = closes[-params.short_window :]
    slow_prices = closes[-params.long_window :]
    previous_volumes = volumes[-1 - params.volume_window : -1]

    returns = [
        (current_close / previous_close) - Decimal("1")
        for previous_close, current_close in zip(
            closes[-1 - params.volatility_window : -1],
            closes[-params.volatility_window :],
            strict=False,
        )
        if previous_close != 0
    ]
    return {
        "trend_pct": _pct_change(current, trend_base),
        "momentum_pct": _pct_change(current, momentum_base),
        "volatility_pct": _decimal_std(returns) * Decimal("100"),
        "volume_ratio": Decimal(volumes[-1]) / _avg_int(previous_volumes),
        "fast_ma": sum(fast_prices, Decimal("0")) / Decimal(params.short_window),
        "slow_ma": sum(slow_prices, Decimal("0")) / Decimal(params.long_window),
    }


def _pct_change(current: Decimal, previous: Decimal) -> Decimal:
    if previous == 0:
        return Decimal("0")
    return (current / previous - Decimal("1")) * Decimal("100")


def _avg_int(values: list[int]) -> Decimal:
    if not values:
        return Decimal("1")
    avg = Decimal(sum(values)) / Decimal(len(values))
    return avg if avg > 0 else Decimal("1")


def _decimal_std(values: list[Decimal]) -> Decimal:
    if len(values) < 2:
        return Decimal("0")
    floats = [float(value) for value in values]
    mean = sum(floats) / len(floats)
    variance = sum((value - mean) ** 2 for value in floats) / (len(floats) - 1)
    return Decimal(str(math.sqrt(variance)))


def _signal_model(
    strategy: StrategyParameters,
) -> MovingAverageSignalModel | USStockFactorSignalModel:
    if strategy.kind == StrategyKind.MOVING_AVERAGE_CROSSOVER:
        return MovingAverageSignalModel(strategy)
    if strategy.kind == StrategyKind.US_STOCK_FACTOR:
        return USStockFactorSignalModel(strategy)
    raise BacktestError(f"Unsupported strategy kind: {strategy.kind}")


def run_backtest(
    bars: list[MarketBar],
    strategy: StrategyParameters,
    config: BacktestConfig | None = None,
) -> BacktestResult:
    ordered = validate_bars(bars)
    cfg = config or BacktestConfig()
    if strategy.symbol.upper() != ordered[0].symbol.upper():
        raise BacktestError("Strategy symbol must match bar symbol")

    model = _signal_model(strategy)
    cash = cfg.initial_cash
    position = Decimal("0")
    pending_signal: BacktestSide | None = None
    trades: list[BacktestTrade] = []
    equity_curve: list[Decimal] = []

    for index, bar in enumerate(ordered):
        if pending_signal is not None:
            cash, position, trade = _execute_signal(
                side=pending_signal,
                bar=bar,
                quantity=strategy.quantity,
                cash=cash,
                position=position,
                config=cfg,
            )
            if trade is not None:
                trades.append(trade)
            pending_signal = None

        equity_curve.append(cash + position * bar.close)

        if index < len(ordered) - 1:
            pending_signal = model.on_bar_close(bar)

    final_equity = equity_curve[-1]
    benchmark_final = _benchmark_final_equity(ordered, cfg.initial_cash)
    return BacktestResult(
        strategy=strategy,
        config=cfg,
        start=ordered[0].timestamp,
        end=ordered[-1].timestamp,
        final_equity=final_equity,
        benchmark_final_equity=benchmark_final,
        metrics=calculate_metrics(
            equity_curve=equity_curve,
            benchmark_final_equity=benchmark_final,
            initial_cash=cfg.initial_cash,
            trades=trades,
        ),
        trades=trades,
        equity_curve=equity_curve,
    )


def _execute_signal(
    *,
    side: BacktestSide,
    bar: MarketBar,
    quantity: Decimal,
    cash: Decimal,
    position: Decimal,
    config: BacktestConfig,
) -> tuple[Decimal, Decimal, BacktestTrade | None]:
    slippage = config.slippage_bps / Decimal("10000")
    price_multiplier = (
        Decimal("1") + slippage if side == BacktestSide.BUY else Decimal("1") - slippage
    )
    price = bar.open * price_multiplier
    fee = max(quantity * config.fee_per_share, config.min_fee)

    if side == BacktestSide.BUY:
        cost = quantity * price + fee
        if cash < cost:
            return cash, position, None
        cash -= cost
        position += quantity
    else:
        sell_quantity = min(quantity, position)
        if sell_quantity <= 0:
            return cash, position, None
        fee = max(sell_quantity * config.fee_per_share, config.min_fee)
        cash += sell_quantity * price - fee
        position -= sell_quantity
        quantity = sell_quantity

    return cash, position, BacktestTrade(
        timestamp=bar.timestamp,
        side=side,
        quantity=quantity,
        price=price,
        fee=fee,
        cash_after=cash,
        position_after=position,
    )


def _benchmark_final_equity(bars: list[MarketBar], initial_cash: Decimal) -> Decimal:
    shares = initial_cash / bars[0].open
    return shares * bars[-1].close


def calculate_metrics(
    *,
    equity_curve: list[Decimal],
    benchmark_final_equity: Decimal,
    initial_cash: Decimal,
    trades: list[BacktestTrade],
) -> BacktestMetrics:
    total_return = (equity_curve[-1] / initial_cash - Decimal("1")) * Decimal("100")
    benchmark_return = (benchmark_final_equity / initial_cash - Decimal("1")) * Decimal("100")
    returns = [
        (current / previous) - Decimal("1")
        for previous, current in zip(equity_curve, equity_curve[1:], strict=False)
        if previous != 0
    ]
    max_drawdown = _max_drawdown(equity_curve)
    sharpe = _sharpe_ratio(returns)
    wins, losses = _round_trip_pnls(trades)
    win_rate = (
        Decimal(len(wins)) / Decimal(len(wins) + len(losses)) * Decimal("100")
        if wins or losses
        else Decimal("0")
    )
    profit_factor = (
        sum(wins, Decimal("0")) / abs(sum(losses, Decimal("0")))
        if losses
        else (None if not wins else Decimal("999999999"))
    )
    return BacktestMetrics(
        total_return_pct=total_return,
        benchmark_return_pct=benchmark_return,
        max_drawdown_pct=max_drawdown,
        sharpe_ratio=sharpe,
        win_rate_pct=win_rate,
        profit_factor=profit_factor,
        trade_count=len(trades),
    )


def _max_drawdown(equity_curve: list[Decimal]) -> Decimal:
    peak = equity_curve[0]
    worst = Decimal("0")
    for equity in equity_curve:
        peak = max(peak, equity)
        if peak > 0:
            drawdown = (peak - equity) / peak * Decimal("100")
            worst = max(worst, drawdown)
    return worst


def _sharpe_ratio(returns: list[Decimal]) -> Decimal:
    if len(returns) < 2:
        return Decimal("0")
    float_returns = [float(item) for item in returns]
    mean = sum(float_returns) / len(float_returns)
    variance = sum((item - mean) ** 2 for item in float_returns) / (len(float_returns) - 1)
    std = math.sqrt(variance)
    if std == 0:
        return Decimal("0")
    return Decimal(str((mean / std) * math.sqrt(252)))


def _round_trip_pnls(trades: list[BacktestTrade]) -> tuple[list[Decimal], list[Decimal]]:
    open_buy: BacktestTrade | None = None
    wins: list[Decimal] = []
    losses: list[Decimal] = []
    for trade in trades:
        if trade.side == BacktestSide.BUY:
            open_buy = trade
        elif trade.side == BacktestSide.SELL and open_buy is not None:
            pnl = (trade.price - open_buy.price) * trade.quantity - trade.fee - open_buy.fee
            if pnl > 0:
                wins.append(pnl)
            else:
                losses.append(pnl)
            open_buy = None
    return wins, losses
