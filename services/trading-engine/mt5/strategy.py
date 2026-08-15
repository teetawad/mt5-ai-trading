from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any


@dataclass(frozen=True)
class BaselineDecision:
    symbol: str
    bid: str | None
    ask: str | None
    spread: str | None
    quote_timestamp: str | None
    market_state: str
    decision: str
    confidence: float
    opportunity_score: float
    reasons: list[str]
    reference_entry: str
    stop_loss: str | None
    take_profit: str | None
    risk_reward: str | None
    expected_holding_hours: int
    signal_candle_timestamp: str
    model_version: str
    features: dict[str, Any]


def _d(value: Any) -> Decimal:
    return Decimal(str(value))


def _q(value: Decimal) -> str:
    return value.quantize(Decimal("0.00000001")).to_eng_string()


def analyze_completed_h1(
    symbol: str, bars_h1: list[dict[str, Any]], tick: dict[str, Any], point: Decimal
) -> BaselineDecision:
    """Deterministic BASELINE strategy over completed H1 candles only."""

    closed = sorted(bars_h1, key=lambda b: b["time"])
    bid = _d(tick.get("bid") or 0)
    ask = _d(tick.get("ask") or 0)
    spread = ask - bid if ask and bid else Decimal(0)
    tick_time = tick.get("time")
    quote_timestamp = (
        datetime.fromtimestamp(int(tick_time), tz=UTC).isoformat()
        if tick_time
        else None
    )
    age_seconds = (
        (datetime.now(tz=UTC) - datetime.fromtimestamp(int(tick_time), tz=UTC)).total_seconds()
        if tick_time
        else None
    )
    market_state = "MARKET_CLOSED" if age_seconds is not None and age_seconds > 900 else "LIVE"

    if len(closed) < 30:
        now = datetime.now(tz=UTC).isoformat()
        entry = ask or _d(tick.get("last") or 0)
        return BaselineDecision(
            symbol,
            _q(bid) if bid else None,
            _q(ask) if ask else None,
            _q(spread) if spread else None,
            quote_timestamp,
            market_state,
            "NO_TRADE",
            0,
            0,
            ["Insufficient completed H1 history"],
            _q(entry),
            None,
            None,
            None,
            0,
            now,
            "BASELINE_MT5_H1_V1",
            {},
        )

    latest = closed[-1]
    closes = [_d(b["close"]) for b in closed]
    highs = [_d(b["high"]) for b in closed]
    lows = [_d(b["low"]) for b in closed]
    volumes = [Decimal(str(b.get("tick_volume", 0))) for b in closed]
    ema_fast = sum(closes[-8:]) / Decimal(8)
    ema_slow = sum(closes[-21:]) / Decimal(21)
    trend = "UP" if ema_fast > ema_slow else "DOWN" if ema_fast < ema_slow else "FLAT"
    momentum = (closes[-1] - closes[-4]) / closes[-4] * Decimal(100) if closes[-4] else Decimal(0)
    true_ranges = [
        max(highs[i] - lows[i], abs(highs[i] - closes[i - 1]), abs(lows[i] - closes[i - 1]))
        for i in range(1, len(closed))
    ]
    atr = sum(true_ranges[-14:]) / Decimal(14)
    volume_ratio = (
        volumes[-1] / (sum(volumes[-21:-1]) / Decimal(20)) if sum(volumes[-21:-1]) else Decimal(0)
    )
    entry = ask if trend == "UP" else bid
    min_stop_distance = max(atr * Decimal("1.5"), point * Decimal("20"), spread * Decimal("3"))
    decision = "NO_TRADE"
    reasons: list[str] = []

    if spread <= 0 or entry <= 0:
        reasons.append("Invalid bid/ask quote")
    elif market_state == "MARKET_CLOSED":
        decision = "NO_TRADE"
        reasons.append("Market appears closed or quote is stale")
    elif trend == "UP" and momentum > 0 and volume_ratio >= Decimal("0.8"):
        decision = "BUY"
        reasons.append("BASELINE: H1 trend and momentum are positive on a completed candle")
    elif trend == "DOWN" and momentum < 0 and volume_ratio >= Decimal("0.8"):
        decision = "SELL"
        reasons.append("BASELINE: H1 trend and momentum are negative on a completed candle")
    else:
        reasons.append("BASELINE: trend, momentum, or tick-volume context does not justify a trade")

    sl: Decimal | None = None
    tp: Decimal | None = None
    rr: Decimal | None = None
    if decision == "BUY":
        sl = entry - min_stop_distance
        tp = entry + min_stop_distance * Decimal("2")
    elif decision == "SELL":
        sl = entry + min_stop_distance
        tp = entry - min_stop_distance * Decimal("2")
    if sl is not None and tp is not None:
        rr = abs(tp - entry) / abs(entry - sl)

    confidence = (
        0.0
        if decision == "NO_TRADE"
        else float(min(Decimal("0.85"), Decimal("0.45") + abs(momentum) / Decimal("10")))
    )
    opportunity = confidence * 100 if rr is not None and rr >= Decimal("1.5") else confidence * 50
    features = {
        "trend": trend,
        "momentum_pct": _q(momentum),
        "atr": _q(atr),
        "tick_volume_ratio": _q(volume_ratio),
        "spread": _q(spread),
        "average_close_8": _q(ema_fast),
        "average_close_21": _q(ema_slow),
    }
    return BaselineDecision(
        symbol=symbol,
        bid=_q(bid) if bid else None,
        ask=_q(ask) if ask else None,
        spread=_q(spread) if spread else None,
        quote_timestamp=quote_timestamp,
        market_state=market_state,
        decision=decision,
        confidence=round(confidence, 4),
        opportunity_score=round(opportunity, 2),
        reasons=reasons,
        reference_entry=_q(entry),
        stop_loss=_q(sl) if sl is not None else None,
        take_profit=_q(tp) if tp is not None else None,
        risk_reward=_q(rr) if rr is not None else None,
        expected_holding_hours=8 if decision != "NO_TRADE" else 0,
        signal_candle_timestamp=datetime.fromtimestamp(int(latest["time"]), tz=UTC).isoformat(),
        model_version="BASELINE_MT5_H1_V1",
        features=features,
    )
