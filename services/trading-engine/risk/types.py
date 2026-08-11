from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel


class EvaluationStage(StrEnum):
    PRE_PROPOSAL = "PRE_PROPOSAL"
    PRE_EXECUTION = "PRE_EXECUTION"


class RuleOutcome(StrEnum):
    PASS = "PASS"
    REJECT = "REJECT"


class TradeSide(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class ProposalInput(BaseModel):
    symbol: str
    side: TradeSide
    quantity: Decimal
    reference_price: Decimal
    expires_at: str | None = None  # ISO 8601 UTC; required for PRE_EXECUTION expiry check

    model_config = {"arbitrary_types_allowed": True}


class MarketInput(BaseModel):
    symbol: str
    price: Decimal
    is_stale: bool
    timestamp: str  # ISO 8601 UTC

    model_config = {"arbitrary_types_allowed": True}


class PortfolioInput(BaseModel):
    cash: Decimal
    positions: dict[str, Decimal]  # symbol → current quantity held
    equity: Decimal  # cash + sum of all position values at current prices
    daily_pnl: Decimal  # realized + unrealized P&L for today; negative = loss

    model_config = {"arbitrary_types_allowed": True}


class PendingProposalInput(BaseModel):
    symbol: str
    side: TradeSide


class RiskConfig(BaseModel):
    kill_switch_enabled: bool = True
    trading_mode: str = "PAPER"
    market_data_staleness_seconds: int = 60
    price_drift_threshold_pct: Decimal = Decimal("2.0")   # CONFIGURE before use
    max_order_notional_usd: Decimal = Decimal("10000.00") # CONFIGURE before use
    max_position_size_usd: Decimal = Decimal("50000.00")  # CONFIGURE before use
    max_portfolio_concentration_pct: Decimal = Decimal("20.0")  # CONFIGURE before use
    max_open_positions: int = 10                          # CONFIGURE before use
    max_daily_loss_usd: Decimal = Decimal("1000.00")     # CONFIGURE before use
    trading_session_start: str | None = None  # "HH:MM" UTC; None = unrestricted
    trading_session_end: str | None = None    # "HH:MM" UTC; None = unrestricted
    cooldown_between_trades_seconds: int = 0  # 0 = disabled

    model_config = {"arbitrary_types_allowed": True}


class RiskEvaluationRequest(BaseModel):
    stage: EvaluationStage
    proposal: ProposalInput
    market: MarketInput
    portfolio: PortfolioInput
    config: RiskConfig = RiskConfig()
    pending_proposals: list[PendingProposalInput] = []
    last_fill_times: dict[str, str] = {}  # symbol → ISO 8601 UTC of last fill


class RiskResult(BaseModel):
    result: RuleOutcome
    stage: EvaluationStage
    rules_checked: list[str]
    failed_rules: list[str]
    reason: str | None = None
    market_snapshot: dict[str, object]
    portfolio_snapshot: dict[str, object]
    evaluated_at: str  # ISO 8601 UTC
