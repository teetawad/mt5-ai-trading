from fastapi import APIRouter, Depends

from auth import verify_internal_token
from risk.engine import evaluate
from risk.types import RiskEvaluationRequest, RiskResult

router = APIRouter(prefix="/risk", tags=["risk"])


@router.post("/evaluate", response_model=RiskResult)
async def evaluate_risk(
    request: RiskEvaluationRequest,
    _: None = Depends(verify_internal_token),
) -> RiskResult:
    return evaluate(request)
