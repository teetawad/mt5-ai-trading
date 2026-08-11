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
        if params.kind != StrategyKind.MOVING_AVERAGE_CROSSOVER:
            raise BacktestError(f"Unsupported strategy kind: {params.kind}")
        if params.short_window >= params.long_window:
            raise BacktestError("short_window must be less than long_window")
        if params.quantity <= 0:
            raise BacktestError("quantity must be positive")
        self._params = params
        self._prices: deque[Decimal] = deque(maxlen=params.long_window)
        self._prev_short: Decimal | None = None
        self._prev_long: Decimal | None = None

    def on_bar_close(self, close_price: Decimal) -> BacktestSide | None:
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


def run_backtest(
    bars: list[MarketBar],
    strategy: StrategyParameters,
    config: BacktestConfig | None = None,
) -> BacktestResult:
    ordered = validate_bars(bars)
    cfg = config or BacktestConfig()
    if strategy.symbol.upper() != ordered[0].symbol.upper():
        raise BacktestError("Strategy symbol must match bar symbol")

    model = MovingAverageSignalModel(strategy)
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
            pending_signal = model.on_bar_close(bar.close)

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
