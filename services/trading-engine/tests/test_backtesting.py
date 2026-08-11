"""Tests for research-only backtesting.

Backtests must not submit paper orders or use future bars for signal decisions.
"""

import ast
import pathlib
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from backtesting.engine import BacktestError, run_backtest
from backtesting.types import BacktestConfig, BacktestSide, StrategyParameters
from backtesting.validation import train_test_split, walk_forward_validate
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
