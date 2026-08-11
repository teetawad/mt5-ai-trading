import uuid
from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer


class SignalSide(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class SignalType(StrEnum):
    MARKET = "MARKET"
    LIMIT = "LIMIT"


def _fmt(v: Decimal) -> str:
    return str(v.quantize(Decimal("0.00000001")))


class Signal(BaseModel):
    signal_id: str
    strategy_name: str
    symbol: str
    side: SignalSide
    quantity: Decimal
    signal_type: SignalType
    limit_price: Decimal | None = None
    reference_price: Decimal
    confidence: float  # 0.0 – 1.0 (clamped on creation)
    generated_at: str  # ISO 8601 UTC
    metadata: dict[str, str] = {}

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("quantity", "reference_price")
    def _ser_dec(self, v: Decimal) -> str:
        return _fmt(v)

    @field_serializer("limit_price")
    def _ser_limit(self, v: Decimal | None) -> str | None:
        return _fmt(v) if v is not None else None

    @classmethod
    def make(
        cls,
        strategy_name: str,
        symbol: str,
        side: SignalSide,
        quantity: Decimal,
        signal_type: SignalType,
        reference_price: Decimal,
        confidence: float,
        limit_price: Decimal | None = None,
        metadata: dict[str, str] | None = None,
    ) -> "Signal":
        return cls(
            signal_id=str(uuid.uuid4()),
            strategy_name=strategy_name,
            symbol=symbol,
            side=side,
            quantity=quantity,
            signal_type=signal_type,
            limit_price=limit_price,
            reference_price=reference_price,
            confidence=max(0.0, min(1.0, confidence)),
            generated_at=datetime.now(tz=UTC).isoformat(),
            metadata=metadata or {},
        )
