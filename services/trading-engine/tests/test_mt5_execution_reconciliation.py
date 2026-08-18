from __future__ import annotations

from types import SimpleNamespace

import pytest

from mt5.adapter import DemoExecutionGateway, MT5Adapter, MT5DemoSafetyError, MT5ReconciliationError


class FakeMT5:
    """A fake MetaTrader5 module used to prove the Gateway's execution and
    reconciliation logic without a real terminal. Mirrors the real package's
    retcode/constant names exactly."""

    ACCOUNT_TRADE_MODE_DEMO = 0
    ACCOUNT_TRADE_MODE_REAL = 2

    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_DONE_PARTIAL = 10010
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_REJECT = 10006
    TRADE_RETCODE_INVALID_FILL = 10030

    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    SYMBOL_FILLING_FOK = 1
    SYMBOL_FILLING_IOC = 2

    def __init__(
        self,
        account=None,
        terminal=None,
        symbol_info=None,
        check_result="default",
        send_result="default",
        positions_after_send=None,
    ) -> None:
        self._account = account or SimpleNamespace(login=123, server="Demo-Server", trade_mode=0)
        self._terminal = terminal or SimpleNamespace(trade_allowed=True)
        self._symbol_info = symbol_info or SimpleNamespace(filling_mode=2)  # IOC-only broker
        self._check_result = check_result
        self._send_result = send_result
        self._positions_after_send = (
            positions_after_send if positions_after_send is not None else []
        )
        self.order_send_calls = 0
        self.order_check_calls = 0

    def initialize(self, path=None):
        return True

    def shutdown(self):
        return None

    def last_error(self):
        return (1, "no error")

    def account_info(self):
        return self._account

    def terminal_info(self):
        return self._terminal

    def symbol_select(self, symbol, enable=True):
        return True

    def symbol_info(self, symbol):
        return self._symbol_info

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=100.0, ask=100.1, time=9_999_999_999, time_msc=9_999_999_999_000)

    def copy_rates_from_pos(self, symbol, timeframe, start_pos, count):
        return []

    def order_check(self, request):
        self.order_check_calls += 1
        if self._check_result == "default":
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, comment="ok")
        return self._check_result

    def order_send(self, request):
        self.order_send_calls += 1
        if self._send_result == "default":
            return SimpleNamespace(
                retcode=self.TRADE_RETCODE_DONE, order=555111, deal=555222, comment="ok"
            )
        return self._send_result

    def positions_get(self, symbol=None):
        return self._positions_after_send


def _gateway(monkeypatch, mt5: FakeMT5) -> DemoExecutionGateway:
    monkeypatch.setenv("MT5_ALLOWED_DEMO_LOGIN", "123")
    monkeypatch.setenv("MT5_ALLOWED_DEMO_SERVER", "Demo-Server")
    monkeypatch.setenv("MT5_EXECUTION_MODE", "demo")
    gateway = DemoExecutionGateway(MT5Adapter(mt5))
    # evaluate_symbol_session -> _mt5_sessions/_bridge_sessions/_historical_sessions
    # all return [] for this fake, which makes market_status "UNKNOWN" not
    # "OPEN". Patch _verify_tradable_symbol out directly since these tests
    # are about order_check/order_send/reconciliation, not session status
    # (that is covered separately by test_mt5_session_status.py).
    monkeypatch.setattr(gateway, "_verify_tradable_symbol", lambda request: None)
    monkeypatch.setattr("time.sleep", lambda seconds: None)
    return gateway


BASE_REQUEST = {
    "symbol": "EURUSD",
    "type": 0,
    "volume": 0.1,
    "price": 100.1,
    "sl": 99.0,
    "tp": 102.0,
}


def test_order_check_none_result_is_treated_as_failure(monkeypatch):
    mt5 = FakeMT5(check_result=None)
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="order_check returned no result"):
        gateway.order_check(BASE_REQUEST)


def test_order_check_retcode_zero_with_a_real_result_is_accepted(monkeypatch):
    """Empirically confirmed against a live MT5 DEMO terminal: order_check()
    returns retcode=0 with comment="Done" for a request that would succeed —
    unlike order_send(), whose success codes are exclusively the documented
    TRADE_RETCODE_DONE/DONE_PARTIAL. This must not be rejected: the actual
    historical bug was a None/missing *result* (see
    test_order_check_none_result_is_treated_as_failure), not a genuine
    OrderCheckResult whose own retcode field is 0."""
    mt5 = FakeMT5(
        check_result=SimpleNamespace(retcode=0, comment="Done"),
        positions_after_send=[
            SimpleNamespace(
                ticket=555111, symbol="EURUSD", volume=0.1, price_open=100.1, comment=""
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    result = gateway.execute_market_order(BASE_REQUEST)
    assert result["retcode"] == FakeMT5.TRADE_RETCODE_DONE
    assert mt5.order_send_calls == 1


def test_order_check_explicit_rejection_blocks_before_order_send(monkeypatch):
    mt5 = FakeMT5(check_result=SimpleNamespace(retcode=FakeMT5.TRADE_RETCODE_REJECT, comment="no"))
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="order_check rejected"):
        gateway.execute_market_order(BASE_REQUEST)
    assert mt5.order_send_calls == 0


def test_order_send_none_result_is_treated_as_failure(monkeypatch):
    mt5 = FakeMT5(send_result=None)
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="order_send returned no result"):
        gateway.execute_market_order(BASE_REQUEST)


def test_order_send_retcode_zero_without_a_ticket_is_still_rejected(monkeypatch):
    """0 is accepted as a possible success retcode (see
    _order_send_ok_retcodes), but retcode alone is never sufficient — a
    result with no order/deal ticket must still be refused rather than
    guessed at, regardless of retcode."""
    mt5 = FakeMT5(
        send_result=SimpleNamespace(retcode=0, order=None, deal=None, comment="ambiguous")
    )
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="no order/deal ticket"):
        gateway.execute_market_order(BASE_REQUEST)


def test_order_send_retcode_zero_with_ticket_and_confirmed_position_succeeds(monkeypatch):
    """Empirically confirmed against the live connected MT5 DEMO terminal:
    this broker's order_send() reports retcode=0/comment="Done" for a
    genuinely successful market order, not TRADE_RETCODE_DONE=10009. Safety
    here comes from requiring a real ticket AND positions_get() confirmation
    (see test_order_send_success_without_confirmed_position_raises_reconciliation_error),
    not from the specific retcode value."""
    mt5 = FakeMT5(
        send_result=SimpleNamespace(retcode=0, order=555111, deal=555222, comment="Done"),
        positions_after_send=[
            SimpleNamespace(
                ticket=555111, symbol="EURUSD", volume=0.1, price_open=100.1, comment=""
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    result = gateway.execute_market_order(BASE_REQUEST)
    assert result["retcode"] == 0
    assert result["confirmed_position"]["ticket"] == 555111


def test_order_send_genuine_error_retcode_is_still_rejected(monkeypatch):
    mt5 = FakeMT5(
        send_result=SimpleNamespace(retcode=10019, order=None, deal=None, comment="No money")
    )
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="order_send rejected"):
        gateway.execute_market_order(BASE_REQUEST)


def test_order_send_success_without_confirmed_position_raises_reconciliation_error(monkeypatch):
    """A successful-looking retcode with no matching MT5 position must never
    be treated as an open trade — this is the exact false-OPEN bug shape."""
    mt5 = FakeMT5(
        send_result=SimpleNamespace(
            retcode=FakeMT5.TRADE_RETCODE_DONE, order=555111, deal=555222, comment="ok"
        ),
        positions_after_send=[],
    )
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5ReconciliationError):
        gateway.execute_market_order(BASE_REQUEST)


def test_order_send_success_with_confirmed_position_returns_position(monkeypatch):
    mt5 = FakeMT5(
        positions_after_send=[
            SimpleNamespace(
                ticket=555111,
                symbol="EURUSD",
                volume=0.1,
                price_open=100.12,
                comment="MT5_AI_DEMO_LAB",
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    result = gateway.execute_market_order(BASE_REQUEST)
    assert result["retcode"] == FakeMT5.TRADE_RETCODE_DONE
    assert result["order"] == 555111
    assert result["confirmed_position"]["ticket"] == 555111
    assert result["confirmed_position"]["price_open"] == 100.12


def test_order_send_matches_position_by_comment_when_ticket_differs(monkeypatch):
    # Some brokers report the position under a different ticket than the
    # order/deal ticket returned by order_send (e.g. netting accounts).
    mt5 = FakeMT5(
        send_result=SimpleNamespace(
            retcode=FakeMT5.TRADE_RETCODE_DONE, order=1, deal=2, comment="ok"
        ),
        positions_after_send=[
            SimpleNamespace(
                ticket=999999,
                symbol="EURUSD",
                volume=0.1,
                price_open=100.1,
                comment="MT5_AI_DEMO_LAB",
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    resolved = dict(BASE_REQUEST, comment="MT5_AI_DEMO_LAB")
    result = gateway.execute_market_order(resolved)
    assert result["confirmed_position"]["ticket"] == 999999


def test_real_account_never_reaches_order_check_or_send(monkeypatch):
    mt5 = FakeMT5(
        account=SimpleNamespace(
            login=123, server="Demo-Server", trade_mode=FakeMT5.ACCOUNT_TRADE_MODE_REAL
        )
    )
    gateway = _gateway(monkeypatch, mt5)
    with pytest.raises(MT5DemoSafetyError, match="not DEMO"):
        gateway.execute_market_order(BASE_REQUEST)
    assert mt5.order_check_calls == 0
    assert mt5.order_send_calls == 0


def test_filling_mode_resolves_to_ioc_when_broker_supports_only_ioc(monkeypatch):
    mt5 = FakeMT5(
        symbol_info=SimpleNamespace(filling_mode=FakeMT5.SYMBOL_FILLING_IOC),
        positions_after_send=[
            SimpleNamespace(
                ticket=555111,
                symbol="EURUSD",
                volume=0.1,
                price_open=100.1,
                comment="MT5_AI_DEMO_LAB",
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    assert gateway._resolve_filling_mode("EURUSD") == FakeMT5.ORDER_FILLING_IOC


def test_filling_mode_resolves_to_fok_when_broker_supports_only_fok(monkeypatch):
    mt5 = FakeMT5(symbol_info=SimpleNamespace(filling_mode=FakeMT5.SYMBOL_FILLING_FOK))
    gateway = _gateway(monkeypatch, mt5)
    assert gateway._resolve_filling_mode("EURUSD") == FakeMT5.ORDER_FILLING_FOK


def test_filling_mode_falls_back_to_return_when_broker_supports_neither(monkeypatch):
    # This is the scenario a hardcoded ORDER_FILLING_IOC would have silently
    # broken on: a symbol whose filling_mode bitmask has neither flag set.
    mt5 = FakeMT5(symbol_info=SimpleNamespace(filling_mode=0))
    gateway = _gateway(monkeypatch, mt5)
    assert gateway._resolve_filling_mode("EURUSD") == FakeMT5.ORDER_FILLING_RETURN


def test_order_check_and_order_send_never_receive_a_caller_supplied_filling_mode(monkeypatch):
    """The Gateway must override type_filling itself — a caller (router/Node)
    hardcoding an incompatible mode must not be able to break execution."""
    seen: dict = {}

    class RecordingMT5(FakeMT5):
        def order_check(self, request):
            seen["check_filling"] = request.get("type_filling")
            return super().order_check(request)

        def order_send(self, request):
            seen["send_filling"] = request.get("type_filling")
            return super().order_send(request)

    mt5 = RecordingMT5(
        symbol_info=SimpleNamespace(filling_mode=FakeMT5.SYMBOL_FILLING_FOK),
        positions_after_send=[
            SimpleNamespace(
                ticket=555111, symbol="EURUSD", volume=0.1, price_open=100.1, comment=""
            )
        ],
    )
    gateway = _gateway(monkeypatch, mt5)
    request_with_wrong_filling = dict(BASE_REQUEST, type_filling=FakeMT5.ORDER_FILLING_IOC)
    gateway.execute_market_order(request_with_wrong_filling)
    assert seen["check_filling"] == FakeMT5.ORDER_FILLING_FOK
    assert seen["send_filling"] == FakeMT5.ORDER_FILLING_FOK
