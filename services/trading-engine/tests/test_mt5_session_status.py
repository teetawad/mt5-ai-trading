from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from mt5.adapter import DemoExecutionGateway, MT5Adapter, MT5DemoSafetyError
from mt5.session_status import evaluate_symbol_session


class SessionFakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    SYMBOL_TRADE_MODE_DISABLED = 0
    SYMBOL_TRADE_MODE_CLOSEONLY = 3
    SYMBOL_TRADE_MODE_FULL = 4
    TRADE_RETCODE_DONE = 10009

    def __init__(
        self,
        *,
        now: datetime,
        trade_sessions: list[tuple[int, int]] | None = None,
        quote_sessions: list[tuple[int, int]] | None = None,
        trade_mode: int = SYMBOL_TRADE_MODE_FULL,
        tick_age_seconds: int = 0,
    ) -> None:
        self.now = now
        self.trade_sessions = trade_sessions or []
        self.quote_sessions = quote_sessions or []
        self.trade_mode = trade_mode
        self.tick_age_seconds = tick_age_seconds
        self.sent = 0

    def initialize(self, path=None):
        return True

    def shutdown(self):
        return None

    def account_info(self):
        return SimpleNamespace(
            login=123,
            server="Demo-Server",
            trade_mode=self.ACCOUNT_TRADE_MODE_DEMO,
        )

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True)

    def symbol_select(self, symbol, enable=True):
        return True

    def symbol_info(self, symbol):
        return SimpleNamespace(trade_mode=self.trade_mode, visible=True, point=0.00001)

    def symbol_info_tick(self, symbol):
        tick_time = self.now - timedelta(seconds=self.tick_age_seconds)
        return SimpleNamespace(
            bid=1.1,
            ask=1.1001,
            time=int(tick_time.timestamp()),
            time_msc=int(tick_time.timestamp() * 1000),
        )

    def symbol_info_session_trade(self, symbol, day, index):
        if day != self.now.isoweekday() % 7 or index >= len(self.trade_sessions):
            return None
        return self.trade_sessions[index]

    def symbol_info_session_quote(self, symbol, day, index):
        if day != self.now.isoweekday() % 7 or index >= len(self.quote_sessions):
            return None
        return self.quote_sessions[index]

    def order_check(self, request):
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)

    def order_send(self, request):
        self.sent += 1
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, order=1)


class HistoricalOnlyFakeMT5(SessionFakeMT5):
    TIMEFRAME_M1 = 1
    TIMEFRAME_M15 = 15
    TIMEFRAME_H1 = 60
    TIMEFRAME_H4 = 240

    def __getattribute__(self, name):
        if name in {"symbol_info_session_trade", "symbol_info_session_quote"}:
            raise AttributeError(name)
        return super().__getattribute__(name)

    def copy_rates_from_pos(self, symbol, timeframe, start_pos, count):
        current = self.now.replace(second=0, microsecond=0)
        return [
            {"time": int((current - timedelta(minutes=minute)).timestamp())}
            for minute in range(240)
        ]


def current_seconds(now: datetime) -> int:
    return now.hour * 3600 + now.minute * 60 + now.second


def fake_adapter(fake: SessionFakeMT5) -> MT5Adapter:
    return MT5Adapter(fake)


def test_open_session_is_tradable_live() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(now=now, trade_sessions=[(current - 60, current + 3600)])
    status = evaluate_symbol_session(fake_adapter(fake), "EURUSD")
    assert status.market_status == "OPEN"
    assert status.data_status == "LIVE"
    assert status.session_open is not None
    assert status.session_close is not None


def test_closed_session_is_not_open() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(
        now=now,
        trade_sessions=[(max(0, current - 7200), max(1, current - 3600))],
    )
    status = evaluate_symbol_session(fake_adapter(fake), "EURUSD")
    assert status.market_status == "CLOSED"
    assert status.next_session_open is not None


def test_multiple_daily_sessions() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(
        now=now,
        trade_sessions=[
            (max(0, current - 7200), max(1, current - 3600)),
            (current - 60, current + 3600),
        ],
    )
    status = evaluate_symbol_session(
        fake_adapter(fake),
        "XAUUSD",
    )
    assert status.market_status == "OPEN"
    assert status.session_open is not None


def test_stale_tick_blocks_live_data() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(
        now=now,
        trade_sessions=[(current - 60, current + 3600)],
        tick_age_seconds=999,
    )
    status = evaluate_symbol_session(
        fake_adapter(fake),
        "EURUSD",
        quote_stale_seconds=10,
    )
    assert status.data_status == "STALE"
    assert status.market_status == "OPEN"


def test_trade_disabled() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(
        now=now,
        trade_sessions=[(current - 60, current + 3600)],
        trade_mode=SessionFakeMT5.SYMBOL_TRADE_MODE_DISABLED,
    )
    status = evaluate_symbol_session(
        fake_adapter(fake),
        "EURUSD",
    )
    assert status.market_status == "TRADE_DISABLED"


def test_quote_only_session() -> None:
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    status = evaluate_symbol_session(
        fake_adapter(SessionFakeMT5(now=now, quote_sessions=[(current - 60, current + 3600)])),
        "EURUSD",
    )
    assert status.market_status == "QUOTE_ONLY"


def test_historical_broker_schedule_prevents_unknown_without_python_session_api(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path,
) -> None:
    monkeypatch.setenv("MT5_SESSION_CACHE_PATH", str(tmp_path / "sessions.json"))
    now = datetime.now(tz=UTC)
    fake = HistoricalOnlyFakeMT5(now=now)
    status = evaluate_symbol_session(fake_adapter(fake), "EURUSD")
    assert status.market_status == "OPEN"
    assert status.source == "BROKER_M1_HISTORY"
    assert status.session_open is not None
    assert status.session_close is not None


def test_market_closes_between_signal_and_execution(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("MT5_ALLOWED_DEMO_LOGIN", "123")
    monkeypatch.setenv("MT5_ALLOWED_DEMO_SERVER", "Demo-Server")
    monkeypatch.setenv("MT5_EXECUTION_MODE", "demo")
    now = datetime.now(tz=UTC)
    current = current_seconds(now)
    fake = SessionFakeMT5(
        now=now,
        trade_sessions=[(max(0, current - 7200), max(1, current - 3600))],
    )
    gateway = DemoExecutionGateway(fake_adapter(fake))
    with pytest.raises(MT5DemoSafetyError, match="not open"):
        gateway.execute_market_order({"symbol": "EURUSD"})
    assert fake.sent == 0
