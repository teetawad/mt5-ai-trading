from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import numpy as np
from fastapi.testclient import TestClient

import routers.mt5 as mt5_router
from main import app
from mt5.timeframes import resolve_mt5_timeframe

client = TestClient(app)
TOKEN = "test-internal-token"
HEADERS = {"X-Internal-Token": TOKEN}


class FakeMT5Module:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_D1 = 16408

    def last_error(self):
        return (1, "no error")


def _bar_array(count: int = 5):
    dtype = np.dtype([
        ("time", "i8"), ("open", "f8"), ("high", "f8"), ("low", "f8"),
        ("close", "f8"), ("tick_volume", "i8"), ("spread", "i4"), ("real_volume", "i8"),
    ])
    rows = [
        (1_700_000_000 + i * 3600, 100 + i, 101 + i, 99 + i, 100.5 + i, 1000, 2, 0)
        for i in range(count)
    ]
    return np.array(rows, dtype=dtype)


class FakeAdapter:
    """Stands in for MT5Adapter in router tests, including the real
    (previously-buggy) timeframe() -> resolve_mt5_timeframe() code path."""

    def __init__(
        self,
        symbol_selectable: bool = True,
        copy_rates_raises: bool = False,
        empty_bars: bool = False,
    ) -> None:
        self.mt5 = FakeMT5Module()
        self._symbol_selectable = symbol_selectable
        self._copy_rates_raises = copy_rates_raises
        self._empty_bars = empty_bars
        self.copy_rates_calls: list[tuple[str, int, int]] = []

    def timeframe(self, value: str) -> int:
        return resolve_mt5_timeframe(self.mt5, value)

    def ensure_connected(self) -> None:
        return None

    def symbol_select(self, symbol: str, enable: bool = True) -> bool:
        return self._symbol_selectable

    def symbol_info_tick(self, symbol: str) -> object:
        return SimpleNamespace(bid=100.0, ask=100.2, time=1_700_000_000)

    def copy_rates_from_pos(
        self, symbol: str, timeframe_const: int, start_pos: int, count: int
    ) -> Any:
        self.copy_rates_calls.append((symbol, timeframe_const, count))
        if self._copy_rates_raises:
            raise RuntimeError("simulated MT5 terminal failure")
        if self._empty_bars:
            return np.array([], dtype=[("time", "i8")])
        return _bar_array(min(count, 5))


def _auth(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)


def test_bars_endpoint_succeeds_for_every_required_timeframe(monkeypatch) -> None:
    """Direct regression test: M5 (and every other required timeframe) must
    succeed, not 422 'Unsupported timeframe'."""
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    for tf in ("M1", "M5", "M15", "M30", "H1", "H4", "D1"):
        response = client.get(f"/mt5/bars/EURUSD?timeframe={tf}&count=10", headers=HEADERS)
        assert response.status_code == 200, f"{tf} failed: {response.json()}"
        assert len(response.json()) == 5


def test_bars_endpoint_accepts_lowercase_timeframe(monkeypatch) -> None:
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    response = client.get("/mt5/bars/EURUSD?timeframe=m5&count=10", headers=HEADERS)
    assert response.status_code == 200
    assert fake.copy_rates_calls[-1] == ("EURUSD", FakeMT5Module.TIMEFRAME_M5, 10)


def test_bars_endpoint_returns_the_actual_offending_timeframe_on_422(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter())
    response = client.get("/mt5/bars/EURUSD?timeframe=H7&count=10", headers=HEADERS)
    assert response.status_code == 422
    detail = response.json()["detail"]
    assert detail["error"] == "UNSUPPORTED_TIMEFRAME"
    assert "H7" in detail["message"]


def test_bars_endpoint_returns_symbol_not_found_when_symbol_select_fails(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter(symbol_selectable=False))
    response = client.get("/mt5/bars/NOTASYMBOL?timeframe=M5", headers=HEADERS)
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "SYMBOL_NOT_FOUND"


def test_bars_endpoint_returns_mt5_copy_rates_failed_when_mt5_raises(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter(copy_rates_raises=True))
    response = client.get("/mt5/bars/EURUSD?timeframe=M5", headers=HEADERS)
    assert response.status_code == 502
    assert response.json()["detail"]["error"] == "MT5_COPY_RATES_FAILED"


def test_bars_endpoint_returns_empty_list_not_an_error_when_no_bars_exist(monkeypatch) -> None:
    # Preserves existing behavior other systems rely on (Node's
    # MarketAnalysisPackage tolerates an empty timeframe without failing).
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter(empty_bars=True))
    response = client.get("/mt5/bars/EURUSD?timeframe=M5", headers=HEADERS)
    assert response.status_code == 200
    assert response.json() == []


def test_chart_endpoint_succeeds_for_m5_m15_h1_h4(monkeypatch) -> None:
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    for tf in ("M5", "M15", "H1", "H4"):
        response = client.get(f"/mt5/chart/XAUUSD?timeframe={tf}&count=20", headers=HEADERS)
        assert response.status_code == 200, f"{tf} failed: {response.json()}"
        assert response.json()["timeframe"] == tf


def test_chart_endpoint_returns_no_candle_data_when_bars_are_empty(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter(empty_bars=True))
    response = client.get("/mt5/chart/XAUUSD?timeframe=M15&count=20", headers=HEADERS)
    assert response.status_code == 404
    assert response.json()["detail"]["error"] == "NO_CANDLE_DATA"


def test_chart_endpoint_returns_unsupported_timeframe_with_actual_value(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter())
    response = client.get("/mt5/chart/XAUUSD?timeframe=W1&count=20", headers=HEADERS)
    assert response.status_code == 422
    assert "W1" in response.json()["detail"]["message"]
