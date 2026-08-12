"""Unit tests for market data providers.

All tests run without a database or network connection.
"""

import asyncio
import csv
import tempfile
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

from market_data.alpaca import AlpacaMarketDataProvider, AlpacaMarketDataStream
from market_data.csv_provider import CSVMarketDataProvider
from market_data.provider import MarketDataProvider, MarketDataRateLimitError, SymbolNotFoundError
from market_data.registry import get_provider, init_provider
from market_data.snapshot import MarketBar, MarketQuote, MarketSnapshot, MarketTrade
from market_data.synthetic import SyntheticMarketDataProvider

TEST_INTERNAL_TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def _internal_service_token(monkeypatch):
    """Every HTTP-layer test needs INTERNAL_SERVICE_TOKEN set now that the
    dependency fails closed; individual token tests override this locally."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TEST_INTERNAL_TOKEN)


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


# AlpacaMarketDataProvider

def _mock_alpaca(response: httpx.Response) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(lambda _request: response))


class TestAlpacaProvider:
    def test_latest_snapshot_maps_alpaca_payload_and_freshness(self):
        now = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        provider = AlpacaMarketDataProvider(
            key_id="key",
            secret_key="secret",
            symbols=["AAPL"],
            client=_mock_alpaca(httpx.Response(200, json={
                "snapshot": {
                    "latestTrade": {"t": now, "p": 191.25, "s": 10},
                    "latestQuote": {"t": now, "bp": 191.2, "ap": 191.3, "bs": 1, "as": 2},
                    "minuteBar": {"t": now, "c": 191.25, "v": 12345},
                }
            })),
        )

        snapshot = provider.get_snapshot("aapl")

        assert snapshot.symbol == "AAPL"
        assert snapshot.price == Decimal("191.25")
        assert snapshot.bid == Decimal("191.2")
        assert snapshot.ask == Decimal("191.3")
        assert snapshot.volume == 12345
        assert snapshot.is_stale is False

    def test_latest_snapshot_accepts_direct_alpaca_payload(self):
        provider = AlpacaMarketDataProvider(
            key_id="key",
            secret_key="secret",
            symbols=["AAPL"],
            client=_mock_alpaca(httpx.Response(200, json={
                "symbol": "AAPL",
                "latestTrade": {"t": "2026-08-10T13:30:02Z", "p": 191.25, "s": 10},
                "latestQuote": {
                    "t": "2026-08-10T13:30:01Z",
                    "bp": 191.2,
                    "ap": 191.3,
                    "bs": 1,
                    "as": 2,
                },
                "minuteBar": {"t": "2026-08-10T13:30:00Z", "c": 191.25, "v": 12345},
            })),
        )

        assert provider.get_snapshot("AAPL").price == Decimal("191.25")

    def test_historical_bars_maps_alpaca_payload(self):
        provider = AlpacaMarketDataProvider(
            key_id="key",
            secret_key="secret",
            client=_mock_alpaca(httpx.Response(200, json={
                "bars": [{
                    "t": "2026-08-10T13:30:00Z",
                    "o": 190.0,
                    "h": 192.0,
                    "l": 189.5,
                    "c": 191.0,
                    "v": 1000,
                    "n": 42,
                    "vw": 190.75,
                }]
            })),
        )

        bars = provider.get_historical_bars(
            "AAPL",
            timeframe="1Min",
            start="2026-08-10T13:30:00Z",
            limit=1,
        )

        assert len(bars) == 1
        assert bars[0].symbol == "AAPL"
        assert bars[0].close == Decimal("191.0")
        assert bars[0].trade_count == 42
        assert bars[0].vwap == Decimal("190.75")

    def test_latest_quote_and_trade_map_alpaca_payloads(self):
        responses = iter([
            httpx.Response(200, json={
                "quote": {
                    "t": "2026-08-10T13:30:01Z",
                    "bp": 191.2,
                    "ap": 191.3,
                    "bs": 100,
                    "as": 200,
                }
            }),
            httpx.Response(200, json={
                "trade": {
                    "t": "2026-08-10T13:30:02Z",
                    "p": 191.25,
                    "s": 50,
                    "x": "V",
                    "i": 123,
                }
            }),
        ])
        client = httpx.Client(transport=httpx.MockTransport(lambda _request: next(responses)))
        provider = AlpacaMarketDataProvider(key_id="key", secret_key="secret", client=client)

        quote = provider.get_latest_quote("AAPL")
        trade = provider.get_latest_trade("AAPL")

        assert quote.bid == Decimal("191.2")
        assert quote.ask_size == 200
        assert trade.price == Decimal("191.25")
        assert trade.trade_id == 123

    def test_rate_limit_error_preserves_retry_after(self):
        provider = AlpacaMarketDataProvider(
            key_id="key",
            secret_key="secret",
            client=_mock_alpaca(httpx.Response(429, headers={"Retry-After": "2"})),
        )

        with pytest.raises(MarketDataRateLimitError) as exc:
            provider.get_latest_trade("AAPL")

        assert exc.value.retry_after_seconds == 2

    def test_from_env_registers_alpaca_provider(self, monkeypatch):
        import market_data.registry as reg
        monkeypatch.setattr(reg, "_provider", None)
        monkeypatch.setenv("MARKET_DATA_PROVIDER", "alpaca")
        monkeypatch.setenv("ALPACA_API_KEY_ID", "key")
        monkeypatch.setenv("ALPACA_API_SECRET_KEY", "secret")
        monkeypatch.setenv("MARKET_DATA_SYMBOLS", "AAPL,MSFT")

        init_provider()

        assert isinstance(get_provider(), AlpacaMarketDataProvider)
        assert get_provider().tracked_symbols() == ["AAPL", "MSFT"]

    def test_provider_creates_stream_from_same_credentials(self):
        provider = AlpacaMarketDataProvider(
            key_id="key",
            secret_key="secret",
            feed="iex",
            client=_mock_alpaca(httpx.Response(200, json={})),
        )

        stream = provider.create_stream()

        assert stream.url == "wss://stream.data.alpaca.markets/v2/iex"


class TestAlpacaMarketDataStream:
    def test_stream_message_handler_updates_latest_quote_trade_and_bar(self):
        stream = AlpacaMarketDataStream(key_id="key", secret_key="secret")

        stream._handle_message("""
        [
          {"T":"q","S":"AAPL","bp":191.2,"ap":191.3,"bs":100,"as":200,"t":"2026-08-10T13:30:01Z"},
          {"T":"t","S":"AAPL","p":191.25,"s":50,"x":"V","i":123,"t":"2026-08-10T13:30:02Z"},
          {"T":"b","S":"AAPL","o":190,"h":192,"l":189,"c":191,"v":1000,"n":42,"vw":190.75,"t":"2026-08-10T13:30:00Z"}
        ]
        """)

        assert stream.latest_quote("AAPL").bid == Decimal("191.2")
        assert stream.latest_trade("AAPL").price == Decimal("191.25")
        assert stream.latest_bar("AAPL").close == Decimal("191")

    @pytest.mark.asyncio
    async def test_stream_records_errors_and_reconnects_until_stopped(self):
        attempts = 0

        def failing_factory(_url: str):
            nonlocal attempts
            attempts += 1
            raise OSError("temporary stream failure")

        stream = AlpacaMarketDataStream(
            key_id="key",
            secret_key="secret",
            reconnect_initial_seconds=0.01,
            reconnect_max_seconds=0.01,
            websocket_factory=failing_factory,
        )
        stop_event = asyncio.Event()

        task = asyncio.create_task(stream.run_forever(symbols=["AAPL"], stop_event=stop_event))
        await asyncio.sleep(0.03)
        stop_event.set()
        await task

        assert attempts >= 1
        assert stream.connected is False
        assert stream.last_error == "temporary stream failure"


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
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
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
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/market-data/snapshot/ZZZZZ")
        assert res.status_code == 404

    def test_get_all_snapshots(self):
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
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
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/market-data/symbols")
        assert res.status_code == 200
        data = res.json()
        assert "AAPL" in data

    def test_internal_token_rejected_when_set(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/market-data/snapshot/AAPL")
        assert res.status_code == 403

    def test_internal_token_accepted(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret-token")
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get(
            "/market-data/snapshot/AAPL",
            headers={"X-Internal-Token": "secret-token"},
        )
        assert res.status_code == 200

    def test_historical_bars_endpoint(self):
        class BarsProvider(MarketDataProvider):
            def get_snapshot(self, symbol: str) -> MarketSnapshot:
                raise SymbolNotFoundError(symbol)

            def get_all_snapshots(self) -> list[MarketSnapshot]:
                return []

            def tracked_symbols(self) -> list[str]:
                return ["AAPL"]

            def get_historical_bars(
                self,
                symbol: str,
                *,
                timeframe: str,
                start: str,
                end: str | None = None,
                limit: int = 100,
            ) -> list[MarketBar]:
                assert symbol == "AAPL"
                assert timeframe == "1Min"
                assert start == "2026-08-10T13:30:00Z"
                assert end is None
                assert limit == 1
                return [
                    MarketBar(
                        symbol=symbol,
                        open=Decimal("190"),
                        high=Decimal("192"),
                        low=Decimal("189"),
                        close=Decimal("191"),
                        volume=1000,
                        timestamp=datetime.now(UTC),
                    )
                ]

        init_provider(BarsProvider())
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get(
            "/market-data/bars/AAPL?timeframe=1Min&start=2026-08-10T13:30:00Z&limit=1"
        )
        assert res.status_code == 200
        assert res.json()[0]["close"] == "191.00000000"

    def test_latest_quote_and_trade_endpoints(self):
        class LatestProvider(MarketDataProvider):
            def get_snapshot(self, symbol: str) -> MarketSnapshot:
                raise SymbolNotFoundError(symbol)

            def get_all_snapshots(self) -> list[MarketSnapshot]:
                return []

            def tracked_symbols(self) -> list[str]:
                return ["AAPL"]

            def get_latest_quote(self, symbol: str) -> MarketQuote:
                return MarketQuote(
                    symbol=symbol,
                    bid=Decimal("191.2"),
                    ask=Decimal("191.3"),
                    bid_size=100,
                    ask_size=200,
                    timestamp=datetime.now(UTC),
                )

            def get_latest_trade(self, symbol: str) -> MarketTrade:
                return MarketTrade(
                    symbol=symbol,
                    price=Decimal("191.25"),
                    size=50,
                    timestamp=datetime.now(UTC),
                )

        init_provider(LatestProvider())
        from fastapi.testclient import TestClient

        from main import app
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})

        quote = client.get("/market-data/quote/AAPL")
        trade = client.get("/market-data/trade/AAPL")

        assert quote.status_code == 200
        assert quote.json()["bid"] == "191.20000000"
        assert trade.status_code == 200
        assert trade.json()["price"] == "191.25000000"
