from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class BacktestSide(StrEnum):
    BUY = "BUY"
    SELL = "SELL"


class StrategyKind(StrEnum):
    MOVING_AVERAGE_CROSSOVER = "moving_average_crossover"
    US_STOCK_FACTOR = "us_stock_factor"


class StrategyParameters(BaseModel):
    kind: StrategyKind = StrategyKind.MOVING_AVERAGE_CROSSOVER
    symbol: str
    short_window: int = 5
    long_window: int = 20
    quantity: Decimal = Decimal("1")
    trend_window: int = 20
    momentum_window: int = 10
    volatility_window: int = 20
    volume_window: int = 20
    min_trend_pct: Decimal = Decimal("0")
    min_momentum_pct: Decimal = Decimal("0")
    max_volatility_pct: Decimal = Decimal("100")
    min_volume_ratio: Decimal = Decimal("0")
    exit_trend_pct: Decimal = Decimal("0")
    exit_momentum_pct: Decimal = Decimal("0")

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer(
        "quantity",
        "min_trend_pct",
        "min_momentum_pct",
        "max_volatility_pct",
        "min_volume_ratio",
        "exit_trend_pct",
        "exit_momentum_pct",
    )
    def serialize_quantity(self, value: Decimal) -> str:
        return _money(value)


class BacktestConfig(BaseModel):
    initial_cash: Decimal = Decimal("100000")
    fee_per_share: Decimal = Decimal("0.00")
    min_fee: Decimal = Decimal("0.00")
    slippage_bps: Decimal = Decimal("0")
    periods_per_year: int = 252

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("initial_cash", "fee_per_share", "min_fee", "slippage_bps")
    def serialize_decimal(self, value: Decimal) -> str:
        return _money(value)


class BacktestTrade(BaseModel):
    timestamp: datetime
    side: BacktestSide
    quantity: Decimal
    price: Decimal
    fee: Decimal
    cash_after: Decimal
    position_after: Decimal

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("quantity", "price", "fee", "cash_after", "position_after")
    def serialize_decimal(self, value: Decimal) -> str:
        return _money(value)


class BacktestMetrics(BaseModel):
    total_return_pct: Decimal
    annualized_return_pct: Decimal
    benchmark_return_pct: Decimal
    max_drawdown_pct: Decimal
    sharpe_ratio: Decimal
    win_rate_pct: Decimal
    profit_factor: Decimal | None
    average_win: Decimal | None
    average_loss: Decimal | None
    exposure_pct: Decimal
    trade_count: int

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer(
        "total_return_pct",
        "annualized_return_pct",
        "benchmark_return_pct",
        "max_drawdown_pct",
        "sharpe_ratio",
        "win_rate_pct",
        "profit_factor",
        "average_win",
        "average_loss",
        "exposure_pct",
    )
    def serialize_decimal(self, value: Decimal | None) -> str | None:
        return _money(value) if value is not None else None


class BacktestResult(BaseModel):
    strategy: StrategyParameters
    config: BacktestConfig
    start: datetime
    end: datetime
    final_equity: Decimal
    benchmark_final_equity: Decimal
    metrics: BacktestMetrics
    trades: list[BacktestTrade]
    equity_curve: list[Decimal]

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer("final_equity", "benchmark_final_equity")
    def serialize_decimal(self, value: Decimal) -> str:
        return _money(value)

    @field_serializer("equity_curve")
    def serialize_equity_curve(self, value: list[Decimal]) -> list[str]:
        return [_money(item) for item in value]


class TimeSplit(BaseModel):
    train_start: datetime
    train_end: datetime
    test_start: datetime
    test_end: datetime
    train_indices: tuple[int, int]
    test_indices: tuple[int, int]


class WalkForwardFoldResult(BaseModel):
    split: TimeSplit
    selected_parameters: StrategyParameters
    train_metrics: BacktestMetrics
    test_metrics: BacktestMetrics


class WalkForwardResult(BaseModel):
    folds: list[WalkForwardFoldResult]
