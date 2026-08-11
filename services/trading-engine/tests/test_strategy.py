"""Unit, boundary, and integration tests for the strategy engine.

All tests run without a database or network connection.
The boundary tests verify that strategy code never imports the broker layer.
"""

import ast
import pathlib
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketSnapshot
from strategy.base import Strategy
from strategy.moving_average_crossover import MovingAverageCrossoverStrategy
from strategy.registry import (
    clear_strategies,
    get_all_strategies,
    get_strategy,
    list_strategies,
    register_strategy,
)
from strategy.signal import Signal, SignalSide, SignalType

# ── Helpers ───────────────────────────────────────────────────────────────────

STRATEGY_DIR = pathlib.Path(__file__).parent.parent / "strategy"


class SequenceMD(MarketDataProvider):
    """Returns prices from a list in order; raises StopIteration when exhausted."""

    def __init__(self, symbol: str, prices: list[Decimal]) -> None:
        self._symbol = symbol
        self._iter = iter(prices)

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol != self._symbol:
            raise SymbolNotFoundError(f"Unknown: {symbol}")
        price = next(self._iter)
        return MarketSnapshot(
            symbol=symbol,
            price=price,
            bid=price * Decimal("0.999"),
            ask=price * Decimal("1.001"),
            volume=1000,
            timestamp=datetime.now(tz=UTC),
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return []

    def tracked_symbols(self) -> list[str]:
        return [self._symbol]


class FixedMD(MarketDataProvider):
    """Always returns the same price for one symbol."""

    def __init__(self, symbol: str, price: Decimal) -> None:
        self._symbol = symbol
        self._price = price

    def set_price(self, price: Decimal) -> None:
        self._price = price

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol != self._symbol:
            raise SymbolNotFoundError(f"Unknown: {symbol}")
        p = self._price
        return MarketSnapshot(
            symbol=symbol,
            price=p,
            bid=p * Decimal("0.999"),
            ask=p * Decimal("1.001"),
            volume=1000,
            timestamp=datetime.now(tz=UTC),
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self.get_snapshot(self._symbol)]

    def tracked_symbols(self) -> list[str]:
        return [self._symbol]


def _feed(strategy: MovingAverageCrossoverStrategy, md: SequenceMD) -> list[Signal]:
    """Drain all prices in md through the strategy and return all emitted signals."""
    signals: list[Signal] = []
    while True:
        try:
            signals.extend(strategy.generate_signals(md))
        except StopIteration:
            break
    return signals


# ── Signal schema ─────────────────────────────────────────────────────────────

class TestSignalSchema:
    def test_make_produces_valid_signal(self) -> None:
        s = Signal.make(
            strategy_name="test_strategy",
            symbol="AAPL",
            side=SignalSide.BUY,
            quantity=Decimal("10"),
            signal_type=SignalType.MARKET,
            reference_price=Decimal("150.00"),
            confidence=0.8,
        )
        assert s.signal_id != ""
        assert s.strategy_name == "test_strategy"
        assert s.symbol == "AAPL"
        assert s.side == SignalSide.BUY
        assert s.quantity == Decimal("10")
        assert s.signal_type == SignalType.MARKET
        assert s.reference_price == Decimal("150.00")
        assert s.confidence == 0.8
        assert s.generated_at != ""
        assert s.limit_price is None

    def test_confidence_clamped_above_one(self) -> None:
        s = Signal.make(
            strategy_name="s",
            symbol="X",
            side=SignalSide.BUY,
            quantity=Decimal("1"),
            signal_type=SignalType.MARKET,
            reference_price=Decimal("1"),
            confidence=99.9,
        )
        assert s.confidence == 1.0

    def test_confidence_clamped_below_zero(self) -> None:
        s = Signal.make(
            strategy_name="s",
            symbol="X",
            side=SignalSide.BUY,
            quantity=Decimal("1"),
            signal_type=SignalType.MARKET,
            reference_price=Decimal("1"),
            confidence=-5.0,
        )
        assert s.confidence == 0.0

    def test_decimal_fields_serialise_as_strings(self) -> None:
        s = Signal.make(
            strategy_name="s",
            symbol="AAPL",
            side=SignalSide.SELL,
            quantity=Decimal("5"),
            signal_type=SignalType.LIMIT,
            reference_price=Decimal("200.00"),
            confidence=0.5,
            limit_price=Decimal("205.00"),
        )
        data = s.model_dump()
        assert isinstance(data["quantity"], str)
        assert isinstance(data["reference_price"], str)
        assert isinstance(data["limit_price"], str)

    def test_signal_ids_unique(self) -> None:
        ids = {
            Signal.make(
                strategy_name="s",
                symbol="X",
                side=SignalSide.BUY,
                quantity=Decimal("1"),
                signal_type=SignalType.MARKET,
                reference_price=Decimal("1"),
                confidence=0.5,
            ).signal_id
            for _ in range(50)
        }
        assert len(ids) == 50

    def test_metadata_stored(self) -> None:
        s = Signal.make(
            strategy_name="s",
            symbol="X",
            side=SignalSide.BUY,
            quantity=Decimal("1"),
            signal_type=SignalType.MARKET,
            reference_price=Decimal("1"),
            confidence=0.5,
            metadata={"short_ma": "10.5", "long_ma": "9.8"},
        )
        assert s.metadata["short_ma"] == "10.5"


# ── Strategy interface ────────────────────────────────────────────────────────

class TestStrategyInterface:
    def test_mac_is_strategy(self) -> None:
        s = MovingAverageCrossoverStrategy("AAPL", short_window=3, long_window=5)
        assert isinstance(s, Strategy)

    def test_name_includes_symbol_and_windows(self) -> None:
        s = MovingAverageCrossoverStrategy("AAPL", short_window=5, long_window=20)
        assert "AAPL" in s.name
        assert "5" in s.name
        assert "20" in s.name

    def test_invalid_window_raises(self) -> None:
        with pytest.raises(ValueError, match="short_window"):
            MovingAverageCrossoverStrategy("AAPL", short_window=10, long_window=5)

    def test_equal_windows_raises(self) -> None:
        with pytest.raises(ValueError, match="short_window"):
            MovingAverageCrossoverStrategy("AAPL", short_window=5, long_window=5)


# ── MovingAverageCrossover signal generation ──────────────────────────────────

class TestMovingAverageCrossover:
    def _mac(
        self, short: int = 3, long: int = 5, qty: Decimal = Decimal("10")
    ) -> MovingAverageCrossoverStrategy:
        return MovingAverageCrossoverStrategy(
            "AAPL", short_window=short, long_window=long, quantity=qty
        )

    def test_no_signal_while_history_is_short(self) -> None:
        mac = self._mac()
        md = SequenceMD("AAPL", [Decimal("100")] * 4)
        signals = _feed(mac, md)
        assert signals == []

    def test_no_signal_on_first_complete_window(self) -> None:
        # After filling the long_window buffer for the first time,
        # prev_short/prev_long are None so no crossover check yet.
        mac = self._mac()
        md = SequenceMD("AAPL", [Decimal("100")] * 5)
        signals = _feed(mac, md)
        assert signals == []

    def test_buy_signal_on_upward_crossover(self) -> None:
        # Establish flat MAs, then spike up to force short > long.
        # short=3, long=5; prices [10,10,10,10,10] → MAs equal, no signal.
        # Price 15: short_ma=(10+10+15)/3=11.67, long_ma=(10+10+10+10+15)/5=11 → BUY.
        mac = self._mac()
        md = SequenceMD("AAPL", [Decimal("10")] * 5 + [Decimal("15")])
        signals = _feed(mac, md)
        assert len(signals) == 1
        s = signals[0]
        assert s.side == SignalSide.BUY
        assert s.symbol == "AAPL"
        assert s.signal_type == SignalType.MARKET

    def test_sell_signal_on_downward_crossover(self) -> None:
        # Establish upward state, then drop hard to force short < long.
        # [10]*5 → equal. 15 → BUY. 1,1 → SELL eventually.
        mac = self._mac()
        prices = [Decimal("10")] * 5 + [Decimal("15"), Decimal("1"), Decimal("1"), Decimal("1")]
        md = SequenceMD("AAPL", prices)
        signals = _feed(mac, md)
        sides = [s.side for s in signals]
        assert SignalSide.SELL in sides

    def test_no_signal_when_no_crossover(self) -> None:
        # Monotonically rising prices: short always above long → only one BUY, no SELL.
        mac = self._mac()
        prices = [Decimal(str(i)) for i in range(1, 12)]  # 1..11
        md = SequenceMD("AAPL", prices)
        signals = _feed(mac, md)
        sell_signals = [s for s in signals if s.side == SignalSide.SELL]
        assert sell_signals == []

    def test_buy_signal_has_correct_quantity(self) -> None:
        mac = MovingAverageCrossoverStrategy(
            "AAPL", short_window=3, long_window=5, quantity=Decimal("7")
        )
        md = SequenceMD("AAPL", [Decimal("10")] * 5 + [Decimal("15")])
        signals = _feed(mac, md)
        assert signals[0].quantity == Decimal("7")

    def test_signal_contains_ma_metadata(self) -> None:
        mac = self._mac()
        md = SequenceMD("AAPL", [Decimal("10")] * 5 + [Decimal("15")])
        signals = _feed(mac, md)
        assert "short_ma" in signals[0].metadata
        assert "long_ma" in signals[0].metadata

    def test_unknown_symbol_returns_empty(self) -> None:
        mac = MovingAverageCrossoverStrategy("AAPL")
        md = FixedMD("MSFT", Decimal("300"))
        result = mac.generate_signals(md)
        assert result == []

    def test_confidence_in_range(self) -> None:
        mac = self._mac()
        md = SequenceMD("AAPL", [Decimal("10")] * 5 + [Decimal("15")])
        signals = _feed(mac, md)
        for s in signals:
            assert 0.0 <= s.confidence <= 1.0

    def test_reference_price_is_current_price(self) -> None:
        mac = self._mac()
        trigger_price = Decimal("15")
        md = SequenceMD("AAPL", [Decimal("10")] * 5 + [trigger_price])
        signals = _feed(mac, md)
        assert signals[0].reference_price == trigger_price


# ── Registry ──────────────────────────────────────────────────────────────────

class TestRegistry:
    def setup_method(self) -> None:
        clear_strategies()

    def test_register_and_retrieve(self) -> None:
        mac = MovingAverageCrossoverStrategy("AAPL")
        register_strategy(mac)
        assert get_strategy(mac.name) is mac

    def test_list_strategies(self) -> None:
        mac = MovingAverageCrossoverStrategy("AAPL")
        register_strategy(mac)
        assert mac.name in list_strategies()

    def test_get_all_strategies(self) -> None:
        mac1 = MovingAverageCrossoverStrategy("AAPL")
        mac2 = MovingAverageCrossoverStrategy("MSFT")
        register_strategy(mac1)
        register_strategy(mac2)
        all_s = get_all_strategies()
        assert len(all_s) == 2

    def test_get_unknown_strategy_raises(self) -> None:
        with pytest.raises(KeyError, match="nonexistent"):
            get_strategy("nonexistent")

    def test_register_overwrites_same_name(self) -> None:
        mac1 = MovingAverageCrossoverStrategy("AAPL")
        mac2 = MovingAverageCrossoverStrategy("AAPL")
        register_strategy(mac1)
        register_strategy(mac2)
        assert get_strategy(mac1.name) is mac2
        assert len(list_strategies()) == 1

    def test_clear_removes_all(self) -> None:
        register_strategy(MovingAverageCrossoverStrategy("AAPL"))
        clear_strategies()
        assert list_strategies() == []


# ── Architectural boundary: strategy must not import broker ───────────────────

class TestArchitecturalBoundary:
    def _strategy_source_files(self) -> list[pathlib.Path]:
        return [p for p in STRATEGY_DIR.glob("*.py") if p.name != "__init__.py"]

    def test_strategy_files_exist(self) -> None:
        files = self._strategy_source_files()
        names = {f.name for f in files}
        assert "signal.py" in names
        assert "base.py" in names
        assert "moving_average_crossover.py" in names

    def test_strategy_does_not_import_broker(self) -> None:
        """Static AST check: no strategy source file may import from the broker package."""
        for path in self._strategy_source_files():
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    assert not module.startswith("broker"), (
                        f"{path.name} imports from broker: 'from {module} import ...'"
                    )
                elif isinstance(node, ast.Import):
                    for alias in node.names:
                        assert not alias.name.startswith("broker"), (
                            f"{path.name} imports broker: 'import {alias.name}'"
                        )

    def test_strategy_does_not_import_routers(self) -> None:
        """Strategy must not import any router (execution boundary)."""
        for path in self._strategy_source_files():
            source = path.read_text(encoding="utf-8")
            tree = ast.parse(source, filename=str(path))
            for node in ast.walk(tree):
                if isinstance(node, ast.ImportFrom):
                    module = node.module or ""
                    assert not module.startswith("routers"), (
                        f"{path.name} imports from routers: 'from {module} import ...'"
                    )

    def test_generate_signals_accepts_only_market_data(self) -> None:
        """The generate_signals signature must only accept MarketDataProvider."""
        import inspect

        mac = MovingAverageCrossoverStrategy("AAPL")
        sig = inspect.signature(mac.generate_signals)
        params = list(sig.parameters.keys())
        assert params == ["market_data"]
        annotation = sig.parameters["market_data"].annotation
        assert annotation is MarketDataProvider

    def test_signal_schema_does_not_reference_broker_types(self) -> None:
        """Signal module namespace must not contain any broker types."""
        import strategy.signal as sig_mod

        for attr_name in dir(sig_mod):
            obj = getattr(sig_mod, attr_name)
            module = getattr(obj, "__module__", "") or ""
            assert not module.startswith("broker"), (
                f"strategy.signal contains broker type: {attr_name} from {module}"
            )


# ── FastAPI endpoint integration ──────────────────────────────────────────────

class TestSignalEndpoints:
    @pytest.fixture(autouse=True)
    def setup(self) -> None:
        from decimal import Decimal

        from market_data.registry import init_provider
        from market_data.synthetic import SyntheticMarketDataProvider
        from strategy.registry import clear_strategies, register_strategy

        clear_strategies()
        init_provider(
            SyntheticMarketDataProvider(
                symbols={"AAPL": Decimal("150.00")},
                tick_interval_seconds=9999,
                random_seed=42,
            )
        )
        self._mac = MovingAverageCrossoverStrategy(
            "AAPL", short_window=3, long_window=5, quantity=Decimal("10")
        )
        register_strategy(self._mac)

    def test_get_strategies_returns_200(self) -> None:
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.get("/signals/strategies")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        assert self._mac.name in data

    def test_generate_all_returns_200(self) -> None:
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.post("/signals/generate", json={"strategy_name": None})
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    def test_generate_specific_strategy_returns_200(self) -> None:
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.post(
            "/signals/generate", json={"strategy_name": self._mac.name}
        )
        assert res.status_code == 200
        assert isinstance(res.json(), list)

    def test_generate_unknown_strategy_returns_404(self) -> None:
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.post(
            "/signals/generate", json={"strategy_name": "nonexistent_strategy"}
        )
        assert res.status_code == 404

    def test_internal_token_rejected_when_set(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret")
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.get("/signals/strategies")
        assert res.status_code == 403

    def test_internal_token_accepted(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret")
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app)
        res = client.get(
            "/signals/strategies", headers={"X-Internal-Token": "secret"}
        )
        assert res.status_code == 200
