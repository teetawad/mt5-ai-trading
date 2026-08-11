from __future__ import annotations

import csv
import json
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal
from pathlib import Path

from market_data.snapshot import MarketBar

from .types import BacktestConfig, BacktestMetrics, StrategyKind, StrategyParameters
from .validation import selection_score, walk_forward_validate


@dataclass(frozen=True)
class StrategyPerformance:
    name: str
    kind: StrategyKind
    candidate_count: int
    fold_count: int
    selected_parameters: list[str]
    metrics: BacktestMetrics
    benchmark_return_pct: Decimal
    stability_positive_fold_pct: Decimal
    stability_return_std_pct: Decimal
    train_test_return_gap_pct: Decimal
    overfitting_flags: list[str]
    recommendation: str


def load_csv_bars(path: str | Path, symbol: str) -> list[MarketBar]:
    bars: list[MarketBar] = []
    with open(path, newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            bars.append(
                MarketBar(
                    symbol=symbol.upper(),
                    open=Decimal(row["open"]),
                    high=Decimal(row["high"]),
                    low=Decimal(row["low"]),
                    close=Decimal(row["close"]),
                    volume=int(row["volume"]),
                    timestamp=datetime.fromisoformat(row["timestamp"].replace("Z", "+00:00")),
                )
            )
    return bars


def default_strategy_candidates(symbol: str) -> dict[str, list[StrategyParameters]]:
    symbol = symbol.upper()
    return {
        "moving_average_crossover": [
            StrategyParameters(
                kind=StrategyKind.MOVING_AVERAGE_CROSSOVER,
                symbol=symbol,
                short_window=2,
                long_window=3,
                quantity=Decimal("10"),
            ),
            StrategyParameters(
                kind=StrategyKind.MOVING_AVERAGE_CROSSOVER,
                symbol=symbol,
                short_window=3,
                long_window=5,
                quantity=Decimal("10"),
            ),
            StrategyParameters(
                kind=StrategyKind.MOVING_AVERAGE_CROSSOVER,
                symbol=symbol,
                short_window=5,
                long_window=8,
                quantity=Decimal("10"),
            ),
        ],
        "us_stock_factor": [
            StrategyParameters(
                kind=StrategyKind.US_STOCK_FACTOR,
                symbol=symbol,
                short_window=2,
                long_window=3,
                trend_window=3,
                momentum_window=2,
                volatility_window=3,
                volume_window=3,
                min_trend_pct=Decimal("0.5"),
                min_momentum_pct=Decimal("0.25"),
                max_volatility_pct=Decimal("5"),
                min_volume_ratio=Decimal("0.6"),
                exit_trend_pct=Decimal("-0.5"),
                exit_momentum_pct=Decimal("-0.25"),
                quantity=Decimal("10"),
            ),
            StrategyParameters(
                kind=StrategyKind.US_STOCK_FACTOR,
                symbol=symbol,
                short_window=3,
                long_window=5,
                trend_window=5,
                momentum_window=3,
                volatility_window=5,
                volume_window=5,
                min_trend_pct=Decimal("1"),
                min_momentum_pct=Decimal("0.5"),
                max_volatility_pct=Decimal("4"),
                min_volume_ratio=Decimal("0.8"),
                exit_trend_pct=Decimal("0"),
                exit_momentum_pct=Decimal("0"),
                quantity=Decimal("10"),
            ),
            StrategyParameters(
                kind=StrategyKind.US_STOCK_FACTOR,
                symbol=symbol,
                short_window=5,
                long_window=8,
                trend_window=8,
                momentum_window=5,
                volatility_window=8,
                volume_window=8,
                min_trend_pct=Decimal("1.5"),
                min_momentum_pct=Decimal("0.75"),
                max_volatility_pct=Decimal("3"),
                min_volume_ratio=Decimal("1"),
                exit_trend_pct=Decimal("0"),
                exit_momentum_pct=Decimal("0"),
                quantity=Decimal("10"),
            ),
        ],
    }


def evaluate_strategy_family(
    *,
    name: str,
    bars: list[MarketBar],
    candidates: list[StrategyParameters],
    train_size: int,
    test_size: int,
    step_size: int,
    config: BacktestConfig,
) -> StrategyPerformance:
    wf = walk_forward_validate(
        bars,
        candidates=candidates,
        train_size=train_size,
        test_size=test_size,
        step_size=step_size,
        config=config,
    )
    test_metrics = [fold.test_metrics for fold in wf.folds]
    train_metrics = [fold.train_metrics for fold in wf.folds]
    aggregate = aggregate_metrics(test_metrics)
    benchmark_return = _avg([metric.benchmark_return_pct for metric in test_metrics])
    test_returns = [metric.total_return_pct for metric in test_metrics]
    train_returns = [metric.total_return_pct for metric in train_metrics]
    positive_fold_pct = (
        Decimal(sum(1 for value in test_returns if value > 0))
        / Decimal(len(test_returns))
        * Decimal("100")
    )
    return_std = _std(test_returns)
    train_test_gap = _avg(train_returns) - _avg(test_returns)
    flags = overfitting_flags(
        metrics=aggregate,
        train_test_return_gap_pct=train_test_gap,
        stability_positive_fold_pct=positive_fold_pct,
        stability_return_std_pct=return_std,
    )
    return StrategyPerformance(
        name=name,
        kind=candidates[0].kind,
        candidate_count=len(candidates),
        fold_count=len(wf.folds),
        selected_parameters=[
            fold.selected_parameters.model_dump_json() for fold in wf.folds
        ],
        metrics=aggregate,
        benchmark_return_pct=benchmark_return,
        stability_positive_fold_pct=positive_fold_pct,
        stability_return_std_pct=return_std,
        train_test_return_gap_pct=train_test_gap,
        overfitting_flags=flags,
        recommendation=recommendation(aggregate, flags, positive_fold_pct),
    )


def aggregate_metrics(metrics: list[BacktestMetrics]) -> BacktestMetrics:
    if not metrics:
        raise ValueError("At least one metric set is required")
    return BacktestMetrics(
        total_return_pct=_compound([metric.total_return_pct for metric in metrics]),
        annualized_return_pct=_avg([metric.annualized_return_pct for metric in metrics]),
        benchmark_return_pct=_compound([metric.benchmark_return_pct for metric in metrics]),
        max_drawdown_pct=max(metric.max_drawdown_pct for metric in metrics),
        sharpe_ratio=_avg([metric.sharpe_ratio for metric in metrics]),
        win_rate_pct=_avg([metric.win_rate_pct for metric in metrics]),
        profit_factor=_avg_optional([metric.profit_factor for metric in metrics]),
        average_win=_avg_optional([metric.average_win for metric in metrics]),
        average_loss=_avg_optional([metric.average_loss for metric in metrics]),
        exposure_pct=_avg([metric.exposure_pct for metric in metrics]),
        trade_count=sum(metric.trade_count for metric in metrics),
    )


def overfitting_flags(
    *,
    metrics: BacktestMetrics,
    train_test_return_gap_pct: Decimal,
    stability_positive_fold_pct: Decimal,
    stability_return_std_pct: Decimal,
) -> list[str]:
    flags: list[str] = []
    if train_test_return_gap_pct > Decimal("10"):
        flags.append("large train/test return gap")
    if stability_positive_fold_pct < Decimal("50"):
        flags.append("less than half of out-of-sample folds profitable")
    if stability_return_std_pct > max(Decimal("5"), abs(metrics.total_return_pct) * Decimal("2")):
        flags.append("unstable out-of-sample returns")
    if metrics.trade_count < 2:
        flags.append("too few trades for confidence")
    if metrics.max_drawdown_pct > Decimal("20"):
        flags.append("drawdown above paper-testing threshold")
    if metrics.profit_factor is not None and metrics.profit_factor < Decimal("1"):
        flags.append("profit factor below 1")
    return flags


def recommendation(
    metrics: BacktestMetrics,
    flags: list[str],
    positive_fold_pct: Decimal,
) -> str:
    if flags:
        return "DO NOT CONTINUE PAPER TESTING"
    if metrics.total_return_pct <= 0 or positive_fold_pct < Decimal("60"):
        return "WATCHLIST ONLY"
    return "SAFE TO CONTINUE PAPER TESTING"


def evaluate_all_strategies(
    bars: list[MarketBar],
    *,
    symbol: str,
    train_size: int = 8,
    test_size: int = 4,
    step_size: int = 4,
    config: BacktestConfig | None = None,
) -> list[StrategyPerformance]:
    cfg = config or BacktestConfig(
        initial_cash=Decimal("100000"),
        fee_per_share=Decimal("0.005"),
        min_fee=Decimal("1"),
        slippage_bps=Decimal("5"),
        periods_per_year=252,
    )
    return [
        evaluate_strategy_family(
            name=name,
            bars=bars,
            candidates=candidates,
            train_size=train_size,
            test_size=test_size,
            step_size=step_size,
            config=cfg,
        )
        for name, candidates in default_strategy_candidates(symbol).items()
    ]


def render_performance_report(
    performances: list[StrategyPerformance],
    *,
    symbol: str,
) -> str:
    ranked = sorted(
        performances,
        key=lambda item: (
            item.recommendation == "SAFE TO CONTINUE PAPER TESTING",
            selection_score(item.metrics),
        ),
        reverse=True,
    )
    lines = [
        "# Phase 19 PAPER Strategy Performance Report",
        "",
        f"Symbol: {symbol.upper()}",
        "Mode: PAPER ONLY",
        "",
        "No live trading or real-money execution was used or added.",
        "",
        (
            "| Strategy | Recommendation | Total Return | Annualized | Max DD | Sharpe | "
            "Win Rate | Profit Factor | Avg Win | Avg Loss | Trades | Exposure | "
            "Benchmark | Stability | Flags |"
        ),
        (
            "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | "
            "---: | ---: | ---: | ---: | --- |"
        ),
    ]
    for item in ranked:
        metric = item.metrics
        lines.append(
            "| "
            + " | ".join(
                [
                    item.name,
                    item.recommendation,
                    _pct(metric.total_return_pct),
                    _pct(metric.annualized_return_pct),
                    _pct(metric.max_drawdown_pct),
                    _dec(metric.sharpe_ratio),
                    _pct(metric.win_rate_pct),
                    _nullable(metric.profit_factor),
                    _nullable(metric.average_win),
                    _nullable(metric.average_loss),
                    str(metric.trade_count),
                    _pct(metric.exposure_pct),
                    _pct(item.benchmark_return_pct),
                    _pct(item.stability_positive_fold_pct),
                    ", ".join(item.overfitting_flags) if item.overfitting_flags else "-",
                ]
            )
            + " |"
        )
    lines.extend(
        [
            "",
            (
                "Recommendation policy: continue PAPER testing only when out-of-sample "
                "folds are stable, risk-adjusted metrics are acceptable, and "
                "overfitting flags are absent. Highest historical profit alone is "
                "not a selection criterion."
            ),
            "",
        ]
    )
    return "\n".join(lines)


def write_performance_reports(
    performances: list[StrategyPerformance],
    *,
    symbol: str,
    report_dir: str | Path,
) -> tuple[Path, Path]:
    directory = Path(report_dir)
    directory.mkdir(parents=True, exist_ok=True)
    markdown_path = directory / "PHASE_19_STRATEGY_PERFORMANCE.md"
    json_path = directory / "phase19-strategy-performance.json"
    markdown_path.write_text(
        render_performance_report(performances, symbol=symbol),
        encoding="utf-8",
    )
    json_path.write_text(
        json.dumps([_performance_dict(item) for item in performances], indent=2),
        encoding="utf-8",
    )
    return markdown_path, json_path


def _performance_dict(item: StrategyPerformance) -> dict[str, object]:
    return {
        "name": item.name,
        "kind": item.kind,
        "candidate_count": item.candidate_count,
        "fold_count": item.fold_count,
        "metrics": item.metrics.model_dump(mode="json"),
        "benchmark_return_pct": str(item.benchmark_return_pct),
        "stability_positive_fold_pct": str(item.stability_positive_fold_pct),
        "stability_return_std_pct": str(item.stability_return_std_pct),
        "train_test_return_gap_pct": str(item.train_test_return_gap_pct),
        "overfitting_flags": item.overfitting_flags,
        "recommendation": item.recommendation,
        "selected_parameters": item.selected_parameters,
    }


def _compound(values: list[Decimal]) -> Decimal:
    result = Decimal("1")
    for value in values:
        result *= Decimal("1") + value / Decimal("100")
    return (result - Decimal("1")) * Decimal("100")


def _avg(values: list[Decimal]) -> Decimal:
    return sum(values, Decimal("0")) / Decimal(len(values))


def _avg_optional(values: list[Decimal | None]) -> Decimal | None:
    present = [value for value in values if value is not None]
    return _avg(present) if present else None


def _std(values: list[Decimal]) -> Decimal:
    if len(values) < 2:
        return Decimal("0")
    float_values = [float(value) for value in values]
    mean = sum(float_values) / len(float_values)
    variance = sum((value - mean) ** 2 for value in float_values) / (len(float_values) - 1)
    return Decimal(str(variance**0.5))


def _pct(value: Decimal) -> str:
    return f"{value.quantize(Decimal('0.01'))}%"


def _dec(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.01")))


def _nullable(value: Decimal | None) -> str:
    return "-" if value is None else _dec(value)


def main() -> None:
    root = Path(__file__).resolve().parents[3]
    symbol = "AAPL"
    bars = load_csv_bars(
        root / "services" / "trading-engine" / "data" / "market_data" / f"{symbol}.csv",
        symbol,
    )
    train_size = max(4, min(8, len(bars) // 2))
    test_size = max(2, min(4, (len(bars) - train_size) // 2))
    performances = evaluate_all_strategies(
        bars,
        symbol=symbol,
        train_size=train_size,
        test_size=test_size,
        step_size=test_size,
    )
    markdown_path, json_path = write_performance_reports(
        performances,
        symbol=symbol,
        report_dir=root / "docs" / "reports",
    )
    print(f"Phase 19 report: {markdown_path}")
    print(f"Phase 19 JSON: {json_path}")


if __name__ == "__main__":
    main()
