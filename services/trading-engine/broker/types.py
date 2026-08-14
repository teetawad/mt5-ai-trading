from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer


class OrderSide(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class OrderType(StrEnum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"


class OrderStatus(StrEnum):
    PENDING = "PENDING"
    SUBMITTED = "SUBMITTED"
    PARTIALLY_FILLED = "PARTIALLY_FILLED"
    FILLED = "FILLED"
    CANCELLED = "CANCELLED"
    REJECTED = "REJECTED"
    ERROR = "ERROR"


class BrokerError(StrEnum):
    INSUFFICIENT_FUNDS = "INSUFFICIENT_FUNDS"
    INSUFFICIENT_POSITION = "INSUFFICIENT_POSITION"
    UNAVAILABLE = "UNAVAILABLE"
    UNKNOWN_SYMBOL = "UNKNOWN_SYMBOL"


def _fmt(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class OrderRequest(BaseModel):
    idempotency_key: str
    symbol: str
    side: OrderSide
    quantity: Decimal
    order_type: OrderType
    limit_price: Decimal | None = None
    bracket: dict[str, Decimal] | None = None
    # Phase 26: when True, partial fills round to 8 decimal places instead
    # of the nearest whole unit — required for crypto (fractional BTC/ETH
    # quantities). Defaults to False so existing US stock behavior (whole
    # shares only) is unchanged.
    fractionable: bool = False
    # Phase 26: optional percentage-of-notional fee (basis points), used
    # instead of the flat per-share fee/min-fee model when set. A flat $1
    # minimum fee is disproportionate on a fraction of a BTC — the caller
    # (Node) supplies this for crypto orders only.
    fee_bps: int | None = None

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("quantity")
    def _ser_qty(self, v: Decimal) -> str:
        return _fmt(v)

    @field_serializer("limit_price")
    def _ser_limit(self, v: Decimal | None) -> str | None:
        return _fmt(v) if v is not None else None

    @field_serializer("bracket")
    def _ser_bracket(self, v: dict[str, Decimal] | None) -> dict[str, str] | None:
        return {key: _fmt(value) for key, value in v.items()} if v is not None else None


class FillEvent(BaseModel):
    order_id: str
    fill_id: str
    quantity: Decimal
    price: Decimal
    fee: Decimal
    is_partial: bool
    filled_at: str  # ISO 8601 UTC

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("quantity", "price", "fee")
    def _ser_dec(self, v: Decimal) -> str:
        return _fmt(v)


class OrderResult(BaseModel):
    broker_order_id: str
    status: OrderStatus
    fills: list[FillEvent] = []
    bracket_order_ids: dict[str, str] | None = None
    rejected_reason: str | None = None
    error_message: str | None = None


class PaperBrokerConfig(BaseModel):
    fee_per_share: Decimal = Decimal("0.005")
    min_fee: Decimal = Decimal("1.00")
    slippage_bps: int = 5
    enable_partial_fills: bool = True
    partial_fill_probability: float = 0.1
    enable_rejections: bool = True
    rejection_probability: float = 0.01
    random_seed: int | None = None

    model_config = {"arbitrary_types_allowed": True}


class PaperPortfolio(BaseModel):
    cash: Decimal
    positions: dict[str, Decimal]

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("cash")
    def _ser_cash(self, v: Decimal) -> str:
        return _fmt(v)

    @field_serializer("positions")
    def _ser_pos(self, v: dict[str, Decimal]) -> dict[str, str]:
        return {k: _fmt(val) for k, val in v.items()}


class PaperAccount(BaseModel):
    cash: Decimal
    buying_power: Decimal
    account_id: str | None = None
    currency: str | None = None
    status: str | None = None

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("cash", "buying_power")
    def _ser_account_dec(self, v: Decimal) -> str:
        return _fmt(v)
