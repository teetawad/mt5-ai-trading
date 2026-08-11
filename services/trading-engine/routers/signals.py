import os

from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel

from market_data.registry import get_provider
from strategy.registry import get_all_strategies, get_strategy, list_strategies
from strategy.signal import Signal

router = APIRouter(prefix="/signals", tags=["signals"])


def _verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


class GenerateRequest(BaseModel):
    strategy_name: str | None = None  # None → run all registered strategies


@router.post("/generate", response_model=list[Signal])
async def generate_signals(
    request: GenerateRequest,
    _: None = Depends(_verify_internal_token),
) -> list[Signal]:
    market_data = get_provider()

    if request.strategy_name is not None:
        try:
            strategies = [get_strategy(request.strategy_name)]
        except KeyError as exc:
            raise HTTPException(
                status_code=404,
                detail=f"Strategy not found: {request.strategy_name}",
            ) from exc
    else:
        strategies = get_all_strategies()

    signals: list[Signal] = []
    for strategy in strategies:
        signals.extend(strategy.generate_signals(market_data))

    return signals


@router.get("/strategies", response_model=list[str])
async def get_strategy_names(
    _: None = Depends(_verify_internal_token),
) -> list[str]:
    return list_strategies()
