"""Tests for research-only backtesting.

Backtests must not submit paper orders or use future bars for signal decisions.
"""

import ast
import pathlib
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from backtesting.engine import BacktestError, run_backtest
from backtesting.types import (
    BacktestConfig,
    BacktestMetrics,
    BacktestSide,
    StrategyKind,
    StrategyParameters,
)
from backtesting.validation import selection_score, train_test_split, walk_forward_validate
from market_data.snapshot import MarketBar

BACKTESTING_DIR = pathlib.Path(__file__).parent.parent / "backtesting"


def _bars(closes: list[str], *, opens: list[str] | None = None) -> list[MarketBar]:
    start = datetime(2026, 1, 2, 14, 30, tzinfo=UTC)
    open_values = opens or closes
    return [
        MarketBar(
            symbol="AAPL",
            open=Decimal(open_values[index]),
            high=Decimal(close) + Decimal("1"),
            low=Decimal(close) - Decimal("1"),
            close=Decimal(close),
            volume=1000 + index,
            timestamp=start + timedelta(minutes=index),
        )
        for index, close in enumerate(closes)
    ]


def _params(short: int = 2, long: int = 3, quantity: str = "10") -> StrategyParameters:
    return StrategyParameters(
        symbol="AAPL",
        short_window=short,
        long_window=long,
        quantity=Decimal(quantity),
    )


def _factor_params(
    *,
    min_volume_ratio: str = "1",
    max_volatility_pct: str = "100",
) -> StrategyParameters:
    return StrategyParameters(
        kind=StrategyKind.US_STOCK_FACTOR,
        symbol="AAPL",
        short_window=2,
        long_window=3,
        trend_window=3,
        momentum_window=2,
        volatility_window=3,
        volume_window=3,
        min_trend_pct=Decimal("5"),
        min_momentum_pct=Decimal("3"),
        max_volatility_pct=Decimal(max_volatility_pct),
        min_volume_ratio=Decimal(min_volume_ratio),
        exit_trend_pct=Decimal("0"),
        exit_momentum_pct=Decimal("0"),
        quantity=Decimal("10"),
    )


class TestBacktestEngine:
    def test_runs_deterministic_historical_backtest_with_metrics(self) -> None:
        bars = _bars(["10", "10", "10", "15", "20", "12", "8", "8"])

        result = run_backtest(bars, _params(), BacktestConfig(initial_cash=Decimal("1000")))

        assert result.start == bars[0].timestamp
        assert result.end == bars[-1].timestamp
        assert result.metrics.trade_count == 2
        assert result.metrics.total_return_pct != Decimal("0")
        assert result.metrics.benchmark_return_pct == Decimal("-20.0")
        assert result.metrics.max_drawdown_pct >= 0
        assert result.metrics.win_rate_pct >= 0

    def test_executes_signal_on_next_bar_open_to_prevent_lookahead(self) -> None:
        bars = _bars(
            ["10", "10", "10", "20", "30"],
            opens=["10", "10", "10", "100", "111"],
        )

        result = run_backtest(bars, _params(), BacktestConfig(initial_cash=Decimal("10000")))

        assert result.trades[0].side == BacktestSide.BUY
        assert result.trades[0].timestamp == bars[4].timestamp
        assert result.trades[0].price == Decimal("111")

    def test_last_bar_signal_is_not_executed_without_future_bar(self) -> None:
        bars = _bars(["10", "10", "10", "20"])

        result = run_backtest(bars, _params(), BacktestConfig(initial_cash=Decimal("10000")))

        assert result.trades == []

    def test_transaction_fees_and_slippage_are_applied(self) -> None:
        bars = _bars(
            ["10", "10", "10", "20", "30"],
            opens=["10", "10", "10", "100", "100"],
        )
        config = BacktestConfig(
            initial_cash=Decimal("10000"),
            fee_per_share=Decimal("0.01"),
            min_fee=Decimal("2"),
            slippage_bps=Decimal("100"),
        )

        result = run_backtest(bars, _params(quantity="10"), config)

        assert result.trades[0].price == Decimal("101.00")
        assert result.trades[0].fee == Decimal("2")
        assert result.trades[0].cash_after == Decimal("8988.00")

    def test_rejects_mixed_symbols_and_invalid_windows(self) -> None:
        bars = _bars(["10", "11"])
        bars[1] = bars[1].model_copy(update={"symbol": "MSFT"})

        with pytest.raises(BacktestError, match="single symbol"):
            run_backtest(bars, _params())

        with pytest.raises(BacktestError, match="short_window"):
            run_backtest(_bars(["10", "11", "12"]), _params(short=3, long=3))

    def test_us_stock_factor_backtest_uses_configurable_entry_exit_rules(self) -> None:
        bars = _bars(["10", "10", "10", "11", "12", "13", "9", "8"])

        result = run_backtest(bars, _factor_params(), BacktestConfig(initial_cash=Decimal("10000")))

        assert [trade.side for trade in result.trades] == [BacktestSide.BUY, BacktestSide.SELL]
        assert result.trades[0].timestamp == bars[4].timestamp
        assert result.trades[1].timestamp == bars[7].timestamp
        assert result.metrics.benchmark_return_pct == Decimal("-20.0")

    def test_factor_signal_executes_on_next_open_to_prevent_lookahead(self) -> None:
        bars = _bars(
            ["10", "10", "10", "11", "12"],
            opens=["10", "10", "10", "999", "44"],
        )

        result = run_backtest(bars, _factor_params(), BacktestConfig(initial_cash=Decimal("10000")))

        assert result.trades[0].timestamp == bars[4].timestamp
        assert result.trades[0].price == Decimal("44")

    def test_factor_volume_and_volatility_filters_can_block_entries(self) -> None:
        bars = _bars(["10", "10", "10", "11", "12"])

        no_volume = run_backtest(
            bars,
            _factor_params(min_volume_ratio="2"),
            BacktestConfig(initial_cash=Decimal("10000")),
        )
        no_volatility = run_backtest(
            bars,
            _factor_params(max_volatility_pct="0.01"),
            BacktestConfig(initial_cash=Decimal("10000")),
        )

        assert no_volume.trades == []
        assert no_volatility.trades == []


class TestValidation:
    def test_train_test_split_preserves_time_order_and_excludes_overlap(self) -> None:
        bars = _bars([str(10 + index) for index in range(10)])

        train, test = train_test_split(bars, train_fraction=0.6)

        assert len(train) == 6
        assert len(test) == 4
        assert train[-1].timestamp < test[0].timestamp

    def test_walk_forward_uses_train_window_before_test_window(self) -> None:
        bars = _bars([str(10 + index) for index in range(18)])
        candidates = [_params(short=2, long=3), _params(short=3, long=5)]

        result = walk_forward_validate(
            bars,
            candidates=candidates,
            train_size=8,
            test_size=4,
            step_size=4,
        )

        assert len(result.folds) == 2
        for fold in result.folds:
            assert fold.split.train_end < fold.split.test_start
            assert fold.split.train_indices[1] == fold.split.test_indices[0]
            assert fold.selected_parameters in candidates

    def test_walk_forward_rejects_too_little_data(self) -> None:
        with pytest.raises(BacktestError, match="Not enough bars"):
            walk_forward_validate(
                _bars(["10", "11", "12"]),
                candidates=[_params()],
                train_size=3,
                test_size=2,
            )

    def test_selection_score_is_not_total_return_only(self) -> None:
        high_return_high_drawdown = BacktestMetrics(
            total_return_pct=Decimal("20"),
            benchmark_return_pct=Decimal("5"),
            max_drawdown_pct=Decimal("50"),
            sharpe_ratio=Decimal("0"),
            win_rate_pct=Decimal("10"),
            profit_factor=Decimal("1"),
            trade_count=4,
        )
        lower_return_better_risk = BacktestMetrics(
            total_return_pct=Decimal("12"),
            benchmark_return_pct=Decimal("5"),
            max_drawdown_pct=Decimal("2"),
            sharpe_ratio=Decimal("2"),
            win_rate_pct=Decimal("60"),
            profit_factor=Decimal("2"),
            trade_count=4,
        )

        assert selection_score(lower_return_better_risk) > selection_score(
            high_return_high_drawdown
        )


class TestBacktestingBoundary:
    def test_backtesting_does_not_import_broker_or_routers(self) -> None:
        for path in BACKTESTING_DIR.glob("*.py"):
            if path.name == "__init__.py":
                continue
            tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    assert not module.startswith("broker")
                    assert not module.startswith("routers")
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        assert not alias.name.startswith("broker")
                        assert not alias.name.startswith("routers")
