"""Tests for the Phase 26 crypto multi-timeframe strategy layer.

All tests run without a database or network connection.
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.crypto.analysis import (
    CryptoDecision,
    TrendDirection,
    analyze_crypto_multi_timeframe,
)
from strategy.crypto.config import CryptoStrategyConfig
from strategy.crypto.strategy import CryptoMultiTimeframeStrategy
from strategy.signal import SignalSide

TEST_INTERNAL_TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def _internal_service_token(monkeypatch):
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TEST_INTERNAL_TOKEN)


# ── Helpers ───────────────────────────────────────────────────────────────────

NOW = datetime(2024, 1, 2, 3, 0, tzinfo=UTC)  # arbitrary — crypto has no session


def _bars(
    n: int,
    step_minutes: int,
    start_price: Decimal,
    drift: Decimal,
    *,
    end: datetime = NOW,
    symbol: str = "BTC/USD",
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


def _uptrend(cfg: CryptoStrategyConfig) -> _BarTriple:
    bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("60000"), Decimal("0.003"))
    bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("60000"), Decimal("0.003"))
    bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("60000"), Decimal("0.003"))
    return bars_1h, bars_15m, bars_5m


def _downtrend(cfg: CryptoStrategyConfig) -> _BarTriple:
    bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("60000"), Decimal("-0.003"))
    bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("60000"), Decimal("-0.003"))
    bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("60000"), Decimal("-0.003"))
    return bars_1h, bars_15m, bars_5m


def _flat(cfg: CryptoStrategyConfig) -> _BarTriple:
    bars_1h = _bars(cfg.required_1h_bars + 5, 60, Decimal("60000"), Decimal("0"))
    bars_15m = _bars(cfg.required_15m_bars + 5, 15, Decimal("60000"), Decimal("0"))
    bars_5m = _bars(cfg.required_5m_bars + 5, 5, Decimal("60000"), Decimal("0"))
    return bars_1h, bars_15m, bars_5m


# ── analyze_crypto_multi_timeframe ──────────────────────────────────────────

class TestAnalyzeCryptoMultiTimeframe:
    def test_confirmed_uptrend_yields_buy_with_bracket(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.BUY
        assert result.trend_direction == TrendDirection.UP
        assert result.stop_loss is not None
        assert result.take_profit is not None
        assert result.stop_loss < result.entry_price < result.take_profit
        assert result.risk_reward >= cfg.min_risk_reward
        assert result.market_status == "OPEN_24_7"
        assert 0.5 <= result.confidence <= 1.0

    def test_market_status_is_always_open_24_7_even_on_hold(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _flat(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert result.market_status == "OPEN_24_7"

    def test_confirmed_downtrend_with_open_position_yields_sell(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _downtrend(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            has_open_position=True,
            now=NOW,
        )
        assert result.decision == CryptoDecision.SELL
        assert result.trend_direction == TrendDirection.DOWN
        # SELL is an exit signal, never a new bracket entry
        assert result.stop_loss is None
        assert result.take_profit is None

    def test_confirmed_downtrend_without_open_position_holds(self):
        """A bearish reversal with nothing to sell must never open a short —
        this PAPER broker does not support short selling."""
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _downtrend(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            has_open_position=False,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert any("no open position to close" in reason for reason in result.reasons)

    def test_flat_series_holds(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _flat(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert result.confidence < 0.5

    def test_insufficient_history_holds_with_reason(self):
        cfg = CryptoStrategyConfig()
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=[],
            bars_15m=[],
            bars_5m=[],
            snapshot=_snapshot(_bars(1, 5, Decimal("60000"), Decimal("0"))),
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert any("Insufficient" in reason for reason in result.reasons)
        assert result.confidence == 0.0

    def test_wide_spread_blocks_entry(self):
        cfg = CryptoStrategyConfig(max_spread_pct=Decimal("0.05"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        wide_snapshot = _snapshot(bars_5m, spread_pct=Decimal("5"))
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=wide_snapshot,
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert not result.liquidity_ok

    def test_min_risk_reward_can_reject_an_otherwise_valid_setup(self):
        cfg = CryptoStrategyConfig(min_risk_reward=Decimal("999"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        result = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert result.decision == CryptoDecision.HOLD
        assert any("Risk/reward" in reason for reason in result.reasons)

    def test_future_bars_are_ignored_no_look_ahead(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _flat(cfg)

        baseline = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=bars_1h,
            bars_15m=bars_15m,
            bars_5m=bars_5m,
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert baseline.decision == CryptoDecision.HOLD

        future_bar = MarketBar(
            symbol="BTC/USD",
            open=Decimal("60000"),
            high=Decimal("100000"),
            low=Decimal("60000"),
            close=Decimal("100000"),
            volume=10_000_000,
            timestamp=NOW + timedelta(hours=1),
        )
        with_future = analyze_crypto_multi_timeframe(
            symbol="BTC/USD",
            bars_1h=[*bars_1h, future_bar],
            bars_15m=[*bars_15m, future_bar],
            bars_5m=[*bars_5m, future_bar],
            snapshot=_snapshot(bars_5m),
            config=cfg,
            now=NOW,
        )
        assert with_future.decision == baseline.decision == CryptoDecision.HOLD
        assert with_future.trend_strength_pct == baseline.trend_strength_pct

    def test_fractional_quantity_accepted_in_config(self):
        cfg = CryptoStrategyConfig(quantity=Decimal("0.00012345"))
        assert cfg.quantity == Decimal("0.00012345")


# ── CryptoMultiTimeframeStrategy (registry wrapper) ─────────────────────────

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


class TestCryptoMultiTimeframeStrategy:
    def test_emits_buy_signal_on_confirmed_uptrend(self):
        cfg = CryptoStrategyConfig(quantity=Decimal("0.05"))
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        md = _MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m))
        strategy = CryptoMultiTimeframeStrategy("BTC/USD", config=cfg, now_override=NOW)

        signals = strategy.generate_signals(md)

        assert len(signals) == 1
        assert signals[0].side == SignalSide.BUY
        assert signals[0].quantity == Decimal("0.05")
        assert "stop_loss" in signals[0].metadata

    def test_never_emits_sell_from_registry_path(self):
        """The registry path has no portfolio context, so even a confirmed
        bearish reversal must never emit a signal (SELL requires knowing a
        position is open, which only the dedicated /crypto/analyze caller
        knows)."""
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _downtrend(cfg)
        md = _MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m))
        strategy = CryptoMultiTimeframeStrategy("BTC/USD", config=cfg, now_override=NOW)

        assert strategy.generate_signals(md) == []

    def test_no_signal_on_hold(self):
        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _flat(cfg)
        md = _MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m))
        strategy = CryptoMultiTimeframeStrategy("BTC/USD", config=cfg)

        assert strategy.generate_signals(md) == []

    def test_unknown_symbol_returns_no_signals(self):
        cfg = CryptoStrategyConfig()
        strategy = CryptoMultiTimeframeStrategy("ZZZ/USD", config=cfg)
        placeholder = _snapshot(_bars(1, 5, Decimal("60000"), Decimal("0")))
        md = _MultiTimeframeMD("BTC/USD", [], [], [], placeholder)

        assert strategy.generate_signals(md) == []


# ── /crypto/analyze endpoint ─────────────────────────────────────────────────

class TestCryptoAnalyzeEndpoint:
    def test_returns_analysis_for_known_symbol(self):
        from market_data.registry import init_provider

        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        init_provider(_MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/crypto/analyze",
            json={"symbol": "BTC/USD", "now": NOW.isoformat()},
        )
        assert res.status_code == 200
        body = res.json()
        assert body["symbol"] == "BTC/USD"
        assert body["decision"] == "BUY"
        assert body["market_status"] == "OPEN_24_7"

    def test_has_open_position_enables_sell(self):
        from market_data.registry import init_provider

        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _downtrend(cfg)
        init_provider(_MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/crypto/analyze",
            json={"symbol": "BTC/USD", "has_open_position": True, "now": NOW.isoformat()},
        )
        assert res.status_code == 200
        assert res.json()["decision"] == "SELL"

    def test_unknown_symbol_returns_404(self):
        from market_data.registry import init_provider

        placeholder = _snapshot(_bars(1, 5, Decimal("60000"), Decimal("0")))
        init_provider(_MultiTimeframeMD("BTC/USD", [], [], [], placeholder))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post("/crypto/analyze", json={"symbol": "ZZZ/USD"})
        assert res.status_code == 404

    def test_requires_internal_token(self):
        from market_data.registry import init_provider

        cfg = CryptoStrategyConfig()
        bars_1h, bars_15m, bars_5m = _uptrend(cfg)
        init_provider(_MultiTimeframeMD("BTC/USD", bars_1h, bars_15m, bars_5m, _snapshot(bars_5m)))

        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.post("/crypto/analyze", json={"symbol": "BTC/USD"})
        assert res.status_code == 403
