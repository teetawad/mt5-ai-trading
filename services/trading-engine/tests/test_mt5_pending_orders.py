import logging
from types import SimpleNamespace

import pytest

import mt5.adapter as adapter_module
from mt5.adapter import (
    DemoExecutionGateway,
    MT5Adapter,
    MT5DemoSafetyError,
    MT5PendingOrderCancelledError,
    MT5PendingOrderConfirmationAmbiguousError,
    MT5PendingOrderNotConfirmedError,
    MT5ReconciliationError,
)


class FakePendingMT5:
    ACCOUNT_TRADE_MODE_DEMO = 0
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008
    TRADE_RETCODE_REJECT = 10006
    TRADE_ACTION_PENDING = 5
    TRADE_ACTION_REMOVE = 8
    TRADE_ACTION_DEAL = 1
    ORDER_TYPE_BUY_LIMIT = 2
    ORDER_TYPE_SELL_LIMIT = 3
    ORDER_TYPE_BUY_STOP = 4
    ORDER_TYPE_SELL_STOP = 5
    ORDER_TIME_GTC = 0
    ORDER_TIME_SPECIFIED = 1
    SYMBOL_FILLING_IOC = 2
    SYMBOL_FILLING_FOK = 1
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_RETURN = 2
    POSITION_TYPE_BUY = 0
    POSITION_TYPE_SELL = 1
    ORDER_STATE_PLACED = 1
    ORDER_STATE_CANCELED = 2
    ORDER_STATE_FILLED = 4
    ORDER_STATE_REJECTED = 5
    ORDER_STATE_EXPIRED = 6
    DEAL_ENTRY_IN = 0

    def __init__(
        self,
        orders_after_send=None,
        positions_after_send=None,
        history_orders=None,
        history_deals=None,
        cancel_leaves_ticket=False,
        send_order_ticket=555,
        send_retcode=None,
        check_retcode=0,
        send_comment="AI_TRADE_V3",
        # Permissive-by-default broker capability flags (spec section 7) —
        # real MQL5 ENUM_SYMBOL_TRADE_MODE/ORDER_MODE/EXPIRATION_MODE integer
        # values: trade_mode=4 (FULL), order_mode=63 (every order type
        # allowed), expiration_mode=5 (GTC|SPECIFIED). Tests that need to
        # prove a specific broker restriction override these explicitly.
        trade_mode=4,
        order_mode=63,
        expiration_mode=5,
        tick_bid=1.0499,
        tick_ask=1.0501,
    ):
        self._trade_mode = trade_mode
        self._order_mode = order_mode
        self._expiration_mode = expiration_mode
        self._tick_bid = tick_bid
        self._tick_ask = tick_ask
        self._orders_after_send = (
            orders_after_send
            if orders_after_send is not None
            else [
                SimpleNamespace(
                    ticket=555,
                    symbol="EURUSD",
                    comment="AI_TRADE_V3",
                    type=self.ORDER_TYPE_BUY_LIMIT,
                    volume_current=0.01,
                    volume_initial=0.01,
                    price_open=1.05,
                    sl=1.045,
                    tp=1.06,
                    magic=27002,
                )
            ]
        )
        self._positions_after_send = (
            positions_after_send if positions_after_send is not None else []
        )
        self._history_orders = history_orders if history_orders is not None else []
        self._history_deals = history_deals if history_deals is not None else []
        self._cancel_leaves_ticket = cancel_leaves_ticket
        self._send_order_ticket = send_order_ticket
        self._send_retcode = send_retcode if send_retcode is not None else self.TRADE_RETCODE_PLACED
        self._check_retcode = check_retcode
        self._send_comment = send_comment

    def initialize(self, path=None):
        return True

    def shutdown(self):
        return None

    def account_info(self):
        return SimpleNamespace(
            login=123, server="Demo-Server", trade_mode=self.ACCOUNT_TRADE_MODE_DEMO
        )

    def terminal_info(self):
        return SimpleNamespace(trade_allowed=True)

    def symbol_info(self, symbol):
        return SimpleNamespace(
            filling_mode=self.SYMBOL_FILLING_IOC,
            point=0.00001,
            trade_tick_size=0.00001,
            trade_mode=self._trade_mode,
            order_mode=self._order_mode,
            expiration_mode=self._expiration_mode,
        )

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=self._tick_bid, ask=self._tick_ask)

    def order_check(self, request):
        return SimpleNamespace(retcode=self._check_retcode, comment="Done")

    def order_send(self, request):
        if request.get("action") == self.TRADE_ACTION_REMOVE:
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE)
        return SimpleNamespace(
            retcode=self._send_retcode,
            order=self._send_order_ticket,
            deal=0,
            volume=request.get("volume"),
            price=request.get("price"),
            bid=1.0499,
            ask=1.0501,
            comment=self._send_comment,
            request_id=42,
            retcode_external=0,
        )

    def orders_get(self, symbol=None):
        if self._cancel_leaves_ticket:
            return self._orders_after_send
        return self._orders_after_send

    def positions_get(self, symbol=None):
        return self._positions_after_send

    def history_orders_get(self, date_from, date_to, **kwargs):
        return self._history_orders

    def history_deals_get(self, date_from, date_to, **kwargs):
        return self._history_deals

    def last_error(self):
        return (0, "no error")


def _gateway(monkeypatch, **kwargs):
    monkeypatch.setenv("MT5_ALLOWED_DEMO_LOGIN", "123")
    monkeypatch.setenv("MT5_ALLOWED_DEMO_SERVER", "Demo-Server")
    monkeypatch.setenv("MT5_EXECUTION_MODE", "demo")
    # The bounded reconciliation schedule uses real time.sleep() in
    # production; tests never need to actually wait ~1.75s per case.
    monkeypatch.setattr(adapter_module.time, "sleep", lambda _seconds: None)
    fake = FakePendingMT5(**kwargs)
    gateway = DemoExecutionGateway(MT5Adapter(fake))
    monkeypatch.setattr(
        "mt5.session_status.evaluate_symbol_session",
        lambda adapter, symbol, stale_seconds: SimpleNamespace(
            market_status="OPEN", data_status="LIVE"
        ),
    )
    return gateway, fake


def _pending_request(fake, **overrides):
    request = {
        "action": fake.TRADE_ACTION_PENDING,
        "symbol": "EURUSD",
        "volume": 0.01,
        "type": fake.ORDER_TYPE_BUY_LIMIT,
        "price": 1.0500,
        "sl": 1.0450,
        "tp": 1.0600,
        "magic": 27002,
        "type_time": fake.ORDER_TIME_GTC,
        "comment": "AI_TRADE_V3",
    }
    request.update(overrides)
    return request


# ---------------------------------------------------------------------------
# A) result.order > 0 and orders_get(ticket=...) confirms it (preferred path)
# ---------------------------------------------------------------------------


def test_execute_pending_order_confirms_via_ticket(monkeypatch):
    gateway, fake = _gateway(monkeypatch)
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["order"] == 555
    assert result["confirmed_order"]["ticket"] == 555


# ---------------------------------------------------------------------------
# B) result.order == 0 (this broker's observed behavior) recovered via
#    bounded reconciliation — the exact regression this fix addresses.
# ---------------------------------------------------------------------------


def test_order_zero_is_recovered_via_comment_match_reconciliation(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[
            SimpleNamespace(
                ticket=777,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_current=0.01,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["order"] == 777
    assert result["confirmed_order"]["ticket"] == 777


def test_order_zero_recovered_via_broader_field_match_when_comment_is_stripped(monkeypatch):
    # Simulates a broker that truncates/strips the comment — the order still
    # matches on type/volume/price/sl/tp/magic within tolerance.
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        send_comment="AI_TRADE_V3",
        orders_after_send=[
            SimpleNamespace(
                ticket=888,
                symbol="EURUSD",
                comment="",
                type=2,
                volume_current=0.01,
                price_open=1.05001,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["order"] == 888


def test_ticket_given_but_not_found_falls_back_to_reconciliation_not_immediate_failure(monkeypatch):
    # result.order is non-zero, but orders_get() never shows that exact
    # ticket — must still attempt reconciliation rather than failing outright.
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=999,
        orders_after_send=[
            SimpleNamespace(
                ticket=1001,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_current=0.01,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["order"] == 1001


# ---------------------------------------------------------------------------
# C) result.order == 0 and reconciliation finds ZERO matches -> distinct,
#    never-guessed failure.
# ---------------------------------------------------------------------------


def test_order_zero_and_no_matching_order_raises_not_confirmed(monkeypatch):
    gateway, fake = _gateway(monkeypatch, send_order_ticket=0, orders_after_send=[])
    with pytest.raises(MT5PendingOrderNotConfirmedError):
        gateway.execute_pending_order(_pending_request(fake))
    # Still a subtype of the pre-existing MT5ReconciliationError so any
    # broader existing catch site continues to work.
    with pytest.raises(MT5ReconciliationError):
        gateway.execute_pending_order(_pending_request(fake))


# ---------------------------------------------------------------------------
# D) result.order == 0 and reconciliation finds MULTIPLE candidates -> never
#    guess.
# ---------------------------------------------------------------------------


def test_order_zero_and_multiple_matches_raises_ambiguous(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        send_comment="",  # both orders lack the comment -> falls to broader match -> 2 candidates
        orders_after_send=[
            SimpleNamespace(
                ticket=1,
                symbol="EURUSD",
                comment="",
                type=2,
                volume_current=0.01,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
            SimpleNamespace(
                ticket=2,
                symbol="EURUSD",
                comment="",
                type=2,
                volume_current=0.01,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderConfirmationAmbiguousError):
        gateway.execute_pending_order(_pending_request(fake))


def test_does_not_select_an_unrelated_pending_order_with_a_different_comment(monkeypatch):
    # An order exists for the same symbol but from a DIFFERENT plan (different
    # execution-key comment) and doesn't match the broader fields either —
    # must not be picked.
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[
            SimpleNamespace(
                ticket=42,
                symbol="EURUSD",
                comment="AIV3someothrplan",
                type=3,
                volume_current=0.02,
                price_open=1.10,
                sl=1.11,
                tp=1.09,
                magic=27002,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderNotConfirmedError):
        gateway.execute_pending_order(_pending_request(fake))


# ---------------------------------------------------------------------------
# E) IMMEDIATE TRIGGER CASE (spec section 6): order_send accepted, but the
#    pending order vanished from orders_get() because it already triggered
#    into a real position before this ever polled — must become
#    TRIGGERED_POSITION, never PENDING_ORDER_NOT_CONFIRMED.
# ---------------------------------------------------------------------------


def test_immediate_trigger_confirmed_via_positions_get_by_comment(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[
            SimpleNamespace(
                ticket=901,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=FakePendingMT5.POSITION_TYPE_BUY,
                volume=0.01,
                price_open=1.0503,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["execution_state"] == "TRIGGERED_POSITION"
    assert result["confirmed_position"]["ticket"] == 901
    assert result["order"] == 901


def test_immediate_trigger_confirmed_via_broader_field_match_when_comment_stripped(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        send_comment="AI_TRADE_V3",
        orders_after_send=[],
        positions_after_send=[
            SimpleNamespace(
                ticket=902,
                symbol="EURUSD",
                comment="",
                type=FakePendingMT5.POSITION_TYPE_BUY,
                volume=0.01,
                price_open=1.0503,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["execution_state"] == "TRIGGERED_POSITION"
    assert result["order"] == 902


def test_order_and_position_evidence_both_present_is_ambiguous_never_guessed(monkeypatch):
    # Defensive: a still-listed stale order plus a real triggered position at
    # the same moment must never silently pick one — this should be rare in
    # practice but must never be guessed.
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[
            SimpleNamespace(
                ticket=555,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_current=0.01,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
        positions_after_send=[
            SimpleNamespace(
                ticket=901,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=FakePendingMT5.POSITION_TYPE_BUY,
                volume=0.01,
                price_open=1.0503,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderConfirmationAmbiguousError):
        gateway.execute_pending_order(_pending_request(fake))


# ---------------------------------------------------------------------------
# F) HISTORY reconciliation (spec section 1C/1D): neither orders_get() nor
#    positions_get() show anything (a fast fill can outrun both live
#    endpoints), but order/deal HISTORY proves what really happened.
# ---------------------------------------------------------------------------


def test_history_order_proves_fill_when_live_endpoints_show_nothing(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[
            SimpleNamespace(
                ticket=1201,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_initial=0.01,
                volume_current=0,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
                state=FakePendingMT5.ORDER_STATE_FILLED,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["execution_state"] == "FILLED_HISTORY"
    assert result["confirmed_history_order"]["ticket"] == 1201
    assert result["order"] == 1201


def test_history_deal_proves_fill_when_history_orders_is_inconclusive(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[],
        history_deals=[
            SimpleNamespace(
                ticket=2001,
                position_id=3001,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                volume=0.01,
                price=1.0503,
                magic=27002,
                entry=FakePendingMT5.DEAL_ENTRY_IN,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["execution_state"] == "FILLED_HISTORY"
    assert result["confirmed_history_deal"]["ticket"] == 2001
    assert result["order"] == 3001


def test_history_order_shows_cancelled_raises_distinct_cancelled_error(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[
            SimpleNamespace(
                ticket=1301,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_initial=0.01,
                volume_current=0,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
                state=FakePendingMT5.ORDER_STATE_CANCELED,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderCancelledError):
        gateway.execute_pending_order(_pending_request(fake))
    # Never the same exception as "no evidence anywhere" — the caller must
    # be able to tell "cancelled" apart from "unknown" (spec section 8).
    with pytest.raises(MT5ReconciliationError):
        gateway.execute_pending_order(_pending_request(fake))


def test_history_order_shows_rejected_raises_distinct_cancelled_error(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[
            SimpleNamespace(
                ticket=1302,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=2,
                volume_initial=0.01,
                volume_current=0,
                price_open=1.05,
                sl=1.045,
                tp=1.06,
                magic=27002,
                state=FakePendingMT5.ORDER_STATE_REJECTED,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderCancelledError):
        gateway.execute_pending_order(_pending_request(fake))


def test_multiple_history_deal_matches_is_ambiguous_never_guessed(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        send_comment="",  # no comment on either deal -> falls to broader (volume/magic) match
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[],
        history_deals=[
            SimpleNamespace(
                ticket=2001,
                position_id=3001,
                symbol="EURUSD",
                comment="",
                volume=0.01,
                price=1.0503,
                magic=27002,
                entry=FakePendingMT5.DEAL_ENTRY_IN,
            ),
            SimpleNamespace(
                ticket=2002,
                position_id=3002,
                symbol="EURUSD",
                comment="",
                volume=0.01,
                price=1.0498,
                magic=27002,
                entry=FakePendingMT5.DEAL_ENTRY_IN,
            ),
        ],
    )
    with pytest.raises(MT5PendingOrderConfirmationAmbiguousError):
        gateway.execute_pending_order(_pending_request(fake))


def test_truly_no_evidence_anywhere_still_raises_not_confirmed(monkeypatch):
    # Every single source (orders/positions/history orders/history deals)
    # comes back empty — the only case that may still conclude
    # PENDING_ORDER_NOT_CONFIRMED.
    gateway, fake = _gateway(
        monkeypatch,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[],
        history_deals=[],
    )
    with pytest.raises(MT5PendingOrderNotConfirmedError):
        gateway.execute_pending_order(_pending_request(fake))


# ---------------------------------------------------------------------------
# Rejections / safety
# ---------------------------------------------------------------------------


def test_execute_pending_order_blocks_real_account(monkeypatch):
    gateway, fake = _gateway(monkeypatch)
    gateway.adapter.mt5.account_info = lambda: SimpleNamespace(
        login=123, server="Demo-Server", trade_mode=99
    )
    with pytest.raises(MT5DemoSafetyError):
        gateway.execute_pending_order(_pending_request(fake))


def test_actual_rejected_retcode_raises_before_any_reconciliation(monkeypatch):
    gateway, fake = _gateway(monkeypatch, send_retcode=FakePendingMT5.TRADE_RETCODE_REJECT)
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    assert "10006" in str(exc_info.value)
    assert not isinstance(exc_info.value, MT5ReconciliationError)


def test_order_check_failure_raises_before_order_send(monkeypatch):
    gateway, fake = _gateway(monkeypatch, check_retcode=10013)  # TRADE_RETCODE_INVALID
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    assert "order_check" in str(exc_info.value)


def test_order_check_pass_does_not_imply_order_send_success(monkeypatch):
    # order_check() only proves the request is well-formed/affordable — a
    # PASSING check must never be reused as evidence that order_send itself
    # succeeded (spec section 4).
    gateway, fake = _gateway(
        monkeypatch,
        check_retcode=0,
        send_retcode=FakePendingMT5.TRADE_RETCODE_REJECT,
    )
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    assert "10006" in str(exc_info.value)
    assert not isinstance(exc_info.value, MT5ReconciliationError)


def test_trade_retcode_done_with_confirmed_order_is_accepted(monkeypatch):
    # Some brokers return TRADE_RETCODE_DONE (not PLACED) when a pending
    # order's trigger condition is already effectively met and it fills
    # immediately — spec section 3 requires this to still be reconciled
    # against real evidence, not treated as an automatic rejection.
    gateway, fake = _gateway(
        monkeypatch,
        send_retcode=FakePendingMT5.TRADE_RETCODE_DONE,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[
            SimpleNamespace(
                ticket=4242,
                symbol="EURUSD",
                comment="AI_TRADE_V3",
                type=FakePendingMT5.POSITION_TYPE_BUY,
                volume=0.01,
                price_open=1.0503,
                sl=1.045,
                tp=1.06,
                magic=27002,
            ),
        ],
    )
    result = gateway.execute_pending_order(_pending_request(fake))
    assert result["execution_state"] == "TRIGGERED_POSITION"
    assert result["order"] == 4242


def test_trade_retcode_done_with_zero_evidence_still_raises_not_confirmed(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch,
        send_retcode=FakePendingMT5.TRADE_RETCODE_DONE,
        send_order_ticket=0,
        orders_after_send=[],
        positions_after_send=[],
        history_orders=[],
        history_deals=[],
    )
    with pytest.raises(MT5PendingOrderNotConfirmedError):
        gateway.execute_pending_order(_pending_request(fake))


# ---------------------------------------------------------------------------
# Diagnostics capture (spec section 1) — every failure path must carry the
# safe request/order_check/order_send/last_error subset on the exception
# itself, not just a free-text message.
# ---------------------------------------------------------------------------


def test_rejected_retcode_carries_full_diagnostics_on_the_exception(monkeypatch):
    gateway, fake = _gateway(monkeypatch, send_retcode=FakePendingMT5.TRADE_RETCODE_REJECT)
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    diagnostics = exc_info.value.diagnostics
    assert diagnostics is not None
    assert diagnostics["order_send"]["retcode"] == FakePendingMT5.TRADE_RETCODE_REJECT
    assert diagnostics["order_send"]["retcode_name"] == "TRADE_RETCODE_REJECT"
    assert diagnostics["request"]["action"] == fake.TRADE_ACTION_PENDING
    assert diagnostics["request"]["symbol"] == "EURUSD"
    assert diagnostics["request"]["type"] == fake.ORDER_TYPE_BUY_LIMIT


def test_not_confirmed_carries_full_diagnostics_on_the_exception(monkeypatch):
    gateway, fake = _gateway(monkeypatch, send_order_ticket=0, orders_after_send=[])
    with pytest.raises(MT5PendingOrderNotConfirmedError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    diagnostics = exc_info.value.diagnostics
    assert diagnostics is not None
    assert diagnostics["order_send"]["order"] == 0
    assert "request" in diagnostics and "order_check" in diagnostics


def test_order_check_rejection_carries_diagnostics_with_margin_fields(monkeypatch):
    gateway, fake = _gateway(monkeypatch, check_retcode=10013)
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    diagnostics = exc_info.value.diagnostics
    assert diagnostics is not None
    assert diagnostics["order_check"]["retcode"] == 10013
    assert "margin" in diagnostics["order_check"]


# ---------------------------------------------------------------------------
# Broker capability pre-flight (spec section 7): an explicit, specific error
# BEFORE order_check/order_send when the broker does not actually permit
# this exact request — never a mysterious accepted-but-unconfirmed result.
# ---------------------------------------------------------------------------


def test_symbol_trade_mode_disabled_is_rejected_before_order_check(monkeypatch):
    gateway, fake = _gateway(monkeypatch, trade_mode=0)  # SYMBOL_TRADE_MODE_DISABLED
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    assert "trade_mode" in str(exc_info.value)


def test_symbol_close_only_is_rejected_before_order_check(monkeypatch):
    gateway, fake = _gateway(monkeypatch, trade_mode=3)  # SYMBOL_TRADE_MODE_CLOSEONLY
    with pytest.raises(MT5DemoSafetyError):
        gateway.execute_pending_order(_pending_request(fake))


def test_broker_does_not_support_limit_orders_is_rejected_with_specific_error(monkeypatch):
    gateway, fake = _gateway(monkeypatch, order_mode=4)  # only SYMBOL_ORDER_STOP, no LIMIT
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake, type=fake.ORDER_TYPE_BUY_LIMIT))
    assert "LIMIT" in str(exc_info.value)


def test_broker_does_not_support_stop_orders_is_rejected_with_specific_error(monkeypatch):
    gateway, fake = _gateway(monkeypatch, order_mode=2)  # only SYMBOL_ORDER_LIMIT, no STOP
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake, type=fake.ORDER_TYPE_SELL_STOP))
    assert "STOP" in str(exc_info.value)


def test_broker_does_not_support_gtc_expiration_is_rejected_with_specific_error(monkeypatch):
    gateway, fake = _gateway(monkeypatch, expiration_mode=4)  # SYMBOL_EXPIRATION_SPECIFIED only
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))  # default type_time is GTC
    assert "expiration" in str(exc_info.value).lower()


def test_broker_does_not_support_specified_expiration_is_rejected_with_specific_error(monkeypatch):
    gateway, fake = _gateway(monkeypatch, expiration_mode=1)  # SYMBOL_EXPIRATION_GTC only
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(
            _pending_request(fake, type_time=fake.ORDER_TIME_SPECIFIED, expiration=9_999_999_999)
        )
    assert "expiration" in str(exc_info.value).lower()


def test_market_closed_reports_specific_error(monkeypatch):
    gateway, fake = _gateway(monkeypatch)
    monkeypatch.setattr(
        "mt5.session_status.evaluate_symbol_session",
        lambda adapter, symbol, stale_seconds: SimpleNamespace(
            market_status="CLOSED", data_status="LIVE"
        ),
    )
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(_pending_request(fake))
    assert "not open" in str(exc_info.value) or "CLOSED" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Latest-tick re-validation (spec section 6): a pending price that is no
# longer valid against the CURRENT tick must be rejected before order_send,
# never sent using a stale AI-analysis price.
# ---------------------------------------------------------------------------


def test_stale_sell_stop_price_now_above_current_bid_is_rejected(monkeypatch):
    # A valid SELL_STOP entry must be below the current bid. Price moved
    # since approval: the latest bid (1.3540) is now BELOW the requested
    # entry (1.3545), which is no longer a valid SELL_STOP at all.
    gateway, fake = _gateway(monkeypatch, tick_bid=1.3540, tick_ask=1.3542)
    request = _pending_request(
        fake, type=fake.ORDER_TYPE_SELL_STOP, price=1.3545, sl=1.3560, tp=1.3510
    )
    with pytest.raises(MT5DemoSafetyError) as exc_info:
        gateway.execute_pending_order(request)
    assert "latest tick" in str(exc_info.value)


def test_valid_sell_stop_price_against_latest_tick_proceeds(monkeypatch):
    gateway, fake = _gateway(
        monkeypatch, tick_bid=1.3540, tick_ask=1.3542, send_comment="AI_TRADE_V3"
    )
    request = _pending_request(
        fake, type=fake.ORDER_TYPE_SELL_STOP, price=1.3530, sl=1.3550, tp=1.3510
    )
    result = gateway.execute_pending_order(request)
    assert result["order"] == 555


# ---------------------------------------------------------------------------
# Full MqlTradeResult logging (spec section 1): retcode/deal/order/volume/
# price/bid/ask/comment/request_id/retcode_external must all be captured.
# ---------------------------------------------------------------------------


def test_full_mql_trade_result_is_logged(monkeypatch, caplog):
    gateway, fake = _gateway(monkeypatch)
    with caplog.at_level(logging.INFO, logger="mt5.execution"):
        gateway.execute_pending_order(_pending_request(fake))
    combined = "\n".join(record.getMessage() for record in caplog.records)
    expected_fields = (
        "retcode",
        "deal",
        "order",
        "volume",
        "price",
        "bid",
        "ask",
        "comment",
        "request_id",
        "retcode_external",
    )
    for expected_field in expected_fields:
        assert expected_field in combined


# ---------------------------------------------------------------------------
# Cancel path (unchanged behavior, kept green)
# ---------------------------------------------------------------------------


def test_cancel_pending_order_confirms_ticket_removed(monkeypatch):
    gateway, fake = _gateway(monkeypatch, orders_after_send=[])
    result = gateway.cancel_pending_order(555)
    assert result["retcode"] == fake.TRADE_RETCODE_DONE


def test_cancel_pending_order_fails_if_ticket_still_present(monkeypatch):
    gateway, fake = _gateway(monkeypatch, cancel_leaves_ticket=True)
    with pytest.raises(MT5ReconciliationError):
        gateway.cancel_pending_order(555)
