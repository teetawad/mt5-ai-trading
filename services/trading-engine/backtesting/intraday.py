"""Intraday multi-timeframe backtesting (Phase 25).

Walks a single 5-minute bar series (or a coarser primary granularity — see
`entry_timeframe_minutes`), deriving closed 15m/1h bars via BarResampler so
no look-ahead is possible: a higher-timeframe bar only exists once fully
covered by finer bars already processed, and every trading decision is made
using only bars up to the *current* primary bar, executed at the *next*
primary bar's open — the same look-ahead-safe convention as
backtesting.engine.run_backtest.

`compare_intraday_timeframes` runs the same 5m bar series through three
primary granularities (5m/15m/1h) so their metrics can be compared side by
side, per Phase 25's requirement to evaluate 5m/15m/1h configurations.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, field_serializer

from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.intraday.analysis import (
    IntradayDecision,
    SessionStatus,
    analyze_multi_timeframe,
    session_status,
)
from strategy.intraday.bars import BarResampler, resample_closed_bars
from strategy.intraday.config import IntradayStrategyConfig

from .engine import BacktestError, calculate_metrics, validate_bars
from .types import BacktestConfig, BacktestMetrics, BacktestSide, BacktestTrade

_SESSION_MINUTES = 390  # 09:30-16:00 regular US session
_ENTRY_TIMEFRAMES_MINUTES = (5, 15, 60)


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class IntradayBacktestResult(BaseModel):
    entry_timeframe_minutes: int
    start: datetime
    end: datetime
    bar_count: int
    final_equity: Decimal
    benchmark_final_equity: Decimal
    metrics: BacktestMetrics
    trades: list[BacktestTrade]
    equity_curve: list[Decimal]

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("final_equity", "benchmark_final_equity")
    def _ser_dec(self, v: Decimal) -> str:
        return _money(v)

    @field_serializer("equity_curve")
    def _ser_curve(self, v: list[Decimal]) -> list[str]:
        return [_money(item) for item in v]


@dataclass
class _OpenPosition:
    quantity: Decimal
    stop_loss: Decimal
    take_profit: Decimal
    entered_at: datetime
    entered_index: int


def _bars_per_year(entry_timeframe_minutes: int) -> int:
    bars_per_day = max(_SESSION_MINUTES // entry_timeframe_minutes, 1)
    return bars_per_day * 252


def _benchmark_final_equity(bars: list[MarketBar], initial_cash: Decimal) -> Decimal:
    shares = initial_cash / bars[0].open
    return shares * bars[-1].close


def _snapshot_from_bar(bar: MarketBar) -> MarketSnapshot:
    return MarketSnapshot(
        symbol=bar.symbol,
        price=bar.close,
        bid=bar.close,
        ask=bar.close,
        volume=bar.volume,
        timestamp=bar.timestamp,
        is_stale=False,
    )


def _check_exit(
    bar: MarketBar, position: _OpenPosition, config: IntradayStrategyConfig
) -> Decimal | None:
    if bar.low <= position.stop_loss:
        return position.stop_loss
    if bar.high >= position.take_profit:
        return position.take_profit
    elapsed_minutes = (bar.timestamp - position.entered_at).total_seconds() / 60
    if elapsed_minutes >= config.max_holding_minutes:
        return bar.close
    if session_status(bar.timestamp, config) in (
        SessionStatus.FORCE_CLOSE_WINDOW,
        SessionStatus.CLOSED,
    ):
        return bar.close
    return None


def _fill(
    *, side: BacktestSide, quantity: Decimal, price: Decimal, timestamp: datetime,
    cash: Decimal, cfg: BacktestConfig,
) -> tuple[Decimal, BacktestTrade | None]:
    slippage = cfg.slippage_bps / Decimal("10000")
    multiplier = Decimal("1") + slippage if side == BacktestSide.BUY else Decimal("1") - slippage
    fill_price = price * multiplier
    fee = max(quantity * cfg.fee_per_share, cfg.min_fee)
    if side == BacktestSide.BUY:
        cost = quantity * fill_price + fee
        if cash < cost:
            return cash, None
        cash -= cost
    else:
        cash += quantity * fill_price - fee
    return cash, BacktestTrade(
        timestamp=timestamp,
        side=side,
        quantity=quantity,
        price=fill_price,
        fee=fee,
        cash_after=cash,
        position_after=quantity if side == BacktestSide.BUY else Decimal("0"),
    )


def run_intraday_backtest(
    bars_5m: list[MarketBar],
    config: IntradayStrategyConfig,
    backtest_config: BacktestConfig | None = None,
    *,
    entry_timeframe_minutes: int = 5,
) -> IntradayBacktestResult:
    if entry_timeframe_minutes not in _ENTRY_TIMEFRAMES_MINUTES:
        raise BacktestError("entry_timeframe_minutes must be one of 5, 15, 60")

    ordered_5m = validate_bars(bars_5m)
    cfg = backtest_config or BacktestConfig()

    primary_group = entry_timeframe_minutes // 5
    setup_group = max(15 // entry_timeframe_minutes, 1)
    trend_group = max(60 // entry_timeframe_minutes, 1)
    primary_bars = (
        resample_closed_bars(ordered_5m, primary_group) if primary_group > 1 else ordered_5m
    )
    if len(primary_bars) < 2:
        raise BacktestError(
            f"Not enough {entry_timeframe_minutes}m bars for a backtest"
            f" (have {len(primary_bars)})"
        )

    setup_resampler = BarResampler(setup_group)
    trend_resampler = BarResampler(trend_group)
    closed_entry: list[MarketBar] = []
    closed_setup: list[MarketBar] = []
    closed_trend: list[MarketBar] = []

    cash = cfg.initial_cash
    position: _OpenPosition | None = None
    trades: list[BacktestTrade] = []
    equity_curve: list[Decimal] = []
    exposure_periods = 0

    for index, bar in enumerate(primary_bars):
        if position is not None and index != position.entered_index:
            exit_price = _check_exit(bar, position, config)
            if exit_price is not None:
                cash, trade = _fill(
                    side=BacktestSide.SELL,
                    quantity=position.quantity,
                    price=exit_price,
                    timestamp=bar.timestamp,
                    cash=cash,
                    cfg=cfg,
                )
                if trade is not None:
                    trades.append(trade)
                position = None

        equity_curve.append(cash + (position.quantity * bar.close if position else Decimal("0")))
        if position is not None:
            exposure_periods += 1

        closed_entry.append(bar)
        merged_setup = setup_resampler.add(bar)
        if merged_setup is not None:
            closed_setup.append(merged_setup)
        merged_trend = trend_resampler.add(bar)
        if merged_trend is not None:
            closed_trend.append(merged_trend)

        if position is None and index < len(primary_bars) - 1:
            analysis = analyze_multi_timeframe(
                symbol=bar.symbol,
                bars_1h=closed_trend,
                bars_15m=closed_setup,
                bars_5m=closed_entry,
                snapshot=_snapshot_from_bar(bar),
                config=config,
                now=bar.timestamp,
            )
            if analysis.decision == IntradayDecision.BUY:
                next_bar = primary_bars[index + 1]
                cash, trade = _fill(
                    side=BacktestSide.BUY,
                    quantity=config.quantity,
                    price=next_bar.open,
                    timestamp=next_bar.timestamp,
                    cash=cash,
                    cfg=cfg,
                )
                if trade is not None:
                    trades.append(trade)
                    stop_loss = analysis.stop_loss or (next_bar.open - Decimal("0.01"))
                    take_profit = analysis.take_profit or (next_bar.open + Decimal("0.01"))
                    position = _OpenPosition(
                        quantity=config.quantity,
                        stop_loss=stop_loss,
                        take_profit=take_profit,
                        entered_at=next_bar.timestamp,
                        entered_index=index + 1,
                    )

    if position is not None:
        last_bar = primary_bars[-1]
        cash, trade = _fill(
            side=BacktestSide.SELL,
            quantity=position.quantity,
            price=last_bar.close,
            timestamp=last_bar.timestamp,
            cash=cash,
            cfg=cfg,
        )
        if trade is not None:
            trades.append(trade)
        equity_curve[-1] = cash
        exposure_periods = max(exposure_periods - 1, 0)

    final_equity = equity_curve[-1]
    benchmark_final = _benchmark_final_equity(primary_bars, cfg.initial_cash)
    metrics = calculate_metrics(
        equity_curve=equity_curve,
        benchmark_final_equity=benchmark_final,
        initial_cash=cfg.initial_cash,
        trades=trades,
        exposure_periods=exposure_periods,
        total_periods=len(equity_curve),
        periods_per_year=_bars_per_year(entry_timeframe_minutes),
    )
    return IntradayBacktestResult(
        entry_timeframe_minutes=entry_timeframe_minutes,
        start=primary_bars[0].timestamp,
        end=primary_bars[-1].timestamp,
        bar_count=len(primary_bars),
        final_equity=final_equity,
        benchmark_final_equity=benchmark_final,
        metrics=metrics,
        trades=trades,
        equity_curve=equity_curve,
    )


def compare_intraday_timeframes(
    bars_5m: list[MarketBar],
    config: IntradayStrategyConfig,
    backtest_config: BacktestConfig | None = None,
) -> dict[str, IntradayBacktestResult]:
    """Runs the same 5m bar series through 5m/15m/1h entry-timeframe
    configurations and returns their results keyed by label, so a caller can
    compare which granularity performed best over the same historical data.
    """
    labels = {5: "5m", 15: "15m", 60: "1h"}
    return {
        labels[minutes]: run_intraday_backtest(
            bars_5m, config, backtest_config, entry_timeframe_minutes=minutes
        )
        for minutes in _ENTRY_TIMEFRAMES_MINUTES
    }
