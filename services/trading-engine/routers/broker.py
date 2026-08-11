import os
from decimal import Decimal
from typing import Protocol, cast

from fastapi import APIRouter, Depends, Header, HTTPException

from broker.adapter import OrderNotFoundError
from broker.registry import get_broker
from broker.types import OrderRequest, OrderResult, PaperAccount, PaperPortfolio

router = APIRouter(prefix="/broker", tags=["broker"])


class PaperPortfolioBroker(Protocol):
    def get_paper_portfolio(self) -> PaperPortfolio:
        ...


class PaperAccountBroker(Protocol):
    def get_account(self) -> dict[str, object]:
        ...


class OpenOrdersBroker(Protocol):
    def get_open_orders(self) -> list[OrderResult]:
        ...


def _verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.post("/orders", response_model=OrderResult)
async def submit_order(
    request: OrderRequest,
    _: None = Depends(_verify_internal_token),
) -> OrderResult:
    return get_broker().submit_order(request)


@router.get("/orders/{broker_order_id}", response_model=OrderResult)
async def get_order(
    broker_order_id: str,
    _: None = Depends(_verify_internal_token),
) -> OrderResult:
    try:
        return get_broker().get_order(broker_order_id)
    except OrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Order not found: {broker_order_id}") from exc


@router.post("/orders/{broker_order_id}/cancel", response_model=OrderResult)
async def cancel_order(
    broker_order_id: str,
    _: None = Depends(_verify_internal_token),
) -> OrderResult:
    try:
        return get_broker().cancel_order(broker_order_id)
    except OrderNotFoundError as exc:
        raise HTTPException(status_code=404, detail=f"Order not found: {broker_order_id}") from exc


@router.get("/health")
async def broker_health(
    _: None = Depends(_verify_internal_token),
) -> dict[str, bool | str]:
    provider = os.environ.get("BROKER_PROVIDER", "local_paper")
    return {
        "available": get_broker().is_available(),
        "provider": provider,
        "trading_mode": "PAPER",
    }


@router.get("/paper-portfolio", response_model=PaperPortfolio)
async def paper_portfolio(
    _: None = Depends(_verify_internal_token),
) -> PaperPortfolio:
    broker = get_broker()
    if not hasattr(broker, "get_paper_portfolio"):
        raise HTTPException(status_code=501, detail="Paper portfolio not available for this broker")
    return cast(PaperPortfolioBroker, broker).get_paper_portfolio()


@router.get("/paper-account", response_model=PaperAccount)
async def paper_account(
    _: None = Depends(_verify_internal_token),
) -> PaperAccount:
    broker = get_broker()
    if hasattr(broker, "get_account"):
        account = cast(PaperAccountBroker, broker).get_account()
        cash = account.get("cash", account.get("buying_power", "0"))
        buying_power = account.get("buying_power", cash)
        return PaperAccount(
            cash=Decimal(str(cash)),
            buying_power=Decimal(str(buying_power)),
            account_id=str(account["id"]) if account.get("id") else None,
            currency=str(account["currency"]) if account.get("currency") else None,
            status=str(account["status"]) if account.get("status") else None,
        )

    if hasattr(broker, "get_paper_portfolio"):
        portfolio = cast(PaperPortfolioBroker, broker).get_paper_portfolio()
        return PaperAccount(cash=portfolio.cash, buying_power=portfolio.cash)

    raise HTTPException(status_code=501, detail="Paper account not available for this broker")


@router.get("/open-orders", response_model=list[OrderResult])
async def open_orders(
    _: None = Depends(_verify_internal_token),
) -> list[OrderResult]:
    broker = get_broker()
    if not hasattr(broker, "get_open_orders"):
        raise HTTPException(
            status_code=501,
            detail="Open paper orders not available for this broker",
        )
    return cast(OpenOrdersBroker, broker).get_open_orders()
