from __future__ import annotations

from datetime import UTC, datetime, timedelta
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
        self.last_date_from: datetime | None = None
        self.last_date_to: datetime | None = None

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

    def history_deals_get(
        self, date_from: datetime, date_to: datetime, **kwargs: object
    ) -> list[object]:
        self.last_date_from = date_from
        self.last_date_to = date_to
        return []

    def history_orders_get(
        self, date_from: datetime, date_to: datetime, **kwargs: object
    ) -> list[object]:
        self.last_date_from = date_from
        self.last_date_to = date_to
        return [SimpleNamespace(ticket=555, symbol="ETHUSD", state=4)]


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


def test_history_deals_date_to_is_padded_past_real_now_for_broker_clock_skew(monkeypatch) -> None:
    """Regression test for the actual root cause of "closed trades never
    reconcile": this broker's terminal server clock runs hours ahead of this
    process's real UTC clock (confirmed empirically against the live DEMO
    terminal — deal timestamps ~3h ahead of datetime.now(UTC)).
    history_deals_get() filters strictly by each deal's server-clock
    timestamp, so date_to=now(UTC) silently excluded deals for positions
    that had just closed. date_to must be padded forward of real "now" so a
    deal timestamped in the broker's (ahead) clock is never excluded."""
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    before = datetime.now(UTC)
    response = client.get(
        "/mt5/history-deals?symbol=ETHUSD&hours=2", headers={"X-Internal-Token": TOKEN}
    )
    after = datetime.now(UTC)
    assert response.status_code == 200
    assert fake.last_date_to > after
    # A generous buffer, not an unbounded one — bounded well below a day out.
    assert fake.last_date_to - after < timedelta(hours=24)
    # The requested lookback depth (hours=2) must stay anchored to real
    # "now", not shift forward by the same buffer applied to date_to.
    assert before - fake.last_date_from < timedelta(hours=2, minutes=1)
    assert before - fake.last_date_from > timedelta(hours=1, minutes=59)


def test_history_orders_endpoint_returns_order_history(monkeypatch) -> None:
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    response = client.get(
        "/mt5/history-orders?symbol=ETHUSD&hours=2", headers={"X-Internal-Token": TOKEN}
    )
    assert response.status_code == 200
    assert response.json() == [{"ticket": 555, "symbol": "ETHUSD", "state": 4}]


def test_history_orders_date_to_is_also_padded_for_broker_clock_skew(monkeypatch) -> None:
    _auth(monkeypatch)
    fake = FakeAdapter()
    monkeypatch.setattr(mt5_router, "_adapter", fake)
    after = datetime.now(UTC)
    client.get("/mt5/history-orders?symbol=ETHUSD&hours=2", headers={"X-Internal-Token": TOKEN})
    assert fake.last_date_to > after
