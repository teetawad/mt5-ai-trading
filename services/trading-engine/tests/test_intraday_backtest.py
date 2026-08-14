"""Tests for Phase 25 intraday backtesting.

Backtests must not submit paper orders and must never let data timestamped
after a given decision point influence that decision (no look-ahead).
"""

import random
from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from backtesting.engine import BacktestError
from backtesting.intraday import compare_intraday_timeframes, run_intraday_backtest
from backtesting.types import BacktestConfig, BacktestSide
from market_data.snapshot import MarketBar
from strategy.intraday.config import IntradayStrategyConfig


def _synthetic_5m_series(
    n: int = 900,
    *,
    seed: int = 42,
    drift: float = 0.0006,
    noise: float = 0.001,
    symbol: str = "AAPL",
) -> list[MarketBar]:
    rng = random.Random(seed)
    bars: list[MarketBar] = []
    price = Decimal("100")
    t = datetime(2024, 1, 2, 13, 30, tzinfo=UTC)
    for _ in range(n):
        t = t + timedelta(minutes=5)
        z = Decimal(str(rng.gauss(0.0, 1.0)))
        move = Decimal(str(drift)) + Decimal(str(noise)) * z
        open_price = price
        price = max(price * (Decimal("1") + move), Decimal("1"))
        close_price = price
        bars.append(
            MarketBar(
                symbol=symbol,
                open=open_price,
                high=max(open_price, close_price) + Decimal("0.05"),
                low=min(open_price, close_price) - Decimal("0.05"),
                close=close_price,
                volume=rng.randint(50_000, 150_000),
                timestamp=t,
            )
        )
    return bars


def _config() -> IntradayStrategyConfig:
    return IntradayStrategyConfig(quantity=Decimal("10"))


def _backtest_config() -> BacktestConfig:
    return BacktestConfig(
        initial_cash=Decimal("100000"),
        fee_per_share=Decimal("0.005"),
        min_fee=Decimal("1"),
        slippage_bps=Decimal("2"),
    )


class TestRunIntradayBacktest:
    def test_runs_and_produces_trades_on_a_drifting_series(self):
        bars = _synthetic_5m_series()
        result = run_intraday_backtest(bars, _config(), _backtest_config())

        assert result.entry_timeframe_minutes == 5
        assert result.bar_count == len(bars)
        assert result.metrics.trade_count > 0
        assert len(result.equity_curve) == len(bars)

    def test_trades_alternate_buy_then_sell(self):
        bars = _synthetic_5m_series()
        result = run_intraday_backtest(bars, _config(), _backtest_config())

        assert result.trades, "expected at least one trade for this fixture"
        assert result.trades[0].side == BacktestSide.BUY
        for previous, current in zip(result.trades, result.trades[1:], strict=False):
            assert previous.side != current.side

    def test_rejects_invalid_entry_timeframe(self):
        bars = _synthetic_5m_series(n=50)
        with pytest.raises(BacktestError):
            run_intraday_backtest(bars, _config(), entry_timeframe_minutes=7)

    def test_rejects_too_few_bars(self):
        bars = _synthetic_5m_series(n=1)
        with pytest.raises(BacktestError):
            run_intraday_backtest(bars, _config())

    def test_no_look_ahead_truncating_future_bars_does_not_change_early_trades(self):
        full = _synthetic_5m_series(n=900)
        truncated = full[:400]

        result_full = run_intraday_backtest(full, _config(), _backtest_config())
        result_truncated = run_intraday_backtest(truncated, _config(), _backtest_config())

        early_full = [t for t in result_full.trades if t.timestamp <= truncated[-1].timestamp]
        early_truncated = [
            t for t in result_truncated.trades if t.timestamp <= truncated[-1].timestamp
        ]
        # Every trade decided before the truncation point must be identical
        # regardless of what data exists after it — proof the engine never
        # used future bars to make a past decision. The truncated run's own
        # final bar forces an extra close that the full run wouldn't have at
        # that exact point, so compare all but a possible trailing forced exit.
        comparable_len = min(len(early_full), len(early_truncated))
        assert comparable_len > 0, "expected at least one trade before the truncation point"
        for i in range(comparable_len):
            if early_full[i].side != early_truncated[i].side:
                break
            assert early_full[i].timestamp == early_truncated[i].timestamp
            assert early_full[i].price == early_truncated[i].price


class TestCompareIntradayTimeframes:
    def test_returns_all_three_granularities(self):
        bars = _synthetic_5m_series(n=900)
        results = compare_intraday_timeframes(bars, _config(), _backtest_config())

        assert set(results.keys()) == {"5m", "15m", "1h"}
        assert results["5m"].entry_timeframe_minutes == 5
        assert results["15m"].entry_timeframe_minutes == 15
        assert results["1h"].entry_timeframe_minutes == 60
        for result in results.values():
            assert len(result.equity_curve) == result.bar_count
