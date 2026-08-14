"""Multi-timeframe crypto analysis (Phase 26).

24/7 analog of strategy/intraday/analysis.py's multi-timeframe pipeline
(1h trend / 15m setup / 5m entry), with two differences:

  - No session gating: crypto markets never close, so there is no
    SessionStatus concept here — `market_status` is always "OPEN_24_7", kept
    as an explicit field so the UI can still show a market-status badge
    matching the intraday page's session badge.
  - Bidirectional decision: BUY opens/adds to a long (ATR-based bracket
    SL/TP, same sizing approach as intraday). SELL means "close an existing
    long because the 1h trend has reversed down" — this PAPER broker does
    not support short selling (see broker/paper_broker.py._check_funds), so
    SELL is only ever an exit signal, never a new bracket entry, and is only
    emitted when the caller confirms a position is actually held
    (`has_open_position`). Node-side risk controls additionally guard this
    (mirrors the existing AVAILABLE_POSITION check in risk.engine).

No look-ahead: every bar list is trimmed to timestamps <= `now` before any
indicator is computed, and only the live snapshot (never historical bars) is
used for the current price / spread — identical guarantee to intraday.
"""

from datetime import UTC, datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, field_serializer

from market_data.snapshot import MarketBar, MarketSnapshot
from strategy.intraday.indicators import atr, ema, roc_pct, volume_ratio

from .config import CryptoStrategyConfig


class TrendDirection(StrEnum):
    UP = "UP"
    DOWN = "DOWN"
    FLAT = "FLAT"


class CryptoDecision(StrEnum):
    BUY = "BUY"
    SELL = "SELL"
    HOLD = "HOLD"


def _money(value: Decimal) -> str:
    return str(value.quantize(Decimal("0.00000001")))


class CryptoAnalysis(BaseModel):
    symbol: str
    as_of: str
    decision: CryptoDecision
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

    market_status: str  # always "OPEN_24_7" — crypto markets never close

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
    trend_confirmed: bool,
    setup_confirmed: bool,
    entry_confirmed: bool,
    risk_reward: Decimal | None,
    min_risk_reward: Decimal,
) -> float:
    """Deterministic confidence in [0, 1] — same shape as intraday's, direction-agnostic.

    BUY decisions scale confidence with how far the ATR-derived risk/reward
    clears the configured minimum. SELL (exit) decisions have no risk/reward
    of their own, so confidence there reflects only the 3-way confirmation
    count, capped at 0.75 — a SELL is a lower-stakes "close what you have"
    action, not a new risk-budgeted entry.
    """
    confirmations = sum([trend_confirmed, setup_confirmed, entry_confirmed])
    if confirmations < 3:
        return round(confirmations / 3 * 0.5, 4)
    if risk_reward is None or risk_reward <= 0:
        return 0.75
    reward_margin = float(risk_reward / min_risk_reward) if min_risk_reward > 0 else 1.0
    return round(max(0.5, min(1.0, 0.5 + (reward_margin - 1) * 0.25)), 4)


def _closed_bars(bars: list[MarketBar], now: datetime) -> list[MarketBar]:
    return sorted((bar for bar in bars if bar.timestamp <= now), key=lambda b: b.timestamp)


def analyze_crypto_multi_timeframe(
    *,
    symbol: str,
    bars_1h: list[MarketBar],
    bars_15m: list[MarketBar],
    bars_5m: list[MarketBar],
    snapshot: MarketSnapshot,
    config: CryptoStrategyConfig,
    has_open_position: bool = False,
    now: datetime | None = None,
) -> CryptoAnalysis:
    as_of = now or datetime.now(tz=UTC)
    h1 = _closed_bars(bars_1h, as_of)
    m15 = _closed_bars(bars_15m, as_of)
    m5 = _closed_bars(bars_5m, as_of)

    reasons: list[str] = []

    if len(h1) < config.required_1h_bars:
        reasons.append(f"Insufficient 1h history: have {len(h1)}, need {config.required_1h_bars}")
    if len(m15) < config.required_15m_bars:
        reasons.append(
            f"Insufficient 15m history: have {len(m15)}, need {config.required_15m_bars}"
        )
    if len(m5) < config.required_5m_bars:
        reasons.append(f"Insufficient 5m history: have {len(m5)}, need {config.required_5m_bars}")

    if reasons:
        return _hold(symbol, as_of, snapshot, reasons)

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

    m5_closes = [bar.close for bar in m5]
    m5_volumes = [bar.volume for bar in m5]
    entry_momentum_pct = roc_pct(m5_closes, config.entry_momentum_window)
    entry_volume = volume_ratio(m5_volumes, config.entry_volume_window)

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

    is_long_setup = trend_direction == TrendDirection.UP
    is_short_setup = trend_direction == TrendDirection.DOWN

    setup_confirmed = (
        is_long_setup
        and setup_momentum_pct > 0
        and setup_volume >= config.min_volume_ratio
    ) or (
        is_short_setup
        and setup_momentum_pct < 0
        and setup_volume >= config.min_volume_ratio
    )
    entry_confirmed = (
        is_long_setup
        and entry_momentum_pct > 0
        and entry_volume >= config.min_volume_ratio
    ) or (
        is_short_setup
        and entry_momentum_pct < 0
        and entry_volume >= config.min_volume_ratio
    )

    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    risk_reward: Decimal | None = None
    decision = CryptoDecision.HOLD

    if is_long_setup and setup_confirmed and entry_confirmed and liquidity_ok:
        stop_loss = entry_price - atr_value * config.stop_atr_multiple
        take_profit = entry_price + atr_value * config.take_profit_atr_multiple
        risk_per_unit = entry_price - stop_loss
        risk_reward = (
            (take_profit - entry_price) / risk_per_unit if risk_per_unit > 0 else Decimal("0")
        )
        if risk_per_unit <= 0:
            reasons.append("ATR-based stop distance is non-positive")
            stop_loss = None
            take_profit = None
        elif risk_reward < config.min_risk_reward:
            reasons.append(f"Risk/reward {risk_reward:.2f} below minimum {config.min_risk_reward}")
        else:
            decision = CryptoDecision.BUY
    elif is_short_setup and setup_confirmed and entry_confirmed and liquidity_ok:
        if has_open_position:
            decision = CryptoDecision.SELL
        else:
            reasons.append("Bearish reversal confirmed but no open position to close")
    else:
        if trend_direction == TrendDirection.FLAT:
            reasons.append("1h trend is FLAT")
        if not setup_confirmed:
            reasons.append("15m setup (momentum + volume) does not confirm the 1h trend")
        if not entry_confirmed:
            reasons.append("5m entry timing (momentum + volume) not triggered")
        if not liquidity_ok:
            reasons.append(
                f"Spread {spread_pct:.4f}% exceeds max {config.max_spread_pct}% or data is stale"
            )

    if decision == CryptoDecision.BUY:
        reasons = [
            "1h trend UP, 15m setup confirmed, 5m entry timing confirmed,"
            " liquidity and risk/reward checks passed",
        ]
    elif decision == CryptoDecision.SELL:
        reasons = [
            "1h trend reversed DOWN, 15m setup confirmed, 5m entry timing confirmed:"
            " closing existing long position",
        ]

    confidence = _confidence(
        trend_confirmed=is_long_setup or is_short_setup,
        setup_confirmed=setup_confirmed,
        entry_confirmed=entry_confirmed,
        risk_reward=risk_reward,
        min_risk_reward=config.min_risk_reward,
    )

    return CryptoAnalysis(
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
        stop_loss=stop_loss,
        take_profit=take_profit,
        risk_reward=risk_reward,
        market_status="OPEN_24_7",
    )


def _hold(
    symbol: str,
    as_of: datetime,
    snapshot: MarketSnapshot,
    reasons: list[str],
) -> CryptoAnalysis:
    zero = Decimal("0")
    return CryptoAnalysis(
        symbol=symbol,
        as_of=as_of.isoformat(),
        decision=CryptoDecision.HOLD,
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
        market_status="OPEN_24_7",
    )
