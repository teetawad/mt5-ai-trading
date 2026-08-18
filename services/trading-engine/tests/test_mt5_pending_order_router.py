from __future__ import annotations

from typing import Any

from fastapi.testclient import TestClient

import routers.mt5 as mt5_router
from main import app
from mt5.adapter import (
    MT5DemoSafetyError,
    MT5PendingOrderCancelledError,
    MT5PendingOrderConfirmationAmbiguousError,
    MT5PendingOrderNotConfirmedError,
)

client = TestClient(app)
TOKEN = "test-internal-token"
HEADERS = {"X-Internal-Token": TOKEN}

VALID_BODY = {
    "idempotency_key": "test-key",
    "symbol": "EURUSD",
    "order_type": "BUY_LIMIT",
    "price": 1.05,
    "volume": 0.01,
    "stop_loss": 1.045,
    "take_profit": 1.06,
    "comment": "AIV3abc123",
}


class RaisingGateway:
    """Stands in for DemoExecutionGateway — route-level tests only need to
    verify the HTTP status/detail mapping for each exception type; the real
    reconciliation logic itself is covered at the adapter level."""

    def __init__(
        self, to_raise: Exception | None = None, captured_request: dict[str, Any] | None = None
    ):
        self._to_raise = to_raise
        self._captured = captured_request if captured_request is not None else {}

    def order_check(self, request: dict[str, Any]) -> dict[str, Any]:
        self._captured["request"] = request
        if self._to_raise:
            raise self._to_raise
        return {"retcode": 0}

    def execute_pending_order(self, request: dict[str, Any]) -> dict[str, Any]:
        self._captured["request"] = request
        if self._to_raise:
            raise self._to_raise
        return {"retcode": 10008, "order": 555, "confirmed_order": {"ticket": 555}}

    def cancel_pending_order(self, ticket: int) -> dict[str, Any]:
        if self._to_raise:
            raise self._to_raise
        return {"retcode": 10009}


def _auth(monkeypatch) -> None:
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TOKEN)


def test_pending_order_success_returns_the_real_ticket(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_gateway", RaisingGateway())
    response = client.post("/mt5/pending-orders", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["order"] == 555


def test_pending_order_not_confirmed_returns_409_with_distinct_code(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(MT5PendingOrderNotConfirmedError("no matching order found")),
    )
    response = client.post("/mt5/pending-orders", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "PENDING_ORDER_NOT_CONFIRMED"


def test_pending_order_cancelled_returns_409_with_distinct_code(monkeypatch) -> None:
    # Distinct from PENDING_ORDER_NOT_CONFIRMED: history proved a definite
    # cancellation, not "we found no evidence anywhere" (spec section 8 —
    # the caller must never blindly retry order_send for either, but must
    # tell them apart when recording the plan's real state).
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(
            MT5PendingOrderCancelledError("order was CANCELED per history_orders_get()")
        ),
    )
    response = client.post("/mt5/pending-orders", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "PENDING_ORDER_CANCELLED"


def test_pending_order_ambiguous_returns_409_with_distinct_code(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(MT5PendingOrderConfirmationAmbiguousError("2 possible matches")),
    )
    response = client.post("/mt5/pending-orders", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 409
    assert response.json()["detail"]["error"] == "PENDING_ORDER_CONFIRMATION_AMBIGUOUS"


def test_pending_order_rejected_returns_403_with_distinct_code(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(
            MT5DemoSafetyError("MT5 order_send rejected the pending order: retcode=10006")
        ),
    )
    response = client.post("/mt5/pending-orders", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "PENDING_ORDER_REJECTED"
    assert "10006" in response.json()["detail"]["message"]


def test_pending_order_check_failure_maps_the_same_way(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(MT5DemoSafetyError("MT5 order_check rejected pending order request")),
    )
    response = client.post("/mt5/pending-order-check", json=VALID_BODY, headers=HEADERS)
    assert response.status_code == 403
    assert response.json()["detail"]["error"] == "PENDING_ORDER_REJECTED"


def test_cancel_pending_order_not_confirmed_maps_to_409(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(
        mt5_router,
        "_gateway",
        RaisingGateway(MT5PendingOrderNotConfirmedError("ticket still present")),
    )
    response = client.delete("/mt5/pending-orders/555", headers=HEADERS)
    assert response.status_code == 409


def test_all_four_pending_order_types_map_to_distinct_mt5_constants(monkeypatch) -> None:
    _auth(monkeypatch)
    seen_types = set()
    for order_type in ("BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"):
        captured: dict[str, Any] = {}
        monkeypatch.setattr(mt5_router, "_gateway", RaisingGateway(captured_request=captured))
        response = client.post(
            "/mt5/pending-orders", json={**VALID_BODY, "order_type": order_type}, headers=HEADERS
        )
        assert response.status_code == 200, response.json()
        assert response.json()["confirmed_order"]["ticket"] == 555
        seen_types.add(captured["request"]["type"])
    # Four distinct order types must map to four distinct MT5 type constants
    # — never collapse two different order types onto the same constant.
    assert len(seen_types) == 4


def test_pullback_buy_maps_to_buy_limit_below_market_semantics(monkeypatch) -> None:
    # Order-type mapping itself is symbol-price-agnostic at this layer (the
    # AI/Node layer decides PULLBACK BUY -> BUY_LIMIT before this request is
    # built) — this locks in that BUY_LIMIT specifically resolves to
    # ORDER_TYPE_BUY_LIMIT, never ORDER_TYPE_BUY_STOP or any other constant.
    _auth(monkeypatch)
    captured: dict[str, Any] = {}
    monkeypatch.setattr(mt5_router, "_gateway", RaisingGateway(captured_request=captured))
    client.post(
        "/mt5/pending-orders", json={**VALID_BODY, "order_type": "BUY_LIMIT"}, headers=HEADERS
    )
    assert captured["request"]["type"] == mt5_router._adapter.mt5.ORDER_TYPE_BUY_LIMIT


def test_breakout_sell_maps_to_sell_stop(monkeypatch) -> None:
    _auth(monkeypatch)
    captured: dict[str, Any] = {}
    monkeypatch.setattr(mt5_router, "_gateway", RaisingGateway(captured_request=captured))
    client.post(
        "/mt5/pending-orders", json={**VALID_BODY, "order_type": "SELL_STOP"}, headers=HEADERS
    )
    assert captured["request"]["type"] == mt5_router._adapter.mt5.ORDER_TYPE_SELL_STOP


def test_invalid_order_type_is_rejected_with_422(monkeypatch) -> None:
    _auth(monkeypatch)
    monkeypatch.setattr(mt5_router, "_gateway", RaisingGateway())
    response = client.post(
        "/mt5/pending-orders", json={**VALID_BODY, "order_type": "BUY"}, headers=HEADERS
    )
    assert response.status_code == 422
