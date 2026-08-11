import os

from fastapi import APIRouter, Depends, Header, HTTPException

from risk.engine import evaluate
from risk.types import RiskEvaluationRequest, RiskResult

router = APIRouter(prefix="/risk", tags=["risk"])


def _verify_internal_token(x_internal_token: str | None = Header(default=None)) -> None:
    expected = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
    if expected and x_internal_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


@router.post("/evaluate", response_model=RiskResult)
async def evaluate_risk(
    request: RiskEvaluationRequest,
    _: None = Depends(_verify_internal_token),
) -> RiskResult:
    return evaluate(request)
