from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, field_serializer


class MarketSnapshot(BaseModel):
    symbol: str
    price: Decimal
    bid: Decimal
    ask: Decimal
    volume: int
    timestamp: datetime
    is_stale: bool = False

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("price", "bid", "ask")
    def serialize_decimal(self, value: Decimal) -> str:
        return str(value.quantize(Decimal("0.00000001")))
