from market_data.snapshot import MarketBar

from .engine import BacktestError, run_backtest
from .types import (
    BacktestConfig,
    BacktestMetrics,
    StrategyParameters,
    TimeSplit,
    WalkForwardFoldResult,
    WalkForwardResult,
)


def train_test_split(
    bars: list[MarketBar],
    *,
    train_fraction: float,
) -> tuple[list[MarketBar], list[MarketBar]]:
    if not 0 < train_fraction < 1:
        raise BacktestError("train_fraction must be between 0 and 1")
    ordered = sorted(bars, key=lambda bar: bar.timestamp)
    split_index = int(len(ordered) * train_fraction)
    if split_index < 2 or len(ordered) - split_index < 2:
        raise BacktestError("Train and test splits must each contain at least two bars")
    return ordered[:split_index], ordered[split_index:]


def walk_forward_validate(
    bars: list[MarketBar],
    *,
    candidates: list[StrategyParameters],
    train_size: int,
    test_size: int,
    step_size: int | None = None,
    config: BacktestConfig | None = None,
) -> WalkForwardResult:
    if not candidates:
        raise BacktestError("At least one candidate strategy is required")
    if train_size < 2 or test_size < 2:
        raise BacktestError("train_size and test_size must be at least 2")

    ordered = sorted(bars, key=lambda bar: bar.timestamp)
    step = step_size or test_size
    folds: list[WalkForwardFoldResult] = []
    start = 0
    while start + train_size + test_size <= len(ordered):
        train_start = start
        train_end = start + train_size
        test_start = train_end
        test_end = test_start + test_size
        train_bars = ordered[train_start:train_end]
        test_bars = ordered[test_start:test_end]

        ranked = []
        for candidate in candidates:
            result = run_backtest(train_bars, candidate, config)
            ranked.append((selection_score(result.metrics), candidate))
        _, selected = max(ranked, key=lambda item: item[0])
        train_result = run_backtest(train_bars, selected, config)
        test_result = run_backtest(test_bars, selected, config)
        folds.append(
            WalkForwardFoldResult(
                split=TimeSplit(
                    train_start=train_bars[0].timestamp,
                    train_end=train_bars[-1].timestamp,
                    test_start=test_bars[0].timestamp,
                    test_end=test_bars[-1].timestamp,
                    train_indices=(train_start, train_end),
                    test_indices=(test_start, test_end),
                ),
                selected_parameters=selected,
                train_metrics=train_result.metrics,
                test_metrics=test_result.metrics,
            )
        )
        start += step

    if not folds:
        raise BacktestError("Not enough bars for one walk-forward fold")
    return WalkForwardResult(folds=folds)


def selection_score(metrics: BacktestMetrics) -> float:
    """Risk-adjusted train score for walk-forward parameter selection.

    This deliberately does not optimize only historical return. It rewards
    return, Sharpe, win rate, and profit factor while penalizing drawdown and
    no-trade candidates.
    """

    profit_factor = metrics.profit_factor if metrics.profit_factor is not None else 0
    trade_penalty = 5 if metrics.trade_count == 0 else 0
    return (
        float(metrics.total_return_pct)
        - float(metrics.max_drawdown_pct)
        + float(metrics.sharpe_ratio) * 2
        + float(metrics.win_rate_pct) * 0.05
        + min(float(profit_factor), 10.0)
        - trade_penalty
    )
