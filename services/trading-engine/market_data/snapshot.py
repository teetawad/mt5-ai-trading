from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, field_serializer


class DecimalModel(BaseModel):
    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("*")
    def serialize_decimal_fields(self, value: object) -> object:
        if isinstance(value, Decimal):
            return str(value.quantize(Decimal("0.00000001")))
        return value


class MarketBar(DecimalModel):
    symbol: str
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: int
    timestamp: datetime
    trade_count: int | None = None
    vwap: Decimal | None = None


class MarketQuote(DecimalModel):
    symbol: str
    bid: Decimal
    ask: Decimal
    bid_size: int
    ask_size: int
    timestamp: datetime
    is_stale: bool = False


class MarketTrade(DecimalModel):
    symbol: str
    price: Decimal
    size: int
    timestamp: datetime
    exchange: str | None = None
    trade_id: int | str | None = None
    is_stale: bool = False


class MarketSnapshot(DecimalModel):
    symbol: str
    price: Decimal
    bid: Decimal
    ask: Decimal
    volume: int
    timestamp: datetime
    is_stale: bool = False
