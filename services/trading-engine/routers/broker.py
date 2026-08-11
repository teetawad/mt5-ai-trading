import os

from fastapi import APIRouter, Depends, Header, HTTPException

from broker.adapter import OrderNotFoundError
from broker.paper_broker import PaperBrokerAdapter
from broker.registry import get_broker
from broker.types import OrderRequest, OrderResult, PaperPortfolio

router = APIRouter(prefix="/broker", tags=["broker"])


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
) -> dict[str, bool]:
    return {"available": get_broker().is_available()}


@router.get("/paper-portfolio", response_model=PaperPortfolio)
async def paper_portfolio(
    _: None = Depends(_verify_internal_token),
) -> PaperPortfolio:
    broker = get_broker()
    if not isinstance(broker, PaperBrokerAdapter):
        raise HTTPException(
            status_code=501, detail="Paper portfolio not available for this broker type"
        )
    return broker.get_paper_portfolio()
