"""Multi-timeframe intraday analysis (Phase 25).

Pure, stateless function: given already-closed 1h/15m/5m bars and a live
snapshot, decide whether an intraday long entry is warranted right now.

    1h  -> trend direction (EMA fast/slow)
    15m -> setup confirmation (momentum + volume must agree with the 1h trend)
    5m  -> entry timing (momentum + volume trigger)

No look-ahead: every bar list is trimmed to timestamps <= `now` before any
indicator is computed, and only the live snapshot (never historical bars) is
used for the current entry price / spread. Long-only: the strategy emits BUY
entries only. Exits are handled automatically downstream (bracket SL/TP,
maximum holding time, end-of-day force-close) rather than via a second
strategy-emitted SELL signal — see docs/PAPER_BROKER.md.
"""

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer

from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.common.session import SessionStatus, session_status_for

from .config import IntradayStrategyConfig
from .indicators import atr, ema, roc_pct, volume_ratio

__all__ = [
    "IntradayAnalysis",
    "IntradayDecision",
    "SessionStatus",
    "TrendDirection",
    "analyze_multi_timeframe",
    "session_status",
]


class TrendDirection(StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    FLAT = "FLAT"


class IntradayDecision(StrEnum):
    BUY = "BUY"
    HOLD = "HOLD"


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class IntradayAnalysis(BaseModel):
    symbol: str
    as_of: str
    decision: IntradayDecision
    confidence: float
    reasons: list[str]

    trend_direction: TrendDirection
    trend_strength_pct: Decimal
    setup_momentum_pct: Decimal
    setup_volume_ratio: Decimal
    setup_confirmed: bool
    entry_momentum_pct: Decimal
    entry_volume_ratio: Decimal
    entry_confirmed: bool
    volume_signal: str  # CONFIRMED | WEAK

    atr: Decimal
    atr_pct: Decimal
    spread_pct: Decimal
    liquidity_ok: bool

    entry_price: Decimal
    stop_loss: Decimal | None
    take_profit: Decimal | None
    risk_reward: Decimal | None
    expected_holding_minutes: int

    session_status: SessionStatus

    model_config = {"arbitrary_types_allowed": True}

    @field_serializer(
        "trend_strength_pct",
        "setup_momentum_pct",
        "setup_volume_ratio",
        "entry_momentum_pct",
        "entry_volume_ratio",
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
    trend_up: bool,
    setup_confirmed: bool,
    entry_confirmed: bool,
    risk_reward: Decimal | None,
    min_risk_reward: Decimal,
) -> float:
    """Deterministic confidence in [0, 1].

    Below 3/3 confirmations (trend + setup + entry), confidence is capped at
    0.5 and simply reflects how many of the three agree. With all three
    confirmed, confidence scales from 0.5 up to 1.0 with how far the
    ATR-derived risk/reward clears the configured minimum — a marginal pass
    is a weaker signal than a comfortable one.
    """
    confirmations = sum([trend_up, setup_confirmed, entry_confirmed])
    if confirmations < 3 or risk_reward is None or risk_reward <= 0:
        return round(confirmations / 3 * 0.5, 4)
    reward_margin = float(risk_reward / min_risk_reward) if min_risk_reward > 0 else 1.0
    return round(max(0.5, min(1.0, 0.5 + (reward_margin - 1) * 0.25)), 4)


def session_status(now: datetime, config: IntradayStrategyConfig) -> SessionStatus:
    return session_status_for(config.session, now)


def _closed_bars(bars: list[MarketBar], now: datetime) -> list[MarketBar]:
    """Bars strictly at-or-before `now`, sorted ascending. Defensively drops
    any bar a provider might otherwise return for a still-forming period —
    the only source of "future" or in-progress data this function accepts.
    """
    return sorted((bar for bar in bars if bar.timestamp <= now), key=lambda b: b.timestamp)


def analyze_multi_timeframe(
    *,
    symbol: str,
    bars_1h: list[MarketBar],
    bars_15m: list[MarketBar],
    bars_5m: list[MarketBar],
    snapshot: MarketSnapshot,
    config: IntradayStrategyConfig,
    now: datetime | None = None,
) -> IntradayAnalysis:
    as_of = now or datetime.now(tz=UTC)
    h1 = _closed_bars(bars_1h, as_of)
    m15 = _closed_bars(bars_15m, as_of)
    m5 = _closed_bars(bars_5m, as_of)

    reasons: list[str] = []
    session = session_status(as_of, config)
    if session != SessionStatus.OPEN_FOR_ENTRIES:
        reasons.append(f"Session status is {session.value}; new entries are not permitted")

    if len(h1) < config.required_1h_bars:
        reasons.append(f"Insufficient 1h history: have {len(h1)}, need {config.required_1h_bars}")
    if len(m15) < config.required_15m_bars:
        reasons.append(
            f"Insufficient 15m history: have {len(m15)}, need {config.required_15m_bars}"
        )
    if len(m5) < config.required_5m_bars:
        reasons.append(f"Insufficient 5m history: have {len(m5)}, need {config.required_5m_bars}")

    if reasons:
        return _hold(symbol, as_of, session, snapshot, reasons)

    h1_closes = [bar.close for bar in h1]
    ema_fast = ema(h1_closes[-(config.trend_ema_fast * 3) :], config.trend_ema_fast)
    ema_slow = ema(h1_closes[-(config.trend_ema_slow * 3) :], config.trend_ema_slow)
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

    m15_closes = [bar.close for bar in m15]
    m15_volumes = [bar.volume for bar in m15]
    setup_momentum_pct = roc_pct(m15_closes, config.setup_momentum_window)
    setup_volume = volume_ratio(m15_volumes, config.setup_volume_window)
    setup_confirmed = (
        trend_direction == TrendDirection.UP
        and setup_momentum_pct > 0
        and setup_volume >= config.min_volume_ratio
    )

    m5_closes = [bar.close for bar in m5]
    m5_volumes = [bar.volume for bar in m5]
    entry_momentum_pct = roc_pct(m5_closes, config.entry_momentum_window)
    entry_volume = volume_ratio(m5_volumes, config.entry_volume_window)
    entry_confirmed = entry_momentum_pct > 0 and entry_volume >= config.min_volume_ratio

    volume_signal = (
        "CONFIRMED"
        if setup_volume >= config.min_volume_ratio and entry_volume >= config.min_volume_ratio
        else "WEAK"
    )

    atr_value = atr(m5, config.atr_window)
    entry_price = snapshot.price
    atr_pct = (atr_value / entry_price * Decimal("100")) if entry_price != 0 else Decimal("0")

    mid = (snapshot.bid + snapshot.ask) / 2
    spread_pct = ((snapshot.ask - snapshot.bid) / mid * Decimal("100")) if mid > 0 else Decimal("0")
    liquidity_ok = spread_pct <= config.max_spread_pct and not snapshot.is_stale

    stop_loss = entry_price - atr_value * config.stop_atr_multiple
    take_profit = entry_price + atr_value * config.take_profit_atr_multiple
    risk_per_share = entry_price - stop_loss
    risk_reward = (
        (take_profit - entry_price) / risk_per_share if risk_per_share > 0 else Decimal("0")
    )

    if trend_direction != TrendDirection.UP:
        reasons.append("1h trend is not UP")
    if not setup_confirmed:
        reasons.append("15m setup (momentum + volume) does not confirm the 1h trend")
    if not entry_confirmed:
        reasons.append("5m entry timing (momentum + volume) not triggered")
    if not liquidity_ok:
        reasons.append(
            f"Spread {spread_pct:.4f}% exceeds max {config.max_spread_pct}% or data is stale"
        )
    if risk_per_share <= 0:
        reasons.append("ATR-based stop distance is non-positive")
    elif risk_reward < config.min_risk_reward:
        reasons.append(f"Risk/reward {risk_reward:.2f} below minimum {config.min_risk_reward}")

    decision = (
        IntradayDecision.BUY
        if not reasons and session == SessionStatus.OPEN_FOR_ENTRIES
        else IntradayDecision.HOLD
    )
    if decision == IntradayDecision.BUY:
        reasons = [
            "1h trend UP, 15m setup confirmed, 5m entry timing confirmed,"
            " liquidity and risk/reward checks passed",
        ]

    confidence = _confidence(
        trend_up=trend_direction == TrendDirection.UP,
        setup_confirmed=setup_confirmed,
        entry_confirmed=entry_confirmed,
        risk_reward=risk_reward if risk_per_share > 0 else None,
        min_risk_reward=config.min_risk_reward,
    )

    return IntradayAnalysis(
        symbol=symbol,
        as_of=as_of.isoformat(),
        decision=decision,
        confidence=confidence,
        reasons=reasons,
        trend_direction=trend_direction,
        trend_strength_pct=trend_strength_pct,
        setup_momentum_pct=setup_momentum_pct,
        setup_volume_ratio=setup_volume,
        setup_confirmed=setup_confirmed,
        entry_momentum_pct=entry_momentum_pct,
        entry_volume_ratio=entry_volume,
        entry_confirmed=entry_confirmed,
        volume_signal=volume_signal,
        atr=atr_value,
        atr_pct=atr_pct,
        spread_pct=spread_pct,
        liquidity_ok=liquidity_ok,
        entry_price=entry_price,
        stop_loss=stop_loss if decision == IntradayDecision.BUY else None,
        take_profit=take_profit if decision == IntradayDecision.BUY else None,
        risk_reward=risk_reward if risk_per_share > 0 else None,
        expected_holding_minutes=config.max_holding_minutes,
        session_status=session,
    )


def _hold(
    symbol: str,
    as_of: datetime,
    session: SessionStatus,
    snapshot: MarketSnapshot,
    reasons: list[str],
) -> IntradayAnalysis:
    zero = Decimal("0")
    return IntradayAnalysis(
        symbol=symbol,
        as_of=as_of.isoformat(),
        decision=IntradayDecision.HOLD,
        confidence=0.0,
        reasons=reasons,
        trend_direction=TrendDirection.FLAT,
        trend_strength_pct=zero,
        setup_momentum_pct=zero,
        setup_volume_ratio=zero,
        setup_confirmed=False,
        entry_momentum_pct=zero,
        entry_volume_ratio=zero,
        entry_confirmed=False,
        volume_signal="WEAK",
        atr=zero,
        atr_pct=zero,
        spread_pct=zero,
        liquidity_ok=False,
        entry_price=snapshot.price,
        stop_loss=None,
        take_profit=None,
        risk_reward=None,
        expected_holding_minutes=0,
        session_status=session,
    )
