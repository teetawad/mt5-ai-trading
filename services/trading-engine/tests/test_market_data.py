"""Unit tests for market data providers.

All tests run without a database or network connection.
"""

import csv
import tempfile
from decimal import Decimal
from pathlib import Path

import pytest

from market_data.csv_provider import CSVMarketDataProvider
from market_data.provider import SymbolNotFoundError
from market_data.registry import get_provider, init_provider
from market_data.snapshot import MarketSnapshot
from market_data.synthetic import SyntheticMarketDataProvider

# ── SyntheticMarketDataProvider ────────────────────────────────────────────────

class TestSyntheticProvider:
    def _make(self, **kw) -> SyntheticMarketDataProvider:
        return SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00"), "MSFT": Decimal("300.00")},
            tick_interval_seconds=0,   # always generate a fresh price
            random_seed=42,
            **kw,
        )

    def test_returns_snapshot_for_tracked_symbol(self):
        p = self._make()
        snap = p.get_snapshot("AAPL")
        assert isinstance(snap, MarketSnapshot)
        assert snap.symbol == "AAPL"
        assert snap.price > 0
        assert snap.bid < snap.price < snap.ask

    def test_raises_for_unknown_symbol(self):
        p = self._make()
        with pytest.raises(SymbolNotFoundError):
            p.get_snapshot("ZZZZZ")

    def test_get_all_snapshots_returns_all_symbols(self):
        p = self._make()
        snaps = p.get_all_snapshots()
        symbols = {s.symbol for s in snaps}
        assert symbols == {"AAPL", "MSFT"}

    def test_tracked_symbols(self):
        p = self._make()
        assert set(p.tracked_symbols()) == {"AAPL", "MSFT"}

    def test_price_changes_between_ticks(self):
        p = self._make()
        p1 = p.get_snapshot("AAPL").price
        p2 = p.get_snapshot("AAPL").price
        # With tick_interval=0 every call generates a new price; they should differ
        # (extremely rarely equal given float noise — deterministic with seed=42)
        assert p1 != p2

    def test_price_cached_within_tick_interval(self):
        p = SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00")},
            tick_interval_seconds=9999,  # effectively infinite
            random_seed=99,
        )
        p1 = p.get_snapshot("AAPL").price
        p2 = p.get_snapshot("AAPL").price
        assert p1 == p2

    def test_deterministic_with_seed(self):
        p1 = SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00")},
            tick_interval_seconds=0,
            random_seed=7,
        )
        p2 = SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00")},
            tick_interval_seconds=0,
            random_seed=7,
        )
        assert p1.get_snapshot("AAPL").price == p2.get_snapshot("AAPL").price

    def test_is_stale_false_immediately_after_tick(self):
        p = SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00")},
            tick_interval_seconds=0,
            staleness_threshold_seconds=60,
            random_seed=1,
        )
        snap = p.get_snapshot("AAPL")
        assert snap.is_stale is False

    def test_snapshot_price_serialises_as_string(self):
        p = self._make()
        snap = p.get_snapshot("AAPL")
        data = snap.model_dump()
        assert isinstance(data["price"], str)
        assert isinstance(data["bid"], str)
        assert isinstance(data["ask"], str)


# ── CSVMarketDataProvider ─────────────────────────────────────────────────────

class TestCSVProvider:
    def _make_csv_dir(self) -> tuple[Path, tempfile.TemporaryDirectory]:
        tmp = tempfile.TemporaryDirectory()
        csv_path = Path(tmp.name) / "AAPL.csv"
        with open(csv_path, "w", newline="") as f:
            fields = ["timestamp", "open", "high", "low", "close", "volume"]
            writer = csv.DictWriter(f, fieldnames=fields)
            writer.writeheader()
            for i in range(5):
                writer.writerow({
                    "timestamp": f"2024-01-02T09:{30 + i * 5:02d}:00Z",
                    "open": f"{185 + i}.00",
                    "high": f"{186 + i}.00",
                    "low": f"{184 + i}.00",
                    "close": f"{185.50 + i}",
                    "volume": str(1_000_000 + i * 100_000),
                })
        return Path(tmp.name), tmp

    def test_loads_csv_and_returns_snapshot(self):
        data_dir, tmp = self._make_csv_dir()
        try:
            p = CSVMarketDataProvider(data_dir=data_dir, tick_interval_seconds=0)
            snap = p.get_snapshot("AAPL")
            assert snap.symbol == "AAPL"
            assert snap.price == Decimal("185.50")
        finally:
            tmp.cleanup()

    def test_advances_through_rows(self):
        data_dir, tmp = self._make_csv_dir()
        try:
            p = CSVMarketDataProvider(data_dir=data_dir, tick_interval_seconds=0)
            prices = [p.get_snapshot("AAPL").price for _ in range(5)]
            assert len(set(prices)) > 1
        finally:
            tmp.cleanup()

    def test_loops_at_end_of_csv(self):
        data_dir, tmp = self._make_csv_dir()
        try:
            p = CSVMarketDataProvider(data_dir=data_dir, tick_interval_seconds=0)
            first_price = p.get_snapshot("AAPL").price
            for _ in range(4):
                p.get_snapshot("AAPL")
            loop_price = p.get_snapshot("AAPL").price
            assert loop_price == first_price
        finally:
            tmp.cleanup()

    def test_raises_for_unknown_symbol(self):
        data_dir, tmp = self._make_csv_dir()
        try:
            p = CSVMarketDataProvider(data_dir=data_dir, tick_interval_seconds=0)
            with pytest.raises(SymbolNotFoundError):
                p.get_snapshot("ZZZZZ")
        finally:
            tmp.cleanup()

    def test_bid_below_ask(self):
        data_dir, tmp = self._make_csv_dir()
        try:
            p = CSVMarketDataProvider(data_dir=data_dir, tick_interval_seconds=0)
            snap = p.get_snapshot("AAPL")
            assert snap.bid < snap.ask
        finally:
            tmp.cleanup()


# ── Registry ──────────────────────────────────────────────────────────────────

class TestRegistry:
    def test_init_and_get_synthetic(self):
        provider = SyntheticMarketDataProvider(
            symbols={"SPY": Decimal("500.00")},
            random_seed=0,
        )
        init_provider(provider)
        assert get_provider() is provider

    def test_get_provider_raises_before_init(self, monkeypatch):
        import market_data.registry as reg
        monkeypatch.setattr(reg, "_provider", None)
        with pytest.raises(RuntimeError, match="not been initialised"):
            get_provider()

    def test_init_defaults_to_synthetic(self, monkeypatch):
        import market_data.registry as reg
        monkeypatch.setattr(reg, "_provider", None)
        monkeypatch.setenv("MARKET_DATA_PROVIDER", "synthetic")
        init_provider()
        assert isinstance(get_provider(), SyntheticMarketDataProvider)


# ── FastAPI endpoint integration ──────────────────────────────────────────────

class TestMarketDataEndpoints:
    @pytest.fixture(autouse=True)
    def setup_provider(self):
        init_provider(SyntheticMarketDataProvider(
            symbols={"AAPL": Decimal("150.00"), "MSFT": Decimal("300.00")},
            tick_interval_seconds=9999,
            random_seed=42,
        ))

    def test_get_snapshot_returns_200(self):
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get("/market-data/snapshot/AAPL")
        assert res.status_code == 200
        data = res.json()
        assert data["symbol"] == "AAPL"
        assert "price" in data
        assert "bid" in data
        assert "ask" in data
        assert "volume" in data
        assert "timestamp" in data
        assert "is_stale" in data

    def test_get_snapshot_404_for_unknown(self):
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get("/market-data/snapshot/ZZZZZ")
        assert res.status_code == 404

    def test_get_all_snapshots(self):
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get("/market-data/snapshots")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, list)
        symbols = {item["symbol"] for item in data}
        assert "AAPL" in symbols
        assert "MSFT" in symbols

    def test_get_symbols(self):
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get("/market-data/symbols")
        assert res.status_code == 200
        data = res.json()
        assert "AAPL" in data

    def test_internal_token_rejected_when_set(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get("/market-data/snapshot/AAPL")
        assert res.status_code == 403

    def test_internal_token_accepted(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app)
        res = client.get(
            "/market-data/snapshot/AAPL",
            headers={"X-Internal-Token": "secret-token"},
        )
        assert res.status_code == 200
