"""Single-timeframe hourly analysis (Phase 27).

Pure, stateless function: given already-closed 1H bars and a live snapshot,
decide BUY / SELL / HOLD for the primary hourly entry/exit timeframe. Unlike
Phase 25/26's three-timeframe composite, entry decisions here come entirely
from ONE closed 1H candle series — a higher timeframe (N closed 1H bars
folded into one via strategy.intraday.bars.resample_closed_bars) may only
VETO a signal as confirmation, never trigger one on its own.

No look-ahead: bars are trimmed to timestamps <= `now` before any indicator
is computed, and only the live snapshot (never historical bars) is used for
the current entry price / spread — identical guarantee to intraday/crypto.
Bidirectional like crypto: BUY opens a long (ATR bracket); SELL only closes
an existing long (this PAPER broker cannot short — see
broker/paper_broker.py._check_funds) and is only emitted when the caller
confirms a position is actually held (`has_open_position`).
"""

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer

from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.common.session import SessionStatus, session_status_for
from strategy.intraday.bars import resample_closed_bars
from strategy.intraday.indicators import atr, ema, roc_pct, volume_ratio

from .config import HourlyStrategyConfig

STRATEGY_VERSION = "27.0.0"


class TrendDirection(StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    FLAT = "FLAT"


class HourlyDecision(StrEnum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class HourlyAnalysis(BaseModel):
    symbol: str
    as_of: str
    candle_timestamp: str
    decision: HourlyDecision
    confidence: float
    reasons: list[str]
    strategy_version: str = STRATEGY_VERSION

    trend_direction: TrendDirection
    trend_strength_pct: Decimal
    momentum_pct: Decimal
    volume_ratio: Decimal
    breakout: bool
    pullback: bool

    higher_tf_trend_direction: TrendDirection
    higher_tf_confirmed: bool

    atr: Decimal
    atr_pct: Decimal
    spread_pct: Decimal
    liquidity_ok: bool

    entry_price: Decimal
    stop_loss: Decimal | None
    take_profit: Decimal | None
    risk_reward: Decimal | None
    expected_holding_hours: int

    session_status: SessionStatus

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer(
        "trend_strength_pct",
        "momentum_pct",
        "volume_ratio",
        "atr",
        "atr_pct",
        "spread_pct",
        "entry_price",
    )
    def _ser_dec(self, v: Decimal) -> str:
        return _money(v)

    @field_serializer("stop_loss", "take_profit", "risk_reward")
    def _ser_opt_dec(self, v: Decimal | None) -> str | None:
        return _money(v) if v is not None else None


def _confidence(
    *,
    trend_confirmed: bool,
    structure_confirmed: bool,
    higher_tf_confirmed: bool,
    risk_reward: Decimal | None,
    min_risk_reward: Decimal,
) -> float:
    """Deterministic confidence in [0, 1] — same shape as intraday/crypto's.

    BUY decisions scale confidence with how far the ATR-derived risk/reward
    clears the configured minimum. SELL (exit) decisions have no risk/reward
    of their own, so confidence there reflects only the 3-way confirmation
    count, capped at 0.75 — a SELL is a lower-stakes "close what you have"
    action, not a new risk-budgeted entry.
    """
    confirmations = sum([trend_confirmed, structure_confirmed, higher_tf_confirmed])
    if confirmations < 3:
        return round(confirmations / 3 * 0.5, 4)
    if risk_reward is None or risk_reward <= 0:
        return 0.75
    reward_margin = float(risk_reward / min_risk_reward) if min_risk_reward > 0 else 1.0
    return round(max(0.5, min(1.0, 0.5 + (reward_margin - 1) * 0.25)), 4)


def _closed_bars(bars: list[MarketBar], now: datetime) -> list[MarketBar]:
    """Bars strictly at-or-before `now`, sorted ascending — the no-look-ahead
    guard. Only source of "future" or in-progress data this function drops.
    """
    return sorted((bar for bar in bars if bar.timestamp <= now), key=lambda b: b.timestamp)


def _price_structure(bars: list[MarketBar], lookback: int) -> tuple[bool, bool]:
    """Breakout/pullback context from the rolling `lookback`-bar high/low,
    excluding the latest (just-closed) bar itself.

    breakout -> latest close is beyond the prior `lookback`-bar range
    pullback -> latest close has retraced back inside the prior range
                (a continuation entry context, not a fresh breakout)
    """
    window = bars[-(lookback + 1) : -1]
    if not window:
        return False, False
    highest = max(b.high for b in window)
    lowest = min(b.low for b in window)
    latest_close = bars[-1].close
    breakout = latest_close > highest or latest_close < lowest
    pullback = lowest <= latest_close <= highest
    return breakout, pullback


def analyze_hourly(
    *,
    symbol: str,
    bars_1h: list[MarketBar],
    snapshot: MarketSnapshot,
    config: HourlyStrategyConfig,
    has_open_position: bool = False,
    now: datetime | None = None,
) -> HourlyAnalysis:
    as_of = now or datetime.now(tz=UTC)
    h1 = _closed_bars(bars_1h, as_of)

    reasons: list[str] = []
    session = session_status_for(config.session, as_of)
    if session != SessionStatus.OPEN_FOR_ENTRIES:
        reasons.append(f"Session status is {session.value}; new entries are not permitted")
    if len(h1) < config.required_1h_bars:
        reasons.append(f"Insufficient 1h history: have {len(h1)}, need {config.required_1h_bars}")
    if reasons:
        return _hold(symbol, as_of, session, snapshot, reasons)

    closes = [bar.close for bar in h1]
    volumes = [bar.volume for bar in h1]
    candle_timestamp = h1[-1].timestamp

    ema_fast = ema(closes[-(config.trend_ema_fast * 3) :], config.trend_ema_fast)
    ema_slow = ema(closes[-(config.trend_ema_slow * 3) :], config.trend_ema_slow)
    trend_strength_pct = (
        (ema_fast - ema_slow) / ema_slow * Decimal("100") if ema_slow != 0 else Decimal("0")
    )
    trend_direction = (
        TrendDirection.UP
        if ema_fast > ema_slow
        else TrendDirection.DOWN
        if ema_fast < ema_slow
        else TrendDirection.FLAT
    )

    momentum_pct = roc_pct(closes, config.momentum_window)
    vol_ratio = volume_ratio(volumes, config.volume_window)
    breakout, pullback = _price_structure(h1, config.breakout_lookback_bars)

    atr_value = atr(h1, config.atr_window)
    entry_price = snapshot.price
    atr_pct = (atr_value / entry_price * Decimal("100")) if entry_price != 0 else Decimal("0")

    mid = (snapshot.bid + snapshot.ask) / 2
    spread_pct = ((snapshot.ask - snapshot.bid) / mid * Decimal("100")) if mid > 0 else Decimal("0")
    liquidity_ok = spread_pct <= config.max_spread_pct and not snapshot.is_stale

    higher_tf_bars = resample_closed_bars(h1, config.higher_tf_bars_per_candle)
    higher_tf_trend = TrendDirection.FLAT
    higher_tf_confirmed = not config.higher_tf_confirmation_required
    if len(higher_tf_bars) >= config.trend_ema_slow + 1:
        htf_closes = [bar.close for bar in higher_tf_bars]
        htf_fast = ema(htf_closes[-(config.trend_ema_fast * 3) :], config.trend_ema_fast)
        htf_slow = ema(htf_closes[-(config.trend_ema_slow * 3) :], config.trend_ema_slow)
        higher_tf_trend = (
            TrendDirection.UP
            if htf_fast > htf_slow
            else TrendDirection.DOWN
            if htf_fast < htf_slow
            else TrendDirection.FLAT
        )
        higher_tf_confirmed = (
            higher_tf_trend == trend_direction
            if config.higher_tf_confirmation_required
            else True
        )
    elif config.higher_tf_confirmation_required:
        higher_tf_confirmed = False

    is_long_setup = trend_direction == TrendDirection.UP
    is_short_setup = trend_direction == TrendDirection.DOWN
    setup_confirmed = (
        (is_long_setup and momentum_pct > 0) or (is_short_setup and momentum_pct < 0)
    ) and vol_ratio >= config.min_volume_ratio

    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    risk_reward: Decimal | None = None
    decision = HourlyDecision.HOLD

    can_enter_long = (
        is_long_setup
        and setup_confirmed
        and higher_tf_confirmed
        and liquidity_ok
        and not has_open_position
    )
    can_exit_on_reversal = (
        is_short_setup
        and setup_confirmed
        and higher_tf_confirmed
        and liquidity_ok
        and has_open_position
    )

    if can_enter_long:
        stop_loss = entry_price - atr_value * config.stop_atr_multiple
        take_profit = entry_price + atr_value * config.take_profit_atr_multiple
        risk_per_share = entry_price - stop_loss
        risk_reward = (
            (take_profit - entry_price) / risk_per_share if risk_per_share > 0 else Decimal("0")
        )
        if risk_per_share <= 0:
            reasons.append("ATR-based stop distance is non-positive")
            stop_loss = None
            take_profit = None
        elif risk_reward < config.min_risk_reward:
            reasons.append(f"Risk/reward {risk_reward:.2f} below minimum {config.min_risk_reward}")
        else:
            decision = HourlyDecision.BUY
    elif can_exit_on_reversal:
        decision = HourlyDecision.SELL
    else:
        if is_long_setup and has_open_position:
            reasons.append("Bullish trend confirmed but a position is already open")
        if (
            is_short_setup
            and setup_confirmed
            and higher_tf_confirmed
            and liquidity_ok
            and not has_open_position
        ):
            reasons.append("Bearish reversal confirmed but no open position to close")
        if trend_direction == TrendDirection.FLAT:
            reasons.append("1h trend is FLAT")
        if not setup_confirmed:
            reasons.append("1h momentum/volume does not confirm the trend")
        if not higher_tf_confirmed:
            reasons.append("Higher-timeframe trend does not confirm the 1h trend")
        if not liquidity_ok:
            reasons.append(
                f"Spread {spread_pct:.4f}% exceeds max {config.max_spread_pct}% or data is stale"
            )

    if decision == HourlyDecision.BUY:
        reasons = [
            "1h trend UP, momentum/volume and higher-timeframe confirmed,"
            " liquidity and risk/reward checks passed",
        ]
    elif decision == HourlyDecision.SELL:
        reasons = [
            "1h trend reversed DOWN, momentum/volume and higher-timeframe confirmed:"
            " closing existing long position",
        ]

    confidence = _confidence(
        trend_confirmed=is_long_setup or is_short_setup,
        structure_confirmed=setup_confirmed,
        higher_tf_confirmed=higher_tf_confirmed,
        risk_reward=risk_reward,
        min_risk_reward=config.min_risk_reward,
    )

    return HourlyAnalysis(
        symbol=symbol,
        as_of=as_of.isoformat(),
        candle_timestamp=candle_timestamp.isoformat(),
        decision=decision,
        confidence=confidence,
        reasons=reasons,
        trend_direction=trend_direction,
        trend_strength_pct=trend_strength_pct,
        momentum_pct=momentum_pct,
        volume_ratio=vol_ratio,
        breakout=breakout,
        pullback=pullback,
        higher_tf_trend_direction=higher_tf_trend,
        higher_tf_confirmed=higher_tf_confirmed,
        atr=atr_value,
        atr_pct=atr_pct,
        spread_pct=spread_pct,
        liquidity_ok=liquidity_ok,
        entry_price=entry_price,
        stop_loss=stop_loss,
        take_profit=take_profit,
        risk_reward=risk_reward,
        expected_holding_hours=config.max_holding_hours,
        session_status=session,
    )


def _hold(
    symbol: str,
    as_of: datetime,
    session: SessionStatus,
    snapshot: MarketSnapshot,
    reasons: list[str],
) -> HourlyAnalysis:
    zero = Decimal("0")
    return HourlyAnalysis(
        symbol=symbol,
        as_of=as_of.isoformat(),
        candle_timestamp=as_of.isoformat(),
        decision=HourlyDecision.HOLD,
        confidence=0.0,
        reasons=reasons,
        trend_direction=TrendDirection.FLAT,
        trend_strength_pct=zero,
        momentum_pct=zero,
        volume_ratio=zero,
        breakout=False,
        pullback=False,
        higher_tf_trend_direction=TrendDirection.FLAT,
        higher_tf_confirmed=False,
        atr=zero,
        atr_pct=zero,
        spread_pct=zero,
        liquidity_ok=False,
        entry_price=snapshot.price,
        stop_loss=None,
        take_profit=None,
        risk_reward=None,
        expected_holding_hours=0,
        session_status=session,
    )
