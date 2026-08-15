"""Shared US-market session-status gating.

Extracted from strategy/intraday/analysis.py so it can be reused by any
single- or multi-timeframe strategy that gates entries around the regular
market session (Phase 25 intraday, Phase 27 hourly) without a third copy of
the same boundary math. `strategy.intraday.analysis.session_status` remains
a one-line delegator to `session_status_for` below, so existing imports of
`SessionStatus`/`session_status` from that module are unaffected.
"""

from datetime import datetime, time, timedelta
from enum import StrEnum

from strategy.intraday.config import IntradaySessionConfig


class SessionStatus(StrEnum):
    CLOSED = "CLOSED"
    OPEN_FOR_ENTRIES = "OPEN_FOR_ENTRIES"
    NO_NEW_TRADES_NEAR_CLOSE = "NO_NEW_TRADES_NEAR_CLOSE"
    FORCE_CLOSE_WINDOW = "FORCE_CLOSE_WINDOW"


def session_status_for(session: IntradaySessionConfig, now: datetime) -> SessionStatus:
    open_time = time.fromisoformat(session.market_open)
    close_time = time.fromisoformat(session.market_close)
    current = now.timetz().replace(tzinfo=None)
    if current < open_time or current >= close_time:
        return SessionStatus.CLOSED

    close_today = now.replace(
        hour=close_time.hour, minute=close_time.minute, second=0, microsecond=0
    )
    remaining = close_today - now
    if session.force_close_enabled and remaining <= timedelta(
        minutes=session.force_close_before_close_minutes
    ):
        return SessionStatus.FORCE_CLOSE_WINDOW
    if remaining <= timedelta(minutes=session.no_new_trades_minutes_before_close):
        return SessionStatus.NO_NEW_TRADES_NEAR_CLOSE
    return SessionStatus.OPEN_FOR_ENTRIES
