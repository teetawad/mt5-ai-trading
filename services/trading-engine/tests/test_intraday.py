"""Tests for the Phase 25 intraday multi-timeframe strategy layer.

All tests run without a database or network connection.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.intraday.analysis import (
    IntradayDecision,
    SessionStatus,
    TrendDirection,
    analyze_multi_timeframe,
    session_status,
)
from strategy.intraday.bars import BarResampler, resample_closed_bars
from strategy.intraday.config import IntradaySessionConfig, IntradayStrategyConfig
from strategy.intraday.indicators import atr, ema, roc_pct, stddev_pct, volume_ratio
from strategy.intraday.strategy import IntradayMultiTimeframeStrategy
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


_BarTriple = tuple[list[MarketBar], list[MarketBar], list[MarketBar]]


def _uptrend(cfg: IntradayStrategyConfig) -> _BarTriple:
    bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0.003"))
    bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("100"), Decimal("0.003"))
    bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("100"), Decimal("0.003"))
    return bars_1h, bars_15m, bars_5m


# ── indicators ────────────────────────────────────────────────────────────────

class TestIndicators:
    def test_ema_converges_toward_recent_values_in_a_trend(self):
        values = [Decimal(str(100 + i)) for i in range(30)]
        fast = ema(values, 5)
        slow = ema(values, 20)
        assert fast > slow  # in a steady uptrend, the faster EMA leads

    def test_roc_pct_positive_for_rising_series(self):
        values = [Decimal("100"), Decimal("101"), Decimal("102"), Decimal("104")]
        assert roc_pct(values, 3) > 0

    def test_roc_pct_raises_when_insufficient_history(self):
        with pytest.raises(ValueError):
            roc_pct([Decimal("100"), Decimal("101")], 5)

    def test_volume_ratio_above_one_when_latest_volume_spikes(self):
        volumes = [1000] * 20 + [5000]
        assert volume_ratio(volumes, 20) > Decimal("1")

    def test_atr_positive_for_bars_with_range(self):
        bars = _bars(20, 5, Decimal("100"), Decimal("0.001"))
        assert atr(bars, 14) > 0

    def test_stddev_pct_zero_for_flat_series(self):
        assert stddev_pct([Decimal("100")] * 5) == Decimal("0")


class TestBarResampler:
    def test_emits_only_once_group_is_full(self):
        resampler = BarResampler(3)
        bars = _bars(7, 5, Decimal("100"), Decimal("0.001"))
        emitted = [resampler.add(bar) for bar in bars]
        assert emitted[0] is None
        assert emitted[1] is None
        assert emitted[2] is not None  # 3rd bar closes the first 15m group
        assert emitted[3] is None
        assert emitted[4] is None
        assert emitted[5] is not None
        assert emitted[6] is None  # partial 3rd group never leaked

    def test_merged_bar_aggregates_ohlcv(self):
        bars = _bars(3, 5, Decimal("100"), Decimal("0.002"))
        [merged] = resample_closed_bars(bars, 3)
        assert merged.open == bars[0].open
        assert merged.close == bars[-1].close
        assert merged.high == max(b.high for b in bars)
        assert merged.low == min(b.low for b in bars)
        assert merged.volume == sum(b.volume for b in bars)
        assert merged.timestamp == bars[-1].timestamp


# ── session_status ───────────────────────────────────────────────────────────

class TestSessionStatus:
    def _config(self) -> IntradayStrategyConfig:
        return IntradayStrategyConfig(
            session=IntradaySessionConfig(
                market_open="13:30",
                market_close="20:00",
                no_new_trades_minutes_before_close=15,
                force_close_before_close_minutes=5,
            )
        )

    def test_mid_session_is_open_for_entries(self):
        cfg = self._config()
        now = datetime(2024, 1, 2, 15, 0, tzinfo=UTC)
        assert session_status(now, cfg) == SessionStatus.OPEN_FOR_ENTRIES

    def test_before_open_is_closed(self):
        cfg = self._config()
        now = datetime(2024, 1, 2, 12, 0, tzinfo=UTC)
        assert session_status(now, cfg) == SessionStatus.CLOSED

    def test_after_close_is_closed(self):
        cfg = self._config()
        now = datetime(2024, 1, 2, 20, 30, tzinfo=UTC)
        assert session_status(now, cfg) == SessionStatus.CLOSED

    def test_near_close_blocks_new_trades(self):
        cfg = self._config()
        now = datetime(2024, 1, 2, 19, 50, tzinfo=UTC)  # 10 min before 20:00 close
        assert session_status(now, cfg) == SessionStatus.NO_NEW_TRADES_NEAR_CLOSE

    def test_force_close_window_near_close(self):
        cfg = self._config()
        now = datetime(2024, 1, 2, 19, 57, tzinfo=UTC)  # 3 min before close
        assert session_status(now, cfg) == SessionStatus.FORCE_CLOSE_WINDOW


# ── analyze_multi_timeframe ──────────────────────────────────────────────────

class TestAnalyzeMultiTimeframe:
    def test_confirmed_uptrend_yields_buy_with_bracket(self):
        cfg = IntradayStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == IntradayDecision.BUY
        assert result.trend_direction == TrendDirection.UP
        assert result.stop_loss is not None
        assert result.take_profit is not None
        assert result.stop_loss < result.entry_price < result.take_profit
        assert result.risk_reward >= cfg.min_risk_reward
        assert 0.5 <= result.confidence <= 1.0

    def test_flat_series_holds(self):
        cfg = IntradayStrategyConfig()
        bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0"))
        bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("100"), Decimal("0"))
        bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("100"), Decimal("0"))
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == IntradayDecision.HOLD
        assert result.confidence < 0.5

    def test_insufficient_history_holds_with_reason(self):
        cfg = IntradayStrategyConfig()
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=[],
            bars_15m=[],
            bars_5m=[],
            snapshot=_snapshot(_bars(1, 5, Decimal("100"), Decimal("0"))),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == IntradayDecision.HOLD
        assert any("Insufficient" in reason for reason in result.reasons)
        assert result.confidence == 0.0

    def test_session_gating_blocks_entry_even_with_perfect_trend(self):
        cfg = IntradayStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        near_close = bars_5m[-1].timestamp.replace(hour=19, minute=59, second=0, microsecond=0)
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=near_close,
        )
        assert result.decision == IntradayDecision.HOLD
        assert result.session_status != SessionStatus.OPEN_FOR_ENTRIES

    def test_wide_spread_blocks_entry(self):
        cfg = IntradayStrategyConfig(max_spread_pct=Decimal("0.05"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        wide_snapshot = _snapshot(bars_5m, spread_pct=Decimal("5"))
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=wide_snapshot,
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == IntradayDecision.HOLD
        assert not result.liquidity_ok

    def test_min_risk_reward_can_reject_an_otherwise_valid_setup(self):
        cfg = IntradayStrategyConfig(min_risk_reward=Decimal("999"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        result = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=SESSION_NOW,
        )
        assert result.decision == IntradayDecision.HOLD
        assert any("Risk/reward" in reason for reason in result.reasons)

    def test_future_bars_are_ignored_no_look_ahead(self):
        """A bar timestamped after `now` must never influence the decision —
        even one engineered to flip an otherwise-HOLD flat series into an
        obvious uptrend."""
        cfg = IntradayStrategyConfig()
        bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0"))
        bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("100"), Decimal("0"))
        bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("100"), Decimal("0"))

        baseline = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=SESSION_NOW,
        )
        assert baseline.decision == IntradayDecision.HOLD

        future_bar = MarketBar(
            symbol="AAPL",
            open=Decimal("100"),
            high=Decimal("500"),
            low=Decimal("100"),
            close=Decimal("500"),
            volume=10_000_000,
            timestamp=SESSION_NOW + timedelta(hours=1),
        )
        with_future = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=[*bars_1h, future_bar],
            bars_15m=[*bars_15m, future_bar],
            bars_5m=[*bars_5m, future_bar],
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=SESSION_NOW,
        )
        assert with_future.decision == baseline.decision == IntradayDecision.HOLD
        assert with_future.trend_strength_pct == baseline.trend_strength_pct

    def test_confidence_increases_with_risk_reward_margin(self):
        """A BUY with a larger cushion above min_risk_reward should be a
        higher-confidence signal than one that only just clears it."""
        # Deliberately clear of the exact min_risk_reward boundary (rather
        # than testing equality against it) — ATR is itself an average of
        # true ranges and rarely divides out to a perfectly clean decimal,
        # so an exact-equality margin case is a precision trap, not a
        # meaningful assertion.
        marginal_cfg = IntradayStrategyConfig(
            take_profit_atr_multiple=Decimal("2.4"), min_risk_reward=Decimal("1.5")
        )
        comfortable_cfg = IntradayStrategyConfig(
            take_profit_atr_multiple=Decimal("9.0"), min_risk_reward=Decimal("1.5")
        )
        bars_1h, bars_15m, bars_5m = _uptrend(marginal_cfg)

        marginal = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=marginal_cfg,
            now=SESSION_NOW,
        )
        comfortable = analyze_multi_timeframe(
            symbol="AAPL",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=comfortable_cfg,
            now=SESSION_NOW,
        )
        assert marginal.decision == comfortable.decision == IntradayDecision.BUY
        assert comfortable.confidence > marginal.confidence
        assert 0.5 <= marginal.confidence < 0.6
        assert comfortable.confidence <= 1.0


# ── IntradayMultiTimeframeStrategy (registry wrapper) ───────────────────────

class _MultiTimeframeMD(MarketDataProvider):
    def __init__(
        self,
        symbol: str,
        bars_1h: list[MarketBar],
        bars_15m: list[MarketBar],
        bars_5m: list[MarketBar],
        snapshot: MarketSnapshot,
    ) -> None:
        self._symbol = symbol
        self._by_timeframe = {"1Hour": bars_1h, "15Min": bars_15m, "5Min": bars_5m}
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
        return self._by_timeframe[timeframe][-limit:]


class TestIntradayMultiTimeframeStrategy:
    def test_emits_buy_signal_on_confirmed_uptrend(self):
        cfg = IntradayStrategyConfig(quantity=Decimal("5"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        md = _MultiTimeframeMD(
            "AAPL", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)
        )
        strategy = IntradayMultiTimeframeStrategy("AAPL", config=cfg, now_override=SESSION_NOW)

        signals = strategy.generate_signals(md)

        assert len(signals) == 1
        assert signals[0].side == SignalSide.BUY
        assert signals[0].quantity == Decimal("5")
        assert "stop_loss" in signals[0].metadata

    def test_no_signal_on_hold(self):
        cfg = IntradayStrategyConfig()
        bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("100"), Decimal("0"))
        bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("100"), Decimal("0"))
        bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("100"), Decimal("0"))
        md = _MultiTimeframeMD("AAPL", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m))
        strategy = IntradayMultiTimeframeStrategy("AAPL", config=cfg)

        assert strategy.generate_signals(md) == []

    def test_unknown_symbol_returns_no_signals(self):
        cfg = IntradayStrategyConfig()
        strategy = IntradayMultiTimeframeStrategy("ZZZZZ", config=cfg)
        placeholder = _snapshot(_bars(1, 5, Decimal("100"), Decimal("0")))
        md = _MultiTimeframeMD("AAPL", [], [], [], placeholder)

        assert strategy.generate_signals(md) == []


# ── /intraday/analyze endpoint ───────────────────────────────────────────────

class TestIntradayAnalyzeEndpoint:
    def test_returns_analysis_for_known_symbol(self):
        from market_data.registry import init_provider

        cfg = IntradayStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        init_provider(_MultiTimeframeMD("AAPL", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/intraday/analyze",
            json={"symbol": "AAPL", "now": SESSION_NOW.isoformat()},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "AAPL"
        assert body["decision"] == "BUY"

    def test_unknown_symbol_returns_404(self):
        from market_data.registry import init_provider

        placeholder = _snapshot(_bars(1, 5, Decimal("100"), Decimal("0")))
        init_provider(_MultiTimeframeMD("AAPL", [], [], [], placeholder))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post("/intraday/analyze", json={"symbol": "ZZZZZ"})
        assert res.status_code == 404

    def test_requires_internal_token(self):
        from market_data.registry import init_provider

        cfg = IntradayStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        init_provider(_MultiTimeframeMD("AAPL", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.post("/intraday/analyze", json={"symbol": "AAPL"})
        assert res.status_code == 403
