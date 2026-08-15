from pathlib import Path
from types import SimpleNamespace

import pytest

from mt5.adapter import DemoExecutionGateway, MT5Adapter, MT5DemoSafetyError


class FakeMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_REAL = 2
    TRADE_RETCODE_DONE = 10009

    def __init__(self, account, terminal):
        self._account = account
        self._terminal = terminal
        self.sent = 0

    def initialize(self, path=None):
        return True

    def shutdown(self):
        return None

    def account_info(self):
        return self._account

    def terminal_info(self):
        return self._terminal

    def order_check(self, request):
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)

    def order_send(self, request):
        self.sent += 1
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, order=1)


def _gateway(monkeypatch, trade_mode=0, login=123, server="Demo-Server", trade_allowed=True):
    monkeypatch.setenv("MT5_ALLOWED_DEMO_LOGIN", "123")
    monkeypatch.setenv("MT5_ALLOWED_DEMO_SERVER", "Demo-Server")
    monkeypatch.setenv("MT5_EXECUTION_MODE", "demo")
    fake = FakeMT5(
        SimpleNamespace(login=login, server=server, trade_mode=trade_mode),
        SimpleNamespace(trade_allowed=trade_allowed),
    )
    return DemoExecutionGateway(MT5Adapter(fake)), fake


def test_demo_account_is_accepted(monkeypatch):
    gateway, _ = _gateway(monkeypatch)
    assert gateway.verify_demo_environment().ok is True


def test_real_account_is_blocked(monkeypatch):
    gateway, fake = _gateway(monkeypatch, trade_mode=FakeMT5.ACCOUNT_TRADE_MODE_REAL)
    assert gateway.verify_demo_environment().ok is False
    with pytest.raises(MT5DemoSafetyError):
        gateway.execute_market_order({"symbol": "EURUSD"})
    assert fake.sent == 0


def test_wrong_login_and_server_are_blocked(monkeypatch):
    gateway, _ = _gateway(monkeypatch, login=999)
    assert gateway.verify_demo_environment().ok is False
    gateway, _ = _gateway(monkeypatch, server="Live-Server")
    assert gateway.verify_demo_environment().ok is False


def test_order_send_is_centralized():
    root = Path(__file__).resolve().parents[1]
    offenders = []
    for path in root.rglob("*.py"):
        if any(part in {".venv", "tests"} for part in path.parts):
            continue
        text = path.read_text(encoding="utf-8")
        if "order_send(" in text and path.name != "adapter.py":
            offenders.append(str(path.relative_to(root)))
    assert offenders == []
