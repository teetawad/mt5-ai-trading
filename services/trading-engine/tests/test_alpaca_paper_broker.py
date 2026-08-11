"""Tests for Alpaca paper trading adapter.

All Alpaca responses are mocked. No live trading endpoint is allowed.
"""

from decimal import Decimal

import httpx
import pytest

from broker.adapter import BrokerAdapter
from broker.alpaca_paper import AlpacaPaperBrokerAdapter
from broker.registry import get_broker, init_broker
from broker.types import OrderRequest, OrderSide, OrderStatus, OrderType


def _req(
    idem_key: str = "proposal-1",
    order_type: OrderType = OrderType.MARKET,
    limit_price: Decimal | None = None,
    bracket: dict[str, Decimal] | None = None,
) -> OrderRequest:
    return OrderRequest(
        idempotency_key=idem_key,
        symbol="AAPL",
        side=OrderSide.BUY,
        quantity=Decimal("10"),
        order_type=order_type,
        limit_price=limit_price,
        bracket=bracket,
    )


def _order(
    *,
    order_id: str = "alpaca-order-1",
    client_order_id: str = "proposal-1",
    status: str = "filled",
    filled_qty: str = "10",
    filled_avg_price: str | None = "191.25",
) -> dict[str, object]:
    return {
        "id": order_id,
        "client_order_id": client_order_id,
        "symbol": "AAPL",
        "qty": "10",
        "filled_qty": filled_qty,
        "filled_avg_price": filled_avg_price,
        "status": status,
        "filled_at": "2026-08-11T14:30:00Z",
        "updated_at": "2026-08-11T14:30:00Z",
    }


def _client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


class TestAlpacaPaperBrokerAdapter:
    def test_is_broker_adapter(self) -> None:
        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(lambda _request: httpx.Response(200, json={})),
        )

        assert isinstance(broker, BrokerAdapter)

    def test_rejects_live_trading_base_url(self) -> None:
        with pytest.raises(ValueError, match="live trading endpoint"):
            AlpacaPaperBrokerAdapter(
                key_id="key",
                secret_key="secret",
                base_url="https://api.alpaca.markets",
            )

    def test_from_env_uses_paper_credentials_and_refuses_live_url(self, monkeypatch) -> None:
        monkeypatch.setenv("ALPACA_PAPER_API_KEY_ID", "key")
        monkeypatch.setenv("ALPACA_PAPER_API_SECRET_KEY", "secret")
        monkeypatch.setenv("ALPACA_PAPER_TRADING_BASE_URL", "https://api.alpaca.markets")

        with pytest.raises(ValueError, match="live trading endpoint"):
            AlpacaPaperBrokerAdapter.from_env()

    def test_submit_order_uses_client_order_id_for_idempotency(self) -> None:
        requests: list[httpx.Request] = []

        def handler(request: httpx.Request) -> httpx.Response:
            requests.append(request)
            if request.url.path.endswith("/orders:by_client_order_id"):
                return httpx.Response(404, json={"message": "not found"})
            assert request.url.path == "/v2/orders"
            assert request.headers["APCA-API-KEY-ID"] == "key"
            body = request.read().decode("utf-8")
            assert '"client_order_id":"proposal-1"' in body
            assert '"type":"market"' in body
            return httpx.Response(200, json=_order())

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        result = broker.submit_order(_req())

        assert result.broker_order_id == "alpaca-order-1"
        assert result.status == OrderStatus.FILLED
        assert result.fills[0].quantity == Decimal("10")
        assert len(requests) == 2

    def test_duplicate_submit_returns_existing_order_without_posting(self) -> None:
        calls: list[str] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append(request.method)
            assert request.method == "GET"
            return httpx.Response(
                200,
                json=_order(status="new", filled_qty="0", filled_avg_price=None),
            )

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        result = broker.submit_order(_req())

        assert result.status == OrderStatus.PENDING
        assert calls == ["GET"]

    def test_limit_order_payload_and_partial_fill_mapping(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/orders:by_client_order_id"):
                return httpx.Response(404, json={})
            body = request.read().decode("utf-8")
            assert '"type":"limit"' in body
            assert '"limit_price":"190.5"' in body
            return httpx.Response(
                200,
                json=_order(status="partially_filled", filled_qty="4", filled_avg_price="190.5"),
            )

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        result = broker.submit_order(_req(order_type=OrderType.LIMIT, limit_price=Decimal("190.5")))

        assert result.status == OrderStatus.PARTIALLY_FILLED
        assert result.fills[0].is_partial is True

    def test_bracket_order_payload_uses_alpaca_paper_bracket_fields(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path.endswith("/orders:by_client_order_id"):
                return httpx.Response(404, json={})
            body = request.read().decode("utf-8")
            assert '"order_class":"bracket"' in body
            assert '"stop_loss":{"stop_price":"98.00"}' in body
            assert '"take_profit":{"limit_price":"106.00"}' in body
            assert request.url.host == "paper-api.alpaca.markets"
            return httpx.Response(200, json=_order())

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        result = broker.submit_order(_req(bracket={
            "stop_loss_price": Decimal("98.00"),
            "take_profit_price": Decimal("106.00"),
        }))

        assert result.status == OrderStatus.FILLED

    def test_cancel_order_uses_paper_cancel_endpoint_and_refetches(self) -> None:
        calls: list[tuple[str, str]] = []

        def handler(request: httpx.Request) -> httpx.Response:
            calls.append((request.method, request.url.path))
            if request.method == "GET":
                status = "new" if len(calls) == 1 else "canceled"
                return httpx.Response(
                    200,
                    json=_order(status=status, filled_qty="0", filled_avg_price=None),
                )
            assert request.method == "DELETE"
            return httpx.Response(204)

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        result = broker.cancel_order("alpaca-order-1")

        assert result.status == OrderStatus.CANCELLED
        assert calls == [
            ("GET", "/v2/orders/alpaca-order-1"),
            ("DELETE", "/v2/orders/alpaca-order-1"),
            ("GET", "/v2/orders/alpaca-order-1"),
        ]

    def test_account_positions_orders_sync(self) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            if request.url.path == "/v2/account":
                return httpx.Response(200, json={"cash": "50000.25", "buying_power": "75000"})
            if request.url.path == "/v2/positions":
                return httpx.Response(200, json=[{"symbol": "AAPL", "qty": "3"}])
            if request.url.path == "/v2/orders":
                return httpx.Response(
                    200,
                    json=[_order(status="new", filled_qty="0", filled_avg_price=None)],
                )
            raise AssertionError(request.url)

        broker = AlpacaPaperBrokerAdapter(
            key_id="key",
            secret_key="secret",
            base_url="https://paper-api.alpaca.markets",
            client=_client(handler),
        )

        portfolio = broker.get_paper_portfolio()
        open_orders = broker.get_open_orders()

        assert portfolio.cash == Decimal("50000.25")
        assert portfolio.positions == {"AAPL": Decimal("3")}
        assert open_orders[0].status == OrderStatus.PENDING
        assert broker.is_available() is True

    def test_registry_selects_alpaca_paper_only_when_configured(self, monkeypatch) -> None:
        monkeypatch.setenv("BROKER_PROVIDER", "alpaca_paper")
        monkeypatch.setenv("ALPACA_PAPER_API_KEY_ID", "key")
        monkeypatch.setenv("ALPACA_PAPER_API_SECRET_KEY", "secret")

        init_broker()

        assert isinstance(get_broker(), AlpacaPaperBrokerAdapter)
