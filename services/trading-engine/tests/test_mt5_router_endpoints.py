from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

import routers.mt5 as mt5_router
from main import app

client = TestClient(app)
TOKEN = "test-internal-token"


class FakeAdapter:
    """Stands in for MT5Adapter so router tests never touch a real terminal."""

    def __init__(self) -> None:
        self.selected: list[str] = []

    def ensure_connected(self) -> None:
        return None

    def symbol_select(self, symbol: str, enable: bool = True) -> bool:
        self.selected.append(symbol)
        return True

    def symbol_info(self, symbol: str) -> object:
        return SimpleNamespace(
            digits=2,
            point=0.01,
            trade_tick_size=0.01,
            trade_stops_level=10,
            trade_freeze_level=5,
            volume_min=0.01,
            volume_max=100.0,
            volume_step=0.01,
        )

    def orders_get(self, symbol: str | None = None) -> list[object]:
        return [SimpleNamespace(ticket=42, symbol="ETHUSD", type=2)]


def _auth(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)


def test_symbol_info_endpoint_returns_broker_constraints(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter())
    response = client.get("/mt5/symbol-info/ETHUSD", headers={"X-Internal-Token": TOKEN})
    assert response.status_code == 200
    data = response.json()
    assert data["trade_stops_level"] == 10
    assert data["trade_freeze_level"] == 5
    assert data["volume_step"] == 0.01


def test_symbol_info_endpoint_requires_internal_token(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_adapter", FakeAdapter())
    response = client.get("/mt5/symbol-info/ETHUSD")
    assert response.status_code == 403


def test_pending_orders_endpoint_lists_orders_without_calling_order_send(monkeypatch) -> None:
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    response = client.get("/mt5/orders", headers={"X-Internal-Token": TOKEN})
    assert response.status_code == 200
    data = response.json()
    assert data == [{"ticket": 42, "symbol": "ETHUSD", "type": 2}]
