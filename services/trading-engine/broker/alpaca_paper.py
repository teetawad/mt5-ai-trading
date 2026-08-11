"""Alpaca paper trading broker adapter.

This adapter only targets Alpaca's paper trading API. It never uses live
trading endpoints and never reads credentials outside environment variables in
the default constructor.
"""

from __future__ import annotations

import os
from decimal import Decimal
from typing import Any, Self

import httpx

from broker.adapter import BrokerAdapter, OrderNotFoundError
from broker.types import (
    FillEvent,
    OrderRequest,
    OrderResult,
    OrderStatus,
    OrderType,
    PaperPortfolio,
)

PAPER_TRADING_BASE_URL = "https://paper-api.alpaca.markets"
PAPER_TRADING_API_PREFIX = "/v2"
TERMINAL_STATUSES = {
    OrderStatus.FILLED,
    OrderStatus.CANCELLED,
    OrderStatus.REJECTED,
    OrderStatus.ERROR,
}


class AlpacaPaperBrokerError(Exception):
    pass


class AlpacaPaperBrokerAdapter(BrokerAdapter):
    def __init__(
        self,
        *,
        key_id: str,
        secret_key: str,
        base_url: str = PAPER_TRADING_BASE_URL,
        timeout_seconds: float = 10.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not key_id or not secret_key:
            raise ValueError("Alpaca paper trading credentials are required")
        self._base_url = _paper_base_url(base_url)
        self._key_id = key_id
        self._secret_key = secret_key
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._owns_client = client is None

    @classmethod
    def from_env(cls) -> AlpacaPaperBrokerAdapter:
        key_id = os.environ.get("ALPACA_PAPER_API_KEY_ID") or os.environ.get(
            "APCA_API_KEY_ID", ""
        )
        secret_key = os.environ.get("ALPACA_PAPER_API_SECRET_KEY") or os.environ.get(
            "APCA_API_SECRET_KEY", ""
        )
        base_url = os.environ.get("ALPACA_PAPER_TRADING_BASE_URL", PAPER_TRADING_BASE_URL)
        if _is_live_url(base_url):
            raise ValueError("Alpaca live trading endpoint is forbidden")
        return cls(key_id=key_id, secret_key=secret_key, base_url=base_url)

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: object,
    ) -> None:
        self.close()

    def submit_order(self, request: OrderRequest) -> OrderResult:
        existing = self._get_order_by_client_order_id(request.idempotency_key)
        if existing is not None:
            return self._map_order(existing)

        payload: dict[str, str] = {
            "symbol": request.symbol.upper(),
            "qty": str(request.quantity),
            "side": request.side.value.lower(),
            "type": _alpaca_order_type(request.order_type),
            "time_in_force": "day",
            "client_order_id": request.idempotency_key[:128],
        }
        if request.order_type == OrderType.LIMIT:
            if request.limit_price is None:
                return OrderResult(
                    broker_order_id=request.idempotency_key,
                    status=OrderStatus.REJECTED,
                    rejected_reason="Limit price required for LIMIT orders",
                )
            payload["limit_price"] = str(request.limit_price)

        response = self._request_dict("POST", "/orders", json=payload)
        return self._map_order(response)

    def get_order(self, broker_order_id: str) -> OrderResult:
        response = self._request_dict("GET", f"/orders/{broker_order_id}")
        return self._map_order(response)

    def cancel_order(self, broker_order_id: str) -> OrderResult:
        try:
            current = self.get_order(broker_order_id)
        except OrderNotFoundError:
            raise
        if current.status in TERMINAL_STATUSES:
            return current

        try:
            self._request("DELETE", f"/orders/{broker_order_id}", allow_empty=True)
        except AlpacaPaperBrokerError as exc:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.ERROR,
                error_message=str(exc),
            )

        try:
            return self.get_order(broker_order_id)
        except OrderNotFoundError:
            return OrderResult(broker_order_id=broker_order_id, status=OrderStatus.CANCELLED)

    def is_available(self) -> bool:
        try:
            self.get_account()
        except Exception:
            return False
        return True

    def get_account(self) -> dict[str, Any]:
        return self._request_dict("GET", "/account")

    def get_positions(self) -> list[dict[str, Any]]:
        return self._request_list("GET", "/positions")

    def get_open_orders(self) -> list[OrderResult]:
        response = self._request_list("GET", "/orders", params={"status": "open", "limit": "500"})
        return [self._map_order(order) for order in response if isinstance(order, dict)]

    def get_paper_portfolio(self) -> PaperPortfolio:
        account = self.get_account()
        positions = self.get_positions()
        return PaperPortfolio(
            cash=Decimal(str(account.get("cash", account.get("buying_power", "0")))),
            positions={
                str(position["symbol"]).upper(): Decimal(str(position.get("qty", "0")))
                for position in positions
                if Decimal(str(position.get("qty", "0"))) != 0
            },
        )

    def _get_order_by_client_order_id(self, client_order_id: str) -> dict[str, Any] | None:
        try:
            response = self._request_dict(
                "GET",
                "/orders:by_client_order_id",
                params={"client_order_id": client_order_id[:128]},
            )
        except OrderNotFoundError:
            return None
        return response

    def _request_dict(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str] | None = None,
    ) -> dict[str, Any]:
        parsed = self._request(method, path, params=params, json=json)
        if not isinstance(parsed, dict):
            raise AlpacaPaperBrokerError("Malformed Alpaca paper trading response")
        return parsed

    def _request_list(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        parsed = self._request(method, path, params=params)
        if not isinstance(parsed, list):
            raise AlpacaPaperBrokerError("Malformed Alpaca paper trading response")
        return parsed

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str] | None = None,
        json: dict[str, str] | None = None,
        allow_empty: bool = False,
    ) -> dict[str, Any] | list[dict[str, Any]]:
        response = self._client.request(
            method,
            f"{self._base_url}{PAPER_TRADING_API_PREFIX}{path}",
            params=params,
            json=json,
            headers={
                "APCA-API-KEY-ID": self._key_id,
                "APCA-API-SECRET-KEY": self._secret_key,
            },
        )
        if allow_empty and response.status_code == 204:
            return {}
        if response.status_code == 404:
            raise OrderNotFoundError(path)
        if response.status_code == 429:
            raise AlpacaPaperBrokerError("Alpaca paper trading rate limit exceeded")
        if response.status_code >= 500:
            raise AlpacaPaperBrokerError(f"Alpaca paper trading error: {response.status_code}")
        if response.status_code >= 400:
            body = _safe_json(response)
            message = body.get("message") if isinstance(body, dict) else None
            raise AlpacaPaperBrokerError(
                message or f"Alpaca paper trading rejected request: {response.status_code}"
            )
        parsed = response.json()
        if not isinstance(parsed, dict | list):
            raise AlpacaPaperBrokerError("Malformed Alpaca paper trading response")
        return parsed

    def _map_order(self, order: dict[str, Any]) -> OrderResult:
        broker_order_id = str(order.get("id") or order.get("client_order_id") or "")
        status = _map_status(str(order.get("status", "")))
        rejected_reason = (
            str(order["failed_at"])
            if status == OrderStatus.REJECTED and order.get("failed_at")
            else None
        )
        return OrderResult(
            broker_order_id=broker_order_id,
            status=status,
            fills=_map_fills(order, broker_order_id),
            rejected_reason=rejected_reason,
        )


def _paper_base_url(base_url: str) -> str:
    cleaned = base_url.rstrip("/")
    if _is_live_url(cleaned):
        raise ValueError("Alpaca live trading endpoint is forbidden")
    return cleaned


def _is_live_url(base_url: str) -> bool:
    return "api.alpaca.markets" in base_url and "paper-api.alpaca.markets" not in base_url


def _alpaca_order_type(order_type: OrderType) -> str:
    return "market" if order_type == OrderType.MARKET else "limit"


def _map_status(status: str) -> OrderStatus:
    normalized = status.lower()
    if normalized == "filled":
        return OrderStatus.FILLED
    if normalized == "partially_filled":
        return OrderStatus.PARTIALLY_FILLED
    if normalized in {"canceled", "cancelled", "expired"}:
        return OrderStatus.CANCELLED
    if normalized in {"rejected", "stopped", "suspended"}:
        return OrderStatus.REJECTED
    if normalized in {"pending_new", "accepted", "new", "accepted_for_bidding"}:
        return OrderStatus.PENDING
    submitted_statuses = {"pending_cancel", "pending_replace", "replaced", "done_for_day"}
    if normalized in submitted_statuses or normalized == "calculated":
        return OrderStatus.SUBMITTED
    return OrderStatus.ERROR


def _map_fills(order: dict[str, Any], broker_order_id: str) -> list[FillEvent]:
    filled_qty = Decimal(str(order.get("filled_qty", "0") or "0"))
    avg_price = order.get("filled_avg_price")
    if filled_qty <= 0 or avg_price is None:
        return []
    qty = Decimal(str(order.get("qty", filled_qty)))
    return [
        FillEvent(
            order_id=broker_order_id,
            fill_id=f"{broker_order_id}:fill",
            quantity=filled_qty,
            price=Decimal(str(avg_price)),
            fee=Decimal("0"),
            is_partial=filled_qty < qty,
            filled_at=str(order.get("filled_at") or order.get("updated_at") or ""),
        )
    ]


def _safe_json(response: httpx.Response) -> dict[str, Any] | list[Any] | None:
    try:
        parsed = response.json()
    except ValueError:
        return None
    return parsed if isinstance(parsed, dict | list) else None
