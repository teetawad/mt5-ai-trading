from __future__ import annotations

from datetime import UTC, datetime, timedelta
from decimal import Decimal

from mt5.strategy import analyze_completed_h1


def _bars(start: Decimal, step: Decimal, count: int = 40) -> list[dict]:
    base = datetime(2026, 1, 1, tzinfo=UTC)
    rows: list[dict] = []
    for index in range(count):
        close = start + step * Decimal(index)
        rows.append(
            {
                "time": int((base + timedelta(hours=index)).timestamp()),
                "open": close - step,
                "high": close + Decimal("0.0005"),
                "low": close - Decimal("0.0005"),
                "close": close,
                "tick_volume": 100,
            }
        )
    return rows


def test_market_now_entry_plan_for_acceptable_current_price() -> None:
    bars = _bars(Decimal("1.1000"), Decimal("0.0001"))
    tick = {"bid": "1.1038", "ask": "1.1039", "time": int(datetime.now(tz=UTC).timestamp())}
    decision = analyze_completed_h1("EURUSD", bars, tick, Decimal("0.00001"))

    assert decision.decision == "BUY"
    assert decision.entry_strategy == "MARKET_NOW"
    assert decision.current_entry_status == "READY"
    assert decision.valid_until > decision.signal_candle_timestamp


def test_pullback_entry_plan_waits_for_better_price() -> None:
    bars = _bars(Decimal("1.1000"), Decimal("0.0001"))
    tick = {"bid": "1.1043", "ask": "1.1044", "time": int(datetime.now(tz=UTC).timestamp())}
    decision = analyze_completed_h1("EURUSD", bars, tick, Decimal("0.00001"))

    assert decision.decision == "BUY"
    assert decision.entry_strategy == "PULLBACK"
    assert decision.current_entry_status == "WAITING"
    assert decision.entry_zone_low is not None
    assert decision.entry_zone_high is not None


def test_no_entry_plan_for_no_trade_decision() -> None:
    bars = _bars(Decimal("1.1000"), Decimal("0"))
    tick = {"bid": "1.1000", "ask": "1.1001", "time": int(datetime.now(tz=UTC).timestamp())}
    decision = analyze_completed_h1("EURUSD", bars, tick, Decimal("0.00001"))

    assert decision.decision == "NO_TRADE"
    assert decision.entry_strategy == "NO_ENTRY"
    assert decision.current_entry_status == "BLOCKED"
