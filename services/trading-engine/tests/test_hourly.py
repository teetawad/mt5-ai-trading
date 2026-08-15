"""Tests for the Phase 27 hourly single-timeframe strategy layer.

All tests run without a database or network connection.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.hourly.analysis import (
    HourlyDecision,
    TrendDirection,
    analyze_hourly,
)
from strategy.hourly.config import HourlyStrategyConfig
from strategy.hourly.strategy import HourlyTrendStrategy
from strategy.intraday.bars import resample_closed_bars
from strategy.signal import SignalSide

TEST_INTERNAL_TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def _internal_service_token(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TEST_INTERNAL_TOKEN)


# ── Helpers ───────────────────────────────────────────────────────────────────

SESSION_NOW = datetime(2024, 1, 2, 15, 0, tzinfo=UTC)  # 15:00 UTC: mid-session


def _bars(
    n: int,
    step_minutes: int,
    start_price: Decimal,
    drift: Decimal,
    *,
    end: datetime = SESSION_NOW,
    symbol: str = "AAPL",
    volume: int = 100_000,
) -> list[MarketBar]:
    bars = []
    price = start_price
    t = end - timedelta(minutes=step_minutes * n)
    for _ in range(n):
        t = t + timedelta(minutes=step_minutes)
        open_price = price
        price = price * (Decimal("1") + drift)
        close_price = price
        bars.append(
            MarketBar(
                symbol=symbol,
                open=open_price,
                high=max(open_price, close_price) + Decimal("0.05"),
                low=min(open_price, close_price) - Decimal("0.05"),
                close=close_price,
                volume=volume,
                timestamp=t,
            )
        )
    return bars


def _snapshot(bars: list[MarketBar], *, spread_pct: Decimal = Decimal("0.1")) -> MarketSnapshot:
    price = bars[-1].close
    half_spread = price * spread_pct / Decimal("200")
    return MarketSnapshot(
        symbol=bars[-1].symbol,
        price=price,
        bid=price - half_spread,
        ask=price + half_spread,
        volume=bars[-1].volume,
        timestamp=bars[-1].timestamp,
        is_stale=False,
    )


def _uptrend(cfg: HourlyStrategyConfig) -> list[MarketBar]:
    return _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0.003"))


def _downtrend(cfg: HourlyStrategyConfig) -> list[MarketBar]:
    return _bars(cfg.required_1h_bars + 5, 60, Decimal("200"), Decimal("-0.003"))


def _flat(cfg: HourlyStrategyConfig) -> list[MarketBar]:
    return _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0"))


# ── HourlyStrategyConfig ─────────────────────────────────────────────────────

class TestHourlyStrategyConfig:
    def test_required_1h_bars_covers_higher_timeframe_window(self):
        cfg = HourlyStrategyConfig(
            trend_ema_slow=21, higher_tf_bars_per_candle=4, breakout_lookback_bars=20
        )
        # Must be enough underlying 1h bars to fill trend_ema_slow+1 higher-tf buckets.
        assert cfg.required_1h_bars >= 4 * 22

    def test_breakout_lookback_bars_must_be_at_least_two(self):
        with pytest.raises(ValueError):
            HourlyStrategyConfig(breakout_lookback_bars=1)

    def test_higher_tf_bars_per_candle_must_be_at_least_one(self):
        with pytest.raises(ValueError):
            HourlyStrategyConfig(higher_tf_bars_per_candle=0)

    def test_trend_ema_fast_must_be_less_than_slow(self):
        with pytest.raises(ValueError):
            HourlyStrategyConfig(trend_ema_fast=21, trend_ema_slow=8)

    def test_default_session_uses_hourly_close_buffers(self):
        cfg = HourlyStrategyConfig()
        assert cfg.session.no_new_trades_minutes_before_close == 60
        assert cfg.session.force_close_before_close_minutes == 30


# ── resample_closed_bars (first live use of BarResampler outside backtesting) ─

class TestHigherTimeframeResampling:
    def test_too_few_bars_to_fill_one_bucket_yields_no_higher_tf_bars(self):
        bars = _bars(3, 60, Decimal("100"), Decimal("0.001"))
        assert resample_closed_bars(bars, group_size=10) == []

    def test_exact_multiple_yields_expected_bucket_count(self):
        bars = _bars(8, 60, Decimal("100"), Decimal("0.001"))
        merged = resample_closed_bars(bars, group_size=4)
        assert len(merged) == 2
        assert merged[0].close == bars[3].close
        assert merged[1].close == bars[7].close


# ── analyze_hourly ────────────────────────────────────────────────────────────

class TestAnalyzeHourly:
    def test_confirmed_uptrend_yields_buy_with_bracket(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _uptrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            has_open_position=False,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.BUY
        assert result.trend_direction == TrendDirection.UP
        assert result.stop_loss is not None
        assert result.take_profit is not None
        assert result.stop_loss < result.entry_price < result.take_profit
        assert result.risk_reward >= cfg.min_risk_reward
        assert result.higher_tf_confirmed is True
        assert result.breakout is True
        assert result.candle_timestamp == bars_1h[-1].timestamp.isoformat()
        assert result.strategy_version == "27.0.0"
        assert 0.5 <= result.confidence <= 1.0

    def test_confirmed_downtrend_closes_open_position_with_sell(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _downtrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            has_open_position=True,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.SELL
        assert result.trend_direction == TrendDirection.DOWN
        # SELL is an exit, not a new risk-budgeted entry — no new bracket.
        assert result.stop_loss is None
        assert result.take_profit is None

    def test_downtrend_without_open_position_holds(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _downtrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            has_open_position=False,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD
        assert any("no open position to close" in reason for reason in result.reasons)

    def test_uptrend_with_open_position_holds_not_a_second_buy(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _uptrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            has_open_position=True,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD

    def test_flat_series_holds(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _flat(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD
        assert result.confidence < 0.5

    def test_insufficient_history_holds_with_reason(self):
        cfg = HourlyStrategyConfig()
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=[],
            snapshot=_snapshot(_bars(1, 60, Decimal("100"), Decimal("0"))),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD
        assert any("Insufficient" in reason for reason in result.reasons)
        assert result.confidence == 0.0

    def test_session_gating_blocks_entry_even_with_perfect_trend(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _uptrend(cfg)
        near_close = bars_1h[-1].timestamp.replace(hour=19, minute=45, second=0, microsecond=0)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=near_close,
        )
        assert result.decision == HourlyDecision.HOLD
        assert result.session_status.value != "OPEN_FOR_ENTRIES"

    def test_wide_spread_blocks_entry(self):
        cfg = HourlyStrategyConfig(max_spread_pct=Decimal("0.05"))
        bars_1h = _uptrend(cfg)
        wide_snapshot = _snapshot(bars_1h, spread_pct=Decimal("5"))
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=wide_snapshot,
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD
        assert not result.liquidity_ok

    def test_min_risk_reward_can_reject_an_otherwise_valid_setup(self):
        cfg = HourlyStrategyConfig(min_risk_reward=Decimal("999"))
        bars_1h = _uptrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == HourlyDecision.HOLD
        assert any("Risk/reward" in reason for reason in result.reasons)

    def test_higher_tf_confirmation_disabled_always_self_confirms(self):
        cfg = HourlyStrategyConfig(higher_tf_confirmation_required=False)
        bars_1h = _uptrend(cfg)
        result = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.higher_tf_confirmed is True

    def test_future_bars_are_ignored_no_look_ahead(self):
        """A bar timestamped after `now` must never influence the decision —
        even one engineered to flip an otherwise-HOLD flat series into an
        obvious uptrend."""
        cfg = HourlyStrategyConfig()
        bars_1h = _flat(cfg)

        baseline = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=SESSION_NOW,
        )
        assert baseline.decision == HourlyDecision.HOLD

        future_bar = MarketBar(
            symbol="AAPL",
            open=Decimal("100"),
            high=Decimal("500"),
            low=Decimal("100"),
            close=Decimal("500"),
            volume=10_000_000,
            timestamp=SESSION_NOW + timedelta(hours=1),
        )
        with_future = analyze_hourly(
            symbol="AAPL",
            bars_1h=[*bars_1h, future_bar],
            snapshot=_snapshot(bars_1h),
            config=cfg,
            now=SESSION_NOW,
        )
        assert with_future.decision == baseline.decision == HourlyDecision.HOLD
        assert with_future.trend_strength_pct == baseline.trend_strength_pct
        assert with_future.candle_timestamp == baseline.candle_timestamp

    def test_confidence_increases_with_risk_reward_margin(self):
        marginal_cfg = HourlyStrategyConfig(
            take_profit_atr_multiple=Decimal("2.4"), min_risk_reward=Decimal("1.5")
        )
        comfortable_cfg = HourlyStrategyConfig(
            take_profit_atr_multiple=Decimal("9.0"), min_risk_reward=Decimal("1.5")
        )
        bars_1h = _uptrend(marginal_cfg)

        marginal = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=marginal_cfg,
            now=SESSION_NOW,
        )
        comfortable = analyze_hourly(
            symbol="AAPL",
            bars_1h=bars_1h,
            snapshot=_snapshot(bars_1h),
            config=comfortable_cfg,
            now=SESSION_NOW,
        )
        assert marginal.decision == comfortable.decision == HourlyDecision.BUY
        assert comfortable.confidence > marginal.confidence
        assert comfortable.confidence <= 1.0


# ── HourlyTrendStrategy (registry wrapper) ──────────────────────────────────

class _SingleTimeframeMD(MarketDataProvider):
    def __init__(self, symbol: str, bars_1h: list[MarketBar], snapshot: MarketSnapshot) -> None:
        self._symbol = symbol
        self._bars_1h = bars_1h
        self._snapshot = snapshot

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol != self._symbol:
            raise SymbolNotFoundError(symbol)
        return self._snapshot

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self._snapshot]

    def tracked_symbols(self) -> list[str]:
        return [self._symbol]

    def get_historical_bars(self, symbol, *, timeframe, start, end=None, limit=100):
        if symbol != self._symbol:
            raise SymbolNotFoundError(symbol)
        assert timeframe == "1Hour"
        return self._bars_1h[-limit:]


class TestHourlyTrendStrategy:
    def test_emits_buy_signal_on_confirmed_uptrend(self):
        cfg = HourlyStrategyConfig(quantity=Decimal("5"))
        bars_1h = _uptrend(cfg)
        md = _SingleTimeframeMD("AAPL", bars_1h, _snapshot(bars_1h))
        strategy = HourlyTrendStrategy("AAPL", config=cfg, now_override=SESSION_NOW)

        signals = strategy.generate_signals(md)

        assert len(signals) == 1
        assert signals[0].side == SignalSide.BUY
        assert signals[0].quantity == Decimal("5")
        assert "candle_timestamp" in signals[0].metadata

    def test_no_signal_on_hold(self):
        cfg = HourlyStrategyConfig()
        bars_1h = _flat(cfg)
        md = _SingleTimeframeMD("AAPL", bars_1h, _snapshot(bars_1h))
        strategy = HourlyTrendStrategy("AAPL", config=cfg, now_override=SESSION_NOW)

        assert strategy.generate_signals(md) == []

    def test_unknown_symbol_returns_no_signals(self):
        cfg = HourlyStrategyConfig()
        strategy = HourlyTrendStrategy("ZZZZZ", config=cfg)
        placeholder = _snapshot(_bars(1, 60, Decimal("100"), Decimal("0")))
        md = _SingleTimeframeMD("AAPL", [], placeholder)

        assert strategy.generate_signals(md) == []


# ── /hourly/analyze endpoint ─────────────────────────────────────────────────

class TestHourlyAnalyzeEndpoint:
    def test_returns_analysis_for_known_symbol(self):
        from market_data.registry import init_provider

        cfg = HourlyStrategyConfig()
        bars_1h = _uptrend(cfg)
        init_provider(_SingleTimeframeMD("AAPL", bars_1h, _snapshot(bars_1h)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/hourly/analyze",
            json={"symbol": "AAPL", "now": SESSION_NOW.isoformat()},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "AAPL"
        assert body["decision"] == "BUY"
        assert body["strategy_version"] == "27.0.0"
        assert "candle_timestamp" in body

    def test_unknown_symbol_returns_404(self):
        from market_data.registry import init_provider

        placeholder = _snapshot(_bars(1, 60, Decimal("100"), Decimal("0")))
        init_provider(_SingleTimeframeMD("AAPL", [], placeholder))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post("/hourly/analyze", json={"symbol": "ZZZZZ"})
        assert res.status_code == 404

    def test_requires_internal_token(self):
        from market_data.registry import init_provider

        cfg = HourlyStrategyConfig()
        bars_1h = _uptrend(cfg)
        init_provider(_SingleTimeframeMD("AAPL", bars_1h, _snapshot(bars_1h)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.post("/hourly/analyze", json={"symbol": "AAPL"})
        assert res.status_code == 403

    def test_has_open_position_true_evaluates_sell_side(self):
        from market_data.registry import init_provider

        cfg = HourlyStrategyConfig()
        bars_1h = _downtrend(cfg)
        init_provider(_SingleTimeframeMD("AAPL", bars_1h, _snapshot(bars_1h)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/hourly/analyze",
            json={"symbol": "AAPL", "has_open_position": True, "now": SESSION_NOW.isoformat()},
        )
        assert res.status_code == 200
        assert res.json()["decision"] == "SELL"
