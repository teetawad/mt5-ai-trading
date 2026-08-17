from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

MarketStatus = Literal["OPEN", "CLOSED", "QUOTE_ONLY", "TRADE_DISABLED", "UNKNOWN"]
DataStatus = Literal["LIVE", "STALE", "DISCONNECTED"]


@dataclass(frozen=True)
class SessionWindow:
    day: int
    open: str
    close: str
    kind: str
    open_seconds: int
    close_seconds: int


@dataclass(frozen=True)
class SymbolSessionStatus:
    symbol: str
    market_status: MarketStatus
    data_status: DataStatus
    session_open: str | None
    session_close: str | None
    next_session_open: str | None
    server_time: str | None
    local_time: str
    quote_time: str | None
    quote_age_seconds: float | None
    reason: str | None
    trade_mode: int | None
    trade_allowed: bool | None
    source: str
    sessions: list[SessionWindow]

    def to_dict(self) -> dict[str, Any]:
        data = asdict(self)
        data["sessions"] = [asdict(session) for session in self.sessions]
        return data


def _obj(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    if hasattr(value, "_asdict"):
        return dict(value._asdict())
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return {"value": value}


def _quote_datetime(tick: dict[str, Any]) -> datetime | None:
    if tick.get("time_msc"):
        return datetime.fromtimestamp(int(tick["time_msc"]) / 1000, tz=UTC)
    if tick.get("time"):
        return datetime.fromtimestamp(int(tick["time"]), tz=UTC)
    return None


def _cache_path() -> Path:
    configured = os.environ.get("MT5_SESSION_CACHE_PATH")
    if configured:
        return Path(configured)
    return Path.cwd() / ".trade-runtime" / "mt5-session-cache.json"


def _seconds_to_iso(server_now: datetime, seconds: int) -> str:
    start = server_now.replace(hour=0, minute=0, second=0, microsecond=0)
    return (start + timedelta(seconds=seconds)).isoformat()


def _is_trade_enabled(info: dict[str, Any], mt5: Any) -> tuple[bool, str | None]:
    raw_mode = info.get("trade_mode")
    mode = int(raw_mode) if raw_mode is not None else -1
    disabled = getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0)
    close_only = getattr(mt5, "SYMBOL_TRADE_MODE_CLOSEONLY", 3)
    if mode in {disabled, close_only}:
        return False, "Symbol trade mode is disabled or close-only"
    if info.get("trade_allowed") is False:
        return False, "Symbol trade_allowed is false"
    if info.get("visible") is False:
        return False, "Symbol is not visible/selected"
    return True, None


def _normalize_session(raw: Any, day: int, kind: str) -> SessionWindow | None:
    if raw is None or raw is False:
        return None
    data = _obj(raw)
    start = data.get("from") if "from" in data else data.get("open")
    end = data.get("to") if "to" in data else data.get("close")
    if start is None or end is None:
        if isinstance(raw, (tuple, list)) and len(raw) >= 2:
            start, end = raw[0], raw[1]
    if start is None or end is None:
        return None
    open_seconds = int(start)
    close_seconds = int(end)
    return SessionWindow(
        day=day,
        open=str(timedelta(seconds=open_seconds)),
        close=str(timedelta(seconds=close_seconds)),
        kind=kind,
        open_seconds=open_seconds,
        close_seconds=close_seconds,
    )


def _bridge_payload(adapter: Any) -> dict[str, Any]:
    paths: list[Path] = []
    if os.environ.get("MT5_SESSION_BRIDGE_PATH"):
        paths.append(Path(str(os.environ["MT5_SESSION_BRIDGE_PATH"])))
    terminal = _obj(adapter.terminal_info())
    common = terminal.get("commondata_path")
    if common:
        paths.append(Path(str(common)) / "Files" / "mt5-session-bridge.json")
    for path in paths:
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
    return {}


def _bridge_sessions(adapter: Any, symbol: str) -> list[SessionWindow]:
    payload = _bridge_payload(adapter)
    symbol_data = payload.get("symbols", {}).get(symbol, {})
    sessions: list[SessionWindow] = []
    for kind in ("trade", "quote"):
        for row in symbol_data.get(f"{kind}_sessions", []):
            session = _normalize_session(row, int(row.get("day", 0)), kind)
            if session:
                sessions.append(session)
    return sessions


def _cache_payload() -> dict[str, Any]:
    try:
        return json.loads(_cache_path().read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"symbols": {}}


def _load_cached_sessions(symbol: str) -> list[SessionWindow]:
    rows = _cache_payload().get("symbols", {}).get(symbol, {}).get("sessions", [])
    sessions: list[SessionWindow] = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        if not {"day", "open_seconds", "close_seconds"}.issubset(row):
            continue
        sessions.append(
            SessionWindow(
                day=int(row["day"]),
                open=str(row.get("open", timedelta(seconds=int(row["open_seconds"])))),
                close=str(row.get("close", timedelta(seconds=int(row["close_seconds"])))),
                kind=str(row.get("kind", "trade")),
                open_seconds=int(row["open_seconds"]),
                close_seconds=int(row["close_seconds"]),
            )
        )
    return sessions


def _save_cached_sessions(symbol: str, sessions: list[SessionWindow], source: str) -> None:
    path = _cache_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = _cache_payload()
        payload.setdefault("symbols", {})[symbol] = {
            "source": source,
            "cached_at": datetime.now(tz=UTC).isoformat(),
            "sessions": [asdict(session) for session in sessions],
        }
        path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")
    except OSError:
        return


def _mt5_sessions(adapter: Any, symbol: str, kind: str) -> list[SessionWindow]:
    fn = getattr(adapter.mt5, f"symbol_info_session_{kind}", None)
    if not callable(fn):
        return []
    sessions: list[SessionWindow] = []
    for day in range(7):
        index = 0
        while index < 16:
            session = _normalize_session(fn(symbol, day, index), day, kind)
            if session is None:
                break
            sessions.append(session)
            index += 1
    return sessions


def _historical_sessions(adapter: Any, symbol: str) -> list[SessionWindow]:
    try:
        raw = adapter.copy_rates_from_pos(symbol, adapter.timeframe("M1"), 0, 25000)
    except Exception:
        return []
    if raw is None:
        return []

    active: dict[int, set[int]] = {day: set() for day in range(7)}
    for row in raw:
        data = _obj(row)
        value = data.get("time")
        if value is None and hasattr(row, "dtype") and getattr(row, "dtype", None) is not None:
            value = row["time"].item() if hasattr(row["time"], "item") else row["time"]
        if value is None:
            continue
        bar = datetime.fromtimestamp(int(value), tz=UTC)
        active[bar.isoweekday() % 7].add(bar.hour * 60 + bar.minute)

    sessions: list[SessionWindow] = []
    for day, minutes in active.items():
        if not minutes:
            continue
        start = prev = min(minutes)
        for minute in sorted(minutes)[1:]:
            if minute - prev > 15:
                sessions.extend(_minute_sessions(day, start, prev + 1))
                start = minute
            prev = minute
        sessions.extend(_minute_sessions(day, start, prev + 1))
    return sessions if len(sessions) >= 2 else []


def _minute_sessions(day: int, open_minute: int, close_minute: int) -> list[SessionWindow]:
    open_seconds = max(0, open_minute * 60)
    close_seconds = min(86400, close_minute * 60)
    if close_seconds <= open_seconds:
        close_seconds = 86400
    return [
        SessionWindow(
            day=day,
            open=str(timedelta(seconds=open_seconds)),
            close=str(timedelta(seconds=close_seconds)),
            kind=kind,
            open_seconds=open_seconds,
            close_seconds=close_seconds,
        )
        for kind in ("trade", "quote")
    ]


def _session_match(
    sessions: list[SessionWindow],
    server_now: datetime,
    kind: str,
) -> SessionWindow | None:
    seconds = server_now.hour * 3600 + server_now.minute * 60 + server_now.second
    day = server_now.isoweekday() % 7
    yesterday = (day - 1) % 7
    for session in sessions:
        if session.kind != kind:
            continue
        if session.day == day and session.open_seconds <= session.close_seconds:
            if session.open_seconds <= seconds < session.close_seconds:
                return session
        if session.day == day and session.open_seconds > session.close_seconds:
            if seconds >= session.open_seconds:
                return session
        if session.day == yesterday and session.open_seconds > session.close_seconds:
            if seconds < session.close_seconds:
                return session
    return None


def _next_trade_session(
    sessions: list[SessionWindow],
    server_now: datetime,
) -> tuple[str | None, str | None]:
    seconds = server_now.hour * 3600 + server_now.minute * 60 + server_now.second
    day = server_now.isoweekday() % 7
    best_open: datetime | None = None
    best_close: datetime | None = None
    for offset in range(8):
        candidate_day = (day + offset) % 7
        candidate_date = server_now.date() + timedelta(days=offset)
        for session in sessions:
            if session.kind != "trade" or session.day != candidate_day:
                continue
            if offset == 0 and session.open_seconds <= seconds:
                continue
            candidate = datetime.combine(
                candidate_date,
                datetime.min.time(),
                tzinfo=UTC,
            ) + timedelta(seconds=session.open_seconds)
            close_date = candidate_date
            if session.close_seconds <= session.open_seconds:
                close_date = close_date + timedelta(days=1)
            close = datetime.combine(
                close_date,
                datetime.min.time(),
                tzinfo=UTC,
            ) + timedelta(seconds=session.close_seconds)
            if best_open is None or candidate < best_open:
                best_open = candidate
                best_close = close
    return (
        best_open.isoformat() if best_open else None,
        best_close.isoformat() if best_close else None,
    )


def _sessions(adapter: Any, symbol: str) -> tuple[list[SessionWindow], str]:
    sessions = _mt5_sessions(adapter, symbol, "trade") + _mt5_sessions(adapter, symbol, "quote")
    if sessions:
        _save_cached_sessions(symbol, sessions, "PYTHON_MT5_SESSION_API")
        return sessions, "PYTHON_MT5_SESSION_API"
    sessions = _bridge_sessions(adapter, symbol)
    if sessions:
        _save_cached_sessions(symbol, sessions, "MQL5_SESSION_BRIDGE")
        return sessions, "MQL5_SESSION_BRIDGE"
    sessions = _historical_sessions(adapter, symbol)
    if sessions:
        _save_cached_sessions(symbol, sessions, "BROKER_M1_HISTORY")
        return sessions, "BROKER_M1_HISTORY"
    sessions = _load_cached_sessions(symbol)
    if sessions:
        return sessions, "SESSION_CACHE"
    return [], "NONE"


def _empty_status(
    symbol: str,
    market_status: MarketStatus,
    data_status: DataStatus,
    reason: str,
    trade_mode: int | None = None,
) -> SymbolSessionStatus:
    now = datetime.now(tz=UTC)
    return SymbolSessionStatus(
        symbol=symbol,
        market_status=market_status,
        data_status=data_status,
        session_open=None,
        session_close=None,
        next_session_open=None,
        server_time=now.isoformat(),
        local_time=now.astimezone().isoformat(),
        quote_time=None,
        quote_age_seconds=None,
        reason=reason,
        trade_mode=trade_mode,
        trade_allowed=None,
        source="NONE",
        sessions=[],
    )


def evaluate_symbol_session(
    adapter: Any,
    symbol: str,
    quote_stale_seconds: int = 120,
) -> SymbolSessionStatus:
    adapter.ensure_connected()
    adapter.symbol_select(symbol, True)
    info = _obj(adapter.symbol_info(symbol))
    tick = _obj(adapter.symbol_info_tick(symbol))
    if not info:
        return _empty_status(symbol, "UNKNOWN", "DISCONNECTED", "Symbol info unavailable")
    raw_mode = info.get("trade_mode")
    trade_mode = int(raw_mode) if raw_mode is not None else -1
    if not tick:
        return _empty_status(symbol, "UNKNOWN", "DISCONNECTED", "Tick unavailable", trade_mode)

    quote_dt = _quote_datetime(tick)
    now = datetime.now(tz=UTC)
    age = (now - quote_dt).total_seconds() if quote_dt else None
    data_status: DataStatus = (
        "DISCONNECTED"
        if quote_dt is None
        else "STALE"
        if age is not None and age > quote_stale_seconds
        else "LIVE"
    )
    server_now = now
    trade_enabled, disabled_reason = _is_trade_enabled(info, adapter.mt5)
    sessions, source = _sessions(adapter, symbol)
    trade_session = _session_match(sessions, server_now, "trade")
    quote_session = _session_match(sessions, server_now, "quote")
    next_open, next_close = _next_trade_session(sessions, server_now)

    market_status: MarketStatus
    reason: str | None = None
    if not trade_enabled:
        market_status = "TRADE_DISABLED"
        reason = disabled_reason
    elif sessions and trade_session:
        market_status = "OPEN"
    elif sessions and quote_session and not trade_session:
        market_status = "QUOTE_ONLY"
        reason = "Broker quote session is open but trade session is closed"
    elif sessions:
        market_status = "CLOSED"
        reason = "No broker trade session is open"
    else:
        market_status = "UNKNOWN"
        reason = "Broker session schedule unavailable from MT5 session API, bridge, and history"

    return SymbolSessionStatus(
        symbol=symbol,
        market_status=market_status,
        data_status=data_status,
        session_open=(
            _seconds_to_iso(server_now, trade_session.open_seconds) if trade_session else next_open
        ),
        session_close=(
            _seconds_to_iso(server_now, trade_session.close_seconds)
            if trade_session
            else next_close
        ),
        next_session_open=next_open,
        server_time=server_now.isoformat(),
        local_time=server_now.astimezone().isoformat(),
        quote_time=quote_dt.isoformat() if quote_dt else None,
        quote_age_seconds=age,
        reason=reason,
        trade_mode=trade_mode,
        trade_allowed=(
            info.get("trade_allowed") if isinstance(info.get("trade_allowed"), bool) else None
        ),
        source=source,
        sessions=sessions,
    )
