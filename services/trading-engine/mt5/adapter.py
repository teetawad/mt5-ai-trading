from __future__ import annotations

import logging
import os
import time
from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from mt5.timeframes import resolve_mt5_timeframe

logger = logging.getLogger("mt5.execution")

# The official MetaTrader5 package's own reference helpers (Buy/Sell/Close in
# MetaTrader5/__init__.py) treat a None result and any retcode other than
# TRADE_RETCODE_DONE as failure. 0 is not a defined trade retcode anywhere in
# the package (the enum starts at 10004) — it only ever appears here because
# _obj(None) returns {} and `.get("retcode", 0)` defaults to 0. Treating that
# default as "success" was the root cause of positions being recorded as
# EXECUTED/OPEN with no real MT5 order behind them. Never add 0 back to
# DemoExecutionGateway's accepted retcode sets.


class MT5UnavailableError(RuntimeError):
    pass


class MT5DemoSafetyError(RuntimeError):
    """Base class for every execution-safety failure. Optionally carries a
    `diagnostics` dict — the safe subset of order_check/order_send/request
    fields plus mt5.last_error() (spec: "CAPTURE EXACT ORDER_SEND RESULT")
    — so a caller (the router, then Node) can persist/inspect exactly what
    MT5 actually said, never just a free-text message. Never contains
    credentials."""

    def __init__(self, message: str, diagnostics: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.diagnostics = diagnostics


class MT5ReconciliationError(MT5DemoSafetyError):
    """order_send reported success but positions_get() could not confirm a real position."""


class MT5PendingOrderNotConfirmedError(MT5ReconciliationError):
    """order_send appeared accepted (retcode ok, order==0 or ticket not found) but
    bounded reconciliation via orders_get() found ZERO matching pending orders."""


class MT5PendingOrderConfirmationAmbiguousError(MT5ReconciliationError):
    """order_send appeared accepted but bounded reconciliation across
    orders_get()/positions_get()/history_orders_get()/history_deals_get()
    found MORE THAN ONE possible matching object (in one source, or
    conflicting matches across sources) — never guess which one is ours."""


class MT5PendingOrderCancelledError(MT5ReconciliationError):
    """Bounded reconciliation found no active order/position, but order/deal
    HISTORY proves the broker itself cancelled, rejected, or expired the
    order — a definite, distinct terminal outcome. Never conflated with
    MT5PendingOrderNotConfirmedError, which means "we genuinely found no
    evidence anywhere", not "we found evidence it did not go through"."""


class MT5OrderSendReturnedNoneError(MT5DemoSafetyError):
    """order_check() or order_send() returned None — the MetaTrader5 Python
    library/terminal IPC failed before any trade-server MqlTradeResult ever
    came back. This is an infrastructure failure, never a trade-server
    rejection: there is no retcode/order/deal/request_id to report, only
    mt5.last_error() (a completely different error namespace — spec section
    9). Must never be presented to a caller as retcode 0, since 0 is not
    "no result" — it is this specific broker's own undocumented but real
    trade-server code (see _order_send_ok_retcodes)."""


def _load_mt5() -> Any:
    try:
        import MetaTrader5  # type: ignore[import-not-found]
    except Exception as exc:  # pragma: no cover - depends on Windows terminal setup
        raise MT5UnavailableError("MetaTrader5 Python package or terminal is unavailable") from exc
    return MetaTrader5


def _dec(value: Any) -> Decimal:
    return Decimal(str(value or "0"))


def _obj(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if hasattr(value, "_asdict"):
        return dict(value._asdict())
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return {"value": value}


def _retcode_name(mt5: Any, code: int) -> str:
    """Reverse-looks-up the real MT5 TRADE_RETCODE_* constant name for a
    numeric code (spec section 4: "do not treat every accepted-looking
    result identically" — the name is what actually gets persisted/reported,
    never just the bare integer).

    0 is handled as its own case, never falling into the generic
    "UNKNOWN_RETCODE_N" bucket: the real MT5 TRADE_RETCODE_* enum starts at
    10004, so 0 can NEVER be a documented trade-server code — this is
    specifically this broker/account's own non-standard value (see
    _order_check_ok_retcodes/_order_send_ok_retcodes), and "UNKNOWN_RETCODE_0"
    reads exactly like a formatted, real MT5 constant name, which has caused
    it to be mistaken for a genuine/synthetic result. Labeled distinctly so
    it is never confused with either a real documented code or a fabricated
    placeholder."""
    if code == 0:
        return "BROKER_NONSTANDARD_RETCODE_ZERO"
    for name in dir(mt5):
        if name.startswith("TRADE_RETCODE_") and getattr(mt5, name, None) == code:
            return name
    return f"UNKNOWN_RETCODE_{code}"


def _order_state_name(mt5: Any, state: int) -> str:
    for name in dir(mt5):
        if name.startswith("ORDER_STATE_") and getattr(mt5, name, None) == state:
            return name
    return f"UNKNOWN_ORDER_STATE_{state}"


# The exact request fields that actually reach order_send (spec section 1) —
# a trade request never contains credentials, so this is always safe to log
# and persist in full.
_REQUEST_DIAGNOSTIC_FIELDS = (
    "action",
    "symbol",
    "volume",
    "type",
    "price",
    "sl",
    "tp",
    "stoplimit",
    "deviation",
    "magic",
    "comment",
    "type_time",
    "expiration",
    "type_filling",
)


def _safe_request_diagnostics(resolved_request: dict[str, Any]) -> dict[str, Any]:
    return {key: resolved_request.get(key) for key in _REQUEST_DIAGNOSTIC_FIELDS}


def _safe_check_diagnostics(check: dict[str, Any], mt5: Any) -> dict[str, Any]:
    retcode = check.get("retcode")
    return {
        "retcode": retcode,
        "retcode_name": _retcode_name(mt5, int(retcode)) if retcode is not None else None,
        "comment": check.get("comment"),
        "margin": check.get("margin"),
        "margin_free": check.get("margin_free"),
        "margin_level": check.get("margin_level"),
    }


def _safe_send_diagnostics(result: dict[str, Any], mt5: Any, last_error: str) -> dict[str, Any]:
    retcode = result.get("retcode")
    return {
        "retcode": retcode,
        "retcode_name": _retcode_name(mt5, int(retcode)) if retcode is not None else None,
        "order": result.get("order"),
        "deal": result.get("deal"),
        "request_id": result.get("request_id"),
        "volume": result.get("volume"),
        "price": result.get("price"),
        "bid": result.get("bid"),
        "ask": result.get("ask"),
        "comment": result.get("comment"),
        "retcode_external": result.get("retcode_external"),
        "last_error": last_error,
    }


@dataclass(frozen=True)
class PendingOrderReconciliation:
    """The outcome of reconciling a pending-order order_send() across every
    MT5 source of truth (spec section 1): still an active pending order, an
    open position (the order triggered immediately), or history proving it
    was filled. Exactly one of order/position/history_order/history_deal is
    ever populated."""

    state: str  # "PENDING" | "TRIGGERED_POSITION" | "FILLED_HISTORY"
    order: dict[str, Any] | None = None
    position: dict[str, Any] | None = None
    history_order: dict[str, Any] | None = None
    history_deal: dict[str, Any] | None = None


@dataclass(frozen=True)
class MT5DemoGuardResult:
    ok: bool
    reason: str | None
    account: dict[str, Any] | None
    terminal: dict[str, Any] | None
    allowed_login: int | None
    allowed_server: str | None

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


class MT5Adapter:
    """Thin wrapper around the official MetaTrader5 package.

    The wrapper intentionally exposes order_send but does not make safety
    decisions. Server-side callers must use DemoExecutionGateway for every
    execution path.
    """

    def __init__(self, module: Any | None = None) -> None:
        self._mt5 = module
        self._initialized = False

    @property
    def mt5(self) -> Any:
        if self._mt5 is None:
            self._mt5 = _load_mt5()
        return self._mt5

    def initialize(self) -> bool:
        terminal_path = os.environ.get("MT5_TERMINAL_PATH") or None
        ok = bool(
            self.mt5.initialize(path=terminal_path) if terminal_path else self.mt5.initialize()
        )
        self._initialized = ok
        if not ok:
            raise MT5UnavailableError(str(self.mt5.last_error()))
        return True

    def shutdown(self) -> None:
        if self._mt5 is not None:
            self._mt5.shutdown()
        self._initialized = False

    def ensure_connected(self) -> None:
        if not self._initialized:
            self.initialize()
        if self.account_info() is None:
            self.shutdown()
            self.initialize()
            if self.account_info() is None:
                raise MT5UnavailableError("MT5 account_info() failed after reconnect")

    def account_info(self) -> Any:
        return self.mt5.account_info()

    def terminal_info(self) -> Any:
        return self.mt5.terminal_info()

    def symbols_get(self, group: str | None = None) -> list[Any]:
        return list(self.mt5.symbols_get(group) if group else self.mt5.symbols_get() or [])

    def symbol_select(self, symbol: str, enable: bool = True) -> bool:
        return bool(self.mt5.symbol_select(symbol, enable))

    def symbol_info(self, symbol: str) -> Any:
        return self.mt5.symbol_info(symbol)

    def symbol_info_tick(self, symbol: str) -> Any:
        return self.mt5.symbol_info_tick(symbol)

    def copy_rates_from(self, symbol: str, timeframe: int, date_from: datetime, count: int) -> Any:
        return self.mt5.copy_rates_from(symbol, timeframe, date_from, count)

    def copy_rates_from_pos(self, symbol: str, timeframe: int, start_pos: int, count: int) -> Any:
        return self.mt5.copy_rates_from_pos(symbol, timeframe, start_pos, count)

    def copy_rates_range(
        self, symbol: str, timeframe: int, date_from: datetime, date_to: datetime
    ) -> Any:
        return self.mt5.copy_rates_range(symbol, timeframe, date_from, date_to)

    def positions_get(self, symbol: str | None = None) -> list[Any]:
        return list(
            self.mt5.positions_get(symbol=symbol) if symbol else self.mt5.positions_get() or []
        )

    def orders_get(self, symbol: str | None = None) -> list[Any]:
        return list(self.mt5.orders_get(symbol=symbol) if symbol else self.mt5.orders_get() or [])

    def history_orders_get(
        self, date_from: datetime, date_to: datetime, **kwargs: Any
    ) -> list[Any]:
        return list(self.mt5.history_orders_get(date_from, date_to, **kwargs) or [])

    def history_deals_get(self, date_from: datetime, date_to: datetime, **kwargs: Any) -> list[Any]:
        return list(self.mt5.history_deals_get(date_from, date_to, **kwargs) or [])

    def order_calc_profit(
        self, action: int, symbol: str, volume: float, price_open: float, price_close: float
    ) -> Any:
        return self.mt5.order_calc_profit(action, symbol, volume, price_open, price_close)

    def order_calc_margin(self, action: int, symbol: str, volume: float, price: float) -> Any:
        return self.mt5.order_calc_margin(action, symbol, volume, price)

    def order_check(self, request: dict[str, Any]) -> Any:
        return self.mt5.order_check(request)

    def order_send(self, request: dict[str, Any]) -> Any:
        return self.mt5.order_send(request)

    def timeframe(self, value: str) -> int:
        """Delegates to the single canonical timeframe contract
        (mt5/timeframes.py) — never build a second mapping here. Raises
        UnsupportedTimeframeError (with the actual offending value) rather
        than a bare KeyError."""
        return resolve_mt5_timeframe(self.mt5, value)


class DemoExecutionGateway:
    """The only allowed order_send caller in the codebase."""

    def __init__(self, adapter: MT5Adapter | None = None) -> None:
        self.adapter = adapter or MT5Adapter()

    def verify_demo_environment(self) -> MT5DemoGuardResult:
        allowed_login = os.environ.get("MT5_ALLOWED_DEMO_LOGIN")
        allowed_server = os.environ.get("MT5_ALLOWED_DEMO_SERVER")
        if not allowed_login or not allowed_server:
            return MT5DemoGuardResult(
                False, "Allowed demo login/server are not configured", None, None, None, None
            )

        self.adapter.ensure_connected()
        account_raw = self.adapter.account_info()
        terminal_raw = self.adapter.terminal_info()
        account = _obj(account_raw)
        terminal = _obj(terminal_raw)
        login = int(account.get("login", 0) or 0)
        server = str(account.get("server", "") or "")
        trade_mode = int(account.get("trade_mode", -1))

        demo_mode = getattr(self.adapter.mt5, "ACCOUNT_TRADE_MODE_DEMO", 0)
        if trade_mode != demo_mode:
            return MT5DemoGuardResult(
                False,
                "MT5 account is not DEMO",
                account,
                terminal,
                int(allowed_login),
                allowed_server,
            )
        if login != int(allowed_login):
            return MT5DemoGuardResult(
                False,
                "MT5 login does not match configured demo account",
                account,
                terminal,
                int(allowed_login),
                allowed_server,
            )
        if server != allowed_server:
            return MT5DemoGuardResult(
                False,
                "MT5 server does not match configured demo server",
                account,
                terminal,
                int(allowed_login),
                allowed_server,
            )
        if not bool(terminal.get("trade_allowed", False)):
            return MT5DemoGuardResult(
                False,
                "MT5 terminal trading is disabled",
                account,
                terminal,
                int(allowed_login),
                allowed_server,
            )
        if os.environ.get("MT5_EXECUTION_MODE", "demo").lower() != "demo":
            return MT5DemoGuardResult(
                False,
                "Application execution mode is not demo",
                account,
                terminal,
                int(allowed_login),
                allowed_server,
            )
        return MT5DemoGuardResult(True, None, account, terminal, int(allowed_login), allowed_server)

    def _order_check_ok_retcodes(self) -> set[int]:
        # Empirically confirmed against the live connected MT5 DEMO terminal
        # (login/server pinned by MT5_ALLOWED_DEMO_LOGIN/SERVER): this broker's
        # trade server reports retcode=0 with comment="Done" for BOTH
        # order_check() and order_send() on a request that succeeds, not the
        # documented TRADE_RETCODE_DONE=10009 the MetaTrader5 Python package's
        # own constants suggest. 0 is safe to accept here ONLY because a
        # None/missing result is rejected as an exception before this is ever
        # evaluated (see order_check()/execute_market_order() below) — so a
        # real, non-None OrderCheckResult is the only thing that can produce
        # retcode 0 at this point.
        mt5 = self.adapter.mt5
        return {
            0,
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_PLACED", 10008),
        }

    def _order_send_ok_retcodes(self) -> set[int]:
        # See _order_check_ok_retcodes for why 0 is included. Accepting it
        # here is safe specifically because retcode is never the final word
        # for order_send: execute_market_order() still requires a real
        # order/deal ticket AND independent positions_get() confirmation
        # before a trade is ever recorded as executed — a request that
        # actually failed returns one of the specific TRADE_RETCODE_* error
        # codes (REQUOTE, NO_MONEY, INVALID_STOPS, ...), never 0, and would
        # in any case have no ticket or no confirmable position.
        mt5 = self.adapter.mt5
        return {
            0,
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010),
        }

    def _last_error(self) -> str:
        try:
            return str(self.adapter.mt5.last_error())
        except Exception:  # pragma: no cover - defensive only
            return "unavailable"

    def _last_error_parts(self) -> dict[str, Any]:
        """Splits mt5.last_error() into its own code/message fields (spec
        section 1: "last_error_code, last_error_message") instead of only
        the combined string form — this is the Python MT5 library/IPC error
        channel, never the trade-server retcode channel (spec section 9),
        so it is always reported under its own distinct keys."""
        try:
            raw = self.adapter.mt5.last_error()
        except Exception:  # pragma: no cover - defensive only
            return {"code": None, "message": "unavailable"}
        if isinstance(raw, (tuple, list)) and len(raw) >= 2:
            return {"code": raw[0], "message": raw[1]}
        return {"code": None, "message": str(raw) if raw is not None else None}

    def _resolve_filling_mode(self, symbol: str) -> int:
        """Determines the broker/symbol-supported order filling mode instead
        of hardcoding one. A filling mode the broker does not support is a
        common reason order_check/order_send silently reject a request."""
        mt5 = self.adapter.mt5
        info = _obj(self.adapter.symbol_info(symbol))
        mode = int(info.get("filling_mode") or 0)
        ioc_flag = getattr(mt5, "SYMBOL_FILLING_IOC", 2)
        fok_flag = getattr(mt5, "SYMBOL_FILLING_FOK", 1)
        if mode & ioc_flag:
            return getattr(mt5, "ORDER_FILLING_IOC", 1)
        if mode & fok_flag:
            return getattr(mt5, "ORDER_FILLING_FOK", 0)
        return getattr(mt5, "ORDER_FILLING_RETURN", 2)

    def _resolve_request(self, request: dict[str, Any]) -> dict[str, Any]:
        """Returns a copy of request with type_filling overridden to the
        broker/symbol-supported mode. This is the single place that decides
        filling mode — callers (routers, Node) must not hardcode it."""
        resolved = dict(request)
        resolved["type_filling"] = self._resolve_filling_mode(str(resolved.get("symbol") or ""))
        return resolved

    def _confirm_position(
        self,
        symbol: str,
        order_ticket: Any,
        deal_ticket: Any,
        comment: str | None = None,
        attempts: int = 3,
    ) -> dict[str, Any] | None:
        """MT5's source of truth for "is there really a position" is
        positions_get(), never the order_send() return value alone. A short
        bounded retry absorbs the rare case where the position is not yet
        visible in the microseconds right after order_send() returns."""
        for attempt in range(attempts):
            positions = [_obj(p) for p in self.adapter.positions_get(symbol)]
            for pos in positions:
                ticket = str(pos.get("ticket") or "")
                if order_ticket and ticket == str(order_ticket):
                    return pos
                if deal_ticket and ticket == str(deal_ticket):
                    return pos
            if comment:
                for pos in positions:
                    if str(pos.get("comment") or "") == comment:
                        return pos
            if attempt < attempts - 1:
                time.sleep(0.25)
        return None

    def order_check(self, request: dict[str, Any]) -> dict[str, Any]:
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")
        self._verify_tradable_symbol(request)
        resolved = self._resolve_request(request)
        check_raw = self.adapter.order_check(resolved)
        if check_raw is None:
            raise MT5DemoSafetyError(
                f"MT5 order_check returned no result (terminal error: {self._last_error()})"
            )
        return _obj(check_raw)

    def execute_market_order(self, request: dict[str, Any]) -> dict[str, Any]:
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")
        self._verify_tradable_symbol(request)
        resolved = self._resolve_request(request)
        symbol = str(resolved.get("symbol") or "")
        comment = str(resolved.get("comment") or "") or None

        logger.info(
            "mt5 order_check request symbol=%s side=%s volume=%s type_filling=%s comment=%s",
            symbol,
            resolved.get("type"),
            resolved.get("volume"),
            resolved.get("type_filling"),
            comment,
        )

        check_raw = self.adapter.order_check(resolved)
        if check_raw is None:
            raise MT5DemoSafetyError(
                f"MT5 order_check returned no result (terminal error: {self._last_error()})"
            )
        check = _obj(check_raw)
        check_retcode = int(check.get("retcode", -1) if check.get("retcode") is not None else -1)
        if check_retcode not in self._order_check_ok_retcodes():
            check_comment = check.get("comment")
            raise MT5DemoSafetyError(
                f"MT5 order_check rejected request: retcode={check_retcode} comment={check_comment}"
            )

        send_raw = self.adapter.order_send(resolved)
        if send_raw is None:
            raise MT5DemoSafetyError(
                f"MT5 order_send returned no result (terminal error: {self._last_error()})"
            )
        result = _obj(send_raw)
        send_retcode = int(result.get("retcode", -1) if result.get("retcode") is not None else -1)
        logger.info(
            "mt5 order_send result symbol=%s retcode=%s order=%s deal=%s comment=%s",
            symbol,
            send_retcode,
            result.get("order"),
            result.get("deal"),
            result.get("comment"),
        )
        if send_retcode not in self._order_send_ok_retcodes():
            send_comment = result.get("comment")
            raise MT5DemoSafetyError(
                f"MT5 order_send rejected the order: retcode={send_retcode} comment={send_comment}"
            )

        order_ticket = result.get("order")
        deal_ticket = result.get("deal")
        if not order_ticket and not deal_ticket:
            raise MT5DemoSafetyError(
                "MT5 order_send reported success but returned no order/deal ticket; "
                "refusing to record an open position"
            )

        confirmed = self._confirm_position(symbol, order_ticket, deal_ticket, comment)
        if confirmed is None:
            raise MT5ReconciliationError(
                f"MT5 order_send succeeded (retcode={send_retcode}, order={order_ticket}, "
                f"deal={deal_ticket}) but no matching position was found via positions_get(); "
                "refusing to record an open position"
            )

        result["checked_request"] = check
        result["resolved_type_filling"] = resolved.get("type_filling")
        result["executed_at"] = datetime.now(tz=UTC).isoformat()
        result["confirmed_position"] = confirmed
        return result

    def _confirm_pending_order_by_ticket(
        self, symbol: str, order_ticket: Any, attempts: int = 3
    ) -> dict[str, Any] | None:
        """Confirms a specific ticket MT5 told us about actually exists via
        orders_get() — the real source of truth that a PENDING order (not
        yet triggered) exists, per the DEMO safety rule that nothing may be
        recorded as PENDING_ORDER_PLACED from order_send()'s return value
        alone. A short bounded retry absorbs the rare case where the order
        is not yet visible in the microseconds right after order_send()."""
        for attempt in range(attempts):
            orders = [_obj(o) for o in self.adapter.orders_get(symbol)]
            for order in orders:
                if str(order.get("ticket") or "") == str(order_ticket):
                    return order
            if attempt < attempts - 1:
                time.sleep(0.25)
        return None

    # Bounded, FAST synchronous polling schedule for order==0 recovery —
    # immediate check, then one retry ~150ms later (spec: "the browser
    # request must not be blocked for multiple seconds" / "total synchronous
    # confirmation target <= 300-500ms beyond order_send()"). This used to be
    # (0.0, 0.25, 0.5, 1.0) — ~1.75s of blocking sleep inside the HTTP
    # request — which was the actual root cause of "PLACE ... IN MT5 DEMO"
    # feeling slow. A broker that needs more real wall-clock time than this
    # short window to register the order is NEVER given up on: the caller
    # (Node's placePendingOrder) treats "not found within this fast pass" as
    # "still confirming" and continues checking in a bounded, non-blocking
    # background pass (500ms/1s/2s/3s — see
    # scheduleBackgroundPendingOrderReconciliation) instead of holding this
    # request open or declaring failure prematurely. Total patience given to
    # the broker is therefore GREATER than before (~300ms + ~3s background
    # vs. the old ~1.75s all spent synchronously), just relocated off the
    # blocking HTTP path.
    _RECONCILE_DELAYS_SECONDS: tuple[float, ...] = (0.0, 0.15)

    def _price_tolerance(self, symbol: str) -> float:
        info = _obj(self.adapter.symbol_info(symbol))
        point = float(info.get("point") or 0) or float(info.get("trade_tick_size") or 0)
        # A handful of points is generous enough to absorb broker-side
        # rounding while still being useless for confusing two genuinely
        # different pending orders (which are set at least stops-level apart).
        return point * 5 if point > 0 else 0.0005

    def _match_orders_by_fields(
        self,
        orders: list[dict[str, Any]],
        resolved_request: dict[str, Any],
        comment: str | None,
        *,
        prefer_volume_initial: bool = False,
    ) -> list[dict[str, Any]]:
        """Identifies ONLY the order created by this exact request. The
        unique execution-key comment (see planComment on the Node side) is
        the primary, most reliable discriminator — matching by symbol alone
        is explicitly insufficient once more than one pending order can
        exist for the same symbol. Falls back to broader field matching
        (type/volume/price/sl/tp/magic, within broker precision) only if no
        order carries the expected comment, in case a broker truncates or
        strips comments. `prefer_volume_initial` is for history orders, whose
        volume_current is 0 once filled/cancelled — volume_initial is the
        one that still reflects the originally requested volume."""
        if comment:
            exact = [o for o in orders if str(o.get("comment") or "") == comment]
            if exact:
                return exact

        requested_type = resolved_request.get("type")
        requested_magic = resolved_request.get("magic")
        requested_volume = resolved_request.get("volume")
        requested_price = resolved_request.get("price")
        requested_sl = resolved_request.get("sl")
        requested_tp = resolved_request.get("tp")
        tolerance = self._price_tolerance(str(resolved_request.get("symbol") or ""))

        def close(actual: Any, expected: Any, tol: float) -> bool:
            if expected is None:
                return True
            try:
                return abs(float(actual) - float(expected)) <= tol
            except (TypeError, ValueError):
                return False

        candidates = []
        for order in orders:
            order_type = int(order.get("type", -1))
            if requested_type is not None and order_type != int(requested_type):
                continue
            order_magic = int(order.get("magic", -1) or -1)
            if requested_magic is not None and order_magic != int(requested_magic):
                continue
            if prefer_volume_initial:
                order_volume = order.get("volume_initial", order.get("volume_current"))
            else:
                order_volume = order.get("volume_current", order.get("volume_initial"))
            if not close(order_volume, requested_volume, 1e-6):
                continue
            if not close(order.get("price_open"), requested_price, tolerance):
                continue
            if not close(order.get("sl"), requested_sl, tolerance):
                continue
            if not close(order.get("tp"), requested_tp, tolerance):
                continue
            candidates.append(order)
        return candidates

    def _match_pending_orders(
        self, orders: list[dict[str, Any]], resolved_request: dict[str, Any], comment: str | None
    ) -> list[dict[str, Any]]:
        return self._match_orders_by_fields(orders, resolved_request, comment)

    def _match_history_orders(
        self, orders: list[dict[str, Any]], resolved_request: dict[str, Any], comment: str | None
    ) -> list[dict[str, Any]]:
        return self._match_orders_by_fields(
            orders, resolved_request, comment, prefer_volume_initial=True
        )

    def _expected_position_type(self, order_type: int) -> int | None:
        """A triggered pending order becomes a plain BUY/SELL position, not
        its own BUY_LIMIT/BUY_STOP/etc. constant — this maps one to the
        other so position matching can still filter by direction."""
        mt5 = self.adapter.mt5
        buy_types = {
            getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2),
            getattr(mt5, "ORDER_TYPE_BUY_STOP", 4),
        }
        sell_types = {
            getattr(mt5, "ORDER_TYPE_SELL_LIMIT", 3),
            getattr(mt5, "ORDER_TYPE_SELL_STOP", 5),
        }
        if order_type in buy_types:
            return getattr(mt5, "POSITION_TYPE_BUY", 0)
        if order_type in sell_types:
            return getattr(mt5, "POSITION_TYPE_SELL", 1)
        return None

    def _match_positions(
        self, positions: list[dict[str, Any]], resolved_request: dict[str, Any], comment: str | None
    ) -> list[dict[str, Any]]:
        """Identifies a position that resulted from THIS pending-order
        request triggering immediately (spec section 6: "IMMEDIATE TRIGGER
        CASE"). Deliberately does not compare the position's fill price
        against the pending order's requested price — a market fill can
        legitimately differ (slippage on a STOP, price improvement on a
        LIMIT) — comment is still the primary discriminator, and the
        broader fallback relies on direction/volume/sl/tp/magic instead."""
        if comment:
            exact = [p for p in positions if str(p.get("comment") or "") == comment]
            if exact:
                return exact

        requested_type = resolved_request.get("type")
        expected_type = (
            self._expected_position_type(int(requested_type))
            if requested_type is not None
            else None
        )
        requested_magic = resolved_request.get("magic")
        requested_volume = resolved_request.get("volume")
        requested_sl = resolved_request.get("sl")
        requested_tp = resolved_request.get("tp")
        tolerance = self._price_tolerance(str(resolved_request.get("symbol") or ""))

        def close(actual: Any, expected: Any, tol: float) -> bool:
            if expected is None:
                return True
            try:
                return abs(float(actual) - float(expected)) <= tol
            except (TypeError, ValueError):
                return False

        candidates = []
        for pos in positions:
            if expected_type is not None and int(pos.get("type", -1)) != expected_type:
                continue
            pos_magic = int(pos.get("magic", -1) or -1)
            if requested_magic is not None and pos_magic != int(requested_magic):
                continue
            if not close(pos.get("volume"), requested_volume, 1e-6):
                continue
            if not close(pos.get("sl"), requested_sl, tolerance):
                continue
            if not close(pos.get("tp"), requested_tp, tolerance):
                continue
            candidates.append(pos)
        return candidates

    def _match_deals(
        self, deals: list[dict[str, Any]], resolved_request: dict[str, Any], comment: str | None
    ) -> list[dict[str, Any]]:
        """Deals carry no sl/tp and fill at market, not the pending price —
        comment is the only precise discriminator; the broader fallback is
        deliberately narrower (volume/magic only) than orders/positions."""
        if comment:
            exact = [d for d in deals if str(d.get("comment") or "") == comment]
            if exact:
                return exact

        requested_magic = resolved_request.get("magic")
        requested_volume = resolved_request.get("volume")

        def close(actual: Any, expected: Any, tol: float) -> bool:
            if expected is None:
                return True
            try:
                return abs(float(actual) - float(expected)) <= tol
            except (TypeError, ValueError):
                return False

        candidates = []
        for deal in deals:
            deal_magic = int(deal.get("magic", -1) or -1)
            if requested_magic is not None and deal_magic != int(requested_magic):
                continue
            if not close(deal.get("volume"), requested_volume, 1e-6):
                continue
            candidates.append(deal)
        return candidates

    # A recent-history sweep only ever needs to look back far enough to
    # cover the reconciliation window itself; the forward buffer absorbs a
    # broker server clock that runs ahead of this process's real UTC clock
    # (the same quirk documented on routers/mt5.py's /history-deals) so a
    # deal/order that JUST happened is never excluded by date_to.
    _HISTORY_RECONCILE_LOOKBACK_MINUTES = 30
    _HISTORY_RECONCILE_FORWARD_BUFFER_HOURS = 12

    def _reconciliation_history_window(self) -> tuple[datetime, datetime]:
        now = datetime.now(tz=UTC)
        return (
            now - timedelta(minutes=self._HISTORY_RECONCILE_LOOKBACK_MINUTES),
            now + timedelta(hours=self._HISTORY_RECONCILE_FORWARD_BUFFER_HOURS),
        )

    def _reconcile_from_history(
        self, symbol: str, resolved_request: dict[str, Any], comment: str | None
    ) -> PendingOrderReconciliation | None:
        """Bounded sweep of order/deal HISTORY (spec section 1C/1D) — the
        last resort before concluding PENDING_ORDER_NOT_CONFIRMED. A fast
        broker can fill (or even fill-and-close) a triggered pending order
        before either orders_get() or positions_get() ever reflects it, so
        history is the only remaining source of truth at that point."""
        mt5 = self.adapter.mt5
        date_from, date_to = self._reconciliation_history_window()

        history_orders = [
            _obj(o) for o in self.adapter.history_orders_get(date_from, date_to, group=symbol)
        ]
        order_matches = self._match_history_orders(history_orders, resolved_request, comment)
        if len(order_matches) > 1:
            raise MT5PendingOrderConfirmationAmbiguousError(
                f"order_send appeared accepted for {symbol} (comment={comment}) but "
                f"{len(order_matches)} possible matching orders were found via "
                "history_orders_get(); refusing to guess which one is ours"
            )
        if len(order_matches) == 1:
            order = order_matches[0]
            state = int(order.get("state", -1))
            filled_states = {getattr(mt5, "ORDER_STATE_FILLED", 4)}
            cancelled_states = {
                getattr(mt5, "ORDER_STATE_CANCELED", 2),
                getattr(mt5, "ORDER_STATE_REJECTED", 5),
                getattr(mt5, "ORDER_STATE_EXPIRED", 6),
            }
            if state in filled_states:
                return PendingOrderReconciliation(state="FILLED_HISTORY", history_order=order)
            if state in cancelled_states:
                raise MT5PendingOrderCancelledError(
                    f"order_send for {symbol} (comment={comment}) was later "
                    f"{_order_state_name(mt5, state)} per history_orders_get(); a fresh AI "
                    "plan/execution key is required to try again"
                )
            # Any other in-between state (e.g. still PLACED/PARTIAL per this
            # sweep) is inconclusive — fall through to deal history.

        deals = [_obj(d) for d in self.adapter.history_deals_get(date_from, date_to, group=symbol)]
        # DEAL_ENTRY_IN is 0 — `d.get("entry") or -1` would wrongly treat a
        # genuine 0 as missing, so None is checked explicitly instead.
        entry_deals = [
            d
            for d in deals
            if d.get("entry") is not None and int(d["entry"]) == getattr(mt5, "DEAL_ENTRY_IN", 0)
        ]
        deal_matches = self._match_deals(entry_deals, resolved_request, comment)
        if len(deal_matches) > 1:
            raise MT5PendingOrderConfirmationAmbiguousError(
                f"order_send appeared accepted for {symbol} (comment={comment}) but "
                f"{len(deal_matches)} possible matching deals were found via "
                "history_deals_get(); refusing to guess which one is ours"
            )
        if len(deal_matches) == 1:
            return PendingOrderReconciliation(state="FILLED_HISTORY", history_deal=deal_matches[0])

        return None

    def _reconcile_pending_order(
        self, symbol: str, resolved_request: dict[str, Any], comment: str | None
    ) -> PendingOrderReconciliation:
        """Recovery path for a broker/environment that can report an
        accepted-looking order_send retcode while result.order == 0 (or a
        ticket that never shows up). Never immediately concludes failure and
        never invents a ticket — reconciles across EVERY MT5 source (spec
        section 1): active pending orders, open positions (the immediate-
        trigger case), then bounded order/deal history, on a short bounded
        polling schedule, never an unbounded retry loop."""
        last_order_candidates: list[dict[str, Any]] = []
        last_position_candidates: list[dict[str, Any]] = []
        for delay in self._RECONCILE_DELAYS_SECONDS:
            if delay:
                time.sleep(delay)
            orders = [_obj(o) for o in self.adapter.orders_get(symbol)]
            order_matches = self._match_pending_orders(orders, resolved_request, comment)
            positions = [_obj(p) for p in self.adapter.positions_get(symbol)]
            position_matches = self._match_positions(positions, resolved_request, comment)
            logger.info(
                "mt5 pending order reconciliation attempt symbol=%s comment=%s delay=%.2fs "
                "order_matches=%d position_matches=%d",
                symbol,
                comment,
                delay,
                len(order_matches),
                len(position_matches),
            )
            if len(order_matches) == 1 and not position_matches:
                return PendingOrderReconciliation(state="PENDING", order=order_matches[0])
            if len(position_matches) == 1 and not order_matches:
                return PendingOrderReconciliation(
                    state="TRIGGERED_POSITION", position=position_matches[0]
                )
            last_order_candidates = order_matches
            last_position_candidates = position_matches

        if (
            len(last_order_candidates) > 1
            or len(last_position_candidates) > 1
            or (last_order_candidates and last_position_candidates)
        ):
            raise MT5PendingOrderConfirmationAmbiguousError(
                f"order_send appeared accepted for {symbol} (comment={comment}) but multiple/"
                "conflicting possible matches were found across orders_get()/positions_get(); "
                "refusing to guess which one is ours"
            )

        # Neither a live pending order nor a live position — the last resort
        # before concluding failure is a bounded sweep of order/deal history
        # (spec section 1C/1D/6): a fast fill-and-close can outrun both live
        # endpoints entirely.
        history_result = self._reconcile_from_history(symbol, resolved_request, comment)
        if history_result is not None:
            return history_result

        raise MT5PendingOrderNotConfirmedError(
            f"order_send appeared accepted for {symbol} (comment={comment}) but no matching MT5 "
            "pending order, open position, or order/deal history was found after bounded "
            "reconciliation"
        )

    def _verify_pending_order_broker_support(
        self, symbol: str, resolved_request: dict[str, Any]
    ) -> dict[str, Any]:
        """Confirms the broker actually permits this exact pending-order
        request BEFORE ever calling order_check/order_send (spec section 7):
        trading isn't disabled/close-only for this symbol, the requested
        STOP/LIMIT order type is one the broker's order_mode bitmask
        actually allows, and the requested type_time is one the broker's
        expiration_mode bitmask actually allows. A broker-side
        incompatibility must produce an explicit, specific error here —
        never a mysterious accepted-but-unconfirmed result downstream.
        Returns the raw symbol_info dict for reuse (digits/stops level/etc.).

        NOTE: the official MetaTrader5 Python package does not expose
        SYMBOL_ORDER_*/SYMBOL_EXPIRATION_* as named module constants (only
        symbol_info().order_mode/.expiration_mode integers) — the
        getattr(..., default) calls below always resolve to their documented
        MQL5 ENUM_SYMBOL_ORDER_MODE/ENUM_SYMBOL_EXPIRATION_MODE integer
        values, same as the pre-existing SYMBOL_FILLING_IOC/FOK pattern in
        _resolve_filling_mode."""
        mt5 = self.adapter.mt5
        info = _obj(self.adapter.symbol_info(symbol))
        if not info:
            raise MT5DemoSafetyError(f"MT5 symbol_info unavailable for {symbol}")

        trade_mode = int(info.get("trade_mode", -1))
        disallowed_trade_modes = {
            getattr(mt5, "SYMBOL_TRADE_MODE_DISABLED", 0),
            getattr(mt5, "SYMBOL_TRADE_MODE_CLOSEONLY", 3),
        }
        if trade_mode in disallowed_trade_modes:
            raise MT5DemoSafetyError(
                f"MT5 symbol {symbol} does not permit new orders right now "
                f"(trade_mode={trade_mode})"
            )

        order_type = int(resolved_request.get("type", -1))
        order_mode = int(info.get("order_mode") or 0)
        limit_types = {
            getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2),
            getattr(mt5, "ORDER_TYPE_SELL_LIMIT", 3),
        }
        stop_types = {
            getattr(mt5, "ORDER_TYPE_BUY_STOP", 4),
            getattr(mt5, "ORDER_TYPE_SELL_STOP", 5),
        }
        if order_type in limit_types and not (order_mode & getattr(mt5, "SYMBOL_ORDER_LIMIT", 2)):
            raise MT5DemoSafetyError(
                f"MT5 symbol {symbol} does not support LIMIT pending orders "
                f"(order_mode={order_mode})"
            )
        if order_type in stop_types and not (order_mode & getattr(mt5, "SYMBOL_ORDER_STOP", 4)):
            raise MT5DemoSafetyError(
                f"MT5 symbol {symbol} does not support STOP pending orders "
                f"(order_mode={order_mode})"
            )

        type_time = int(resolved_request.get("type_time", -1))
        expiration_mode = int(info.get("expiration_mode") or 0)
        order_time_gtc = getattr(mt5, "ORDER_TIME_GTC", 0)
        order_time_specified = getattr(mt5, "ORDER_TIME_SPECIFIED", 1)
        if type_time == order_time_gtc and not (
            expiration_mode & getattr(mt5, "SYMBOL_EXPIRATION_GTC", 1)
        ):
            raise MT5DemoSafetyError(
                f"MT5 symbol {symbol} does not support GTC pending orders "
                f"(expiration_mode={expiration_mode})"
            )
        if type_time == order_time_specified and not (
            expiration_mode & getattr(mt5, "SYMBOL_EXPIRATION_SPECIFIED", 4)
        ):
            raise MT5DemoSafetyError(
                f"MT5 symbol {symbol} does not support a specified expiration time "
                f"(expiration_mode={expiration_mode})"
            )
        return info

    def _verify_pending_price_against_latest_tick(
        self, symbol: str, resolved_request: dict[str, Any]
    ) -> None:
        """Pending-order price/direction must still make sense against the
        LATEST tick, not a stale AI-analysis price (spec section 6) — price
        can move between plan approval and this exact order_send call."""
        mt5 = self.adapter.mt5
        tick = _obj(self.adapter.symbol_info_tick(symbol))
        bid = tick.get("bid")
        ask = tick.get("ask")
        price = resolved_request.get("price")
        if price is None or bid is None or ask is None:
            # Nothing to recheck against — order_check/order_send will still
            # catch a genuinely bad request.
            return

        order_type = int(resolved_request.get("type", -1))
        buy_types = {
            getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2),
            getattr(mt5, "ORDER_TYPE_BUY_STOP", 4),
        }
        current = float(ask) if order_type in buy_types else float(bid)
        price = float(price)
        rule = {
            getattr(mt5, "ORDER_TYPE_BUY_LIMIT", 2): price < current,
            getattr(mt5, "ORDER_TYPE_SELL_LIMIT", 3): price > current,
            getattr(mt5, "ORDER_TYPE_BUY_STOP", 4): price > current,
            getattr(mt5, "ORDER_TYPE_SELL_STOP", 5): price < current,
        }
        ok = rule.get(order_type)
        if ok is False:
            raise MT5DemoSafetyError(
                f"MT5 pending order price {price} is no longer valid against the latest tick "
                f"(current={current}) for {symbol} — price moved since the plan was approved"
            )

    def execute_pending_order(self, request: dict[str, Any]) -> dict[str, Any]:
        """Places a REAL MT5 pending order (BUY_LIMIT/SELL_LIMIT/BUY_STOP/
        SELL_STOP) so the broker itself waits for price — the app never
        polls price client-side and fires a market order in its place. Same
        DEMO guard + order_check + order_send discipline as
        execute_market_order, but confirmed across orders_get()/
        positions_get()/history_orders_get()/history_deals_get() since a
        pending order can trigger (or even fill-and-close) before this ever
        returns, not just sit unconfirmed (spec sections 1/6)."""
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")
        self._verify_tradable_symbol(request)
        resolved = self._resolve_request(request)
        symbol = str(resolved.get("symbol") or "")
        comment = str(resolved.get("comment") or "") or None
        mt5 = self.adapter.mt5

        request_diagnostics = _safe_request_diagnostics(resolved)

        # Pre-flight broker-capability + latest-tick checks (spec sections
        # 6/7) — a broker-side incompatibility or a stale price must produce
        # an explicit, specific error here, before order_check/order_send
        # ever run, never a mysterious accepted-but-unconfirmed result.
        symbol_capabilities = self._verify_pending_order_broker_support(symbol, resolved)
        self._verify_pending_price_against_latest_tick(symbol, resolved)

        # Development diagnostics (spec: "Before order_send also inspect
        # mt5.version(), terminal_info(), account_info(), symbol_info(symbol)
        # ... trade_mode, order_mode, filling_mode, expiration_mode,
        # trade_stops_level, trade_freeze_level") — logged once per attempt,
        # right before order_check, using the SAME symbol_info() call
        # _verify_pending_order_broker_support already made (never a second
        # redundant MT5 call just for logging). Never guessed/assumed —
        # exactly what MT5 reports for THIS symbol right now.
        try:
            mt5_version = mt5.version()
        except Exception:  # pragma: no cover - defensive only
            mt5_version = None
        logger.debug("MT5 VERSION: %r", mt5_version)
        logger.debug(
            "SYMBOL_INFO CAPABILITIES symbol=%s trade_mode=%s order_mode=%s filling_mode=%s "
            "expiration_mode=%s trade_stops_level=%s trade_freeze_level=%s digits=%s point=%s",
            symbol,
            symbol_capabilities.get("trade_mode"),
            symbol_capabilities.get("order_mode"),
            symbol_capabilities.get("filling_mode"),
            symbol_capabilities.get("expiration_mode"),
            symbol_capabilities.get("trade_stops_level"),
            symbol_capabilities.get("trade_freeze_level"),
            symbol_capabilities.get("digits"),
            symbol_capabilities.get("point"),
        )

        # The EXACT request about to reach order_check/order_send (spec:
        # "print action, symbol, volume, type, price, sl, tp, stoplimit,
        # deviation, magic, comment, type_time, expiration, type_filling") —
        # request_diagnostics already covers exactly this field set
        # (_REQUEST_DIAGNOSTIC_FIELDS), logged verbatim, never guessed.
        logger.info("MT5 PENDING ORDER REQUEST: %s", request_diagnostics)

        # Perf timing (spec: "Add timing diagnostics in development ...
        # order_check_ms, order_send_ms, initial_confirmation_ms ... do not
        # guess where the delay is") — never guessed, always measured around
        # the exact calls that can be slow.
        timing_ms: dict[str, float] = {}
        _t0 = time.perf_counter()
        check_raw = self.adapter.order_check(resolved)
        timing_ms["order_check_ms"] = round((time.perf_counter() - _t0) * 1000, 1)
        # RAW order_check result, before any interpretation (spec: "print
        # check.retcode, check.comment" / "do not replace missing values
        # with 0") — logged exactly as the MetaTrader5 package returned it.
        logger.debug(
            "RAW ORDER_CHECK RESULT: %r | ASDICT: %s",
            check_raw,
            _obj(check_raw) if check_raw is not None else None,
        )
        if check_raw is None:
            last_error_parts = self._last_error_parts()
            raise MT5OrderSendReturnedNoneError(
                f"MT5 order_check returned no result before any trade-server response — "
                f"terminal/IPC error: {last_error_parts}",
                diagnostics={
                    "request": request_diagnostics,
                    "last_error_code": last_error_parts["code"],
                    "last_error_message": last_error_parts["message"],
                    "last_error": self._last_error(),
                },
            )
        check = _obj(check_raw)
        check_retcode = int(check.get("retcode", -1) if check.get("retcode") is not None else -1)
        check_diagnostics = _safe_check_diagnostics(check, mt5)
        # ORDER_CHECK and ORDER_SEND are never conflated (spec section 4): a
        # passing order_check only proves the request is well-formed and
        # affordable — it is NOT execution, and is logged/diagnosed under
        # its own distinct key, never reused as order_send evidence.
        logger.info(
            "mt5 pending ORDER_CHECK result symbol=%s retcode=%s retcode_name=%s comment=%s "
            "margin=%s margin_free=%s margin_level=%s",
            symbol,
            check_diagnostics["retcode"],
            check_diagnostics["retcode_name"],
            check_diagnostics["comment"],
            check_diagnostics["margin"],
            check_diagnostics["margin_free"],
            check_diagnostics["margin_level"],
        )
        if check_retcode not in self._order_check_ok_retcodes():
            raise MT5DemoSafetyError(
                f"MT5 order_check rejected pending order request: "
                f"retcode={check_retcode} ({check_diagnostics['retcode_name']}) "
                f"comment={check_diagnostics['comment']}",
                diagnostics={"request": request_diagnostics, "order_check": check_diagnostics},
            )

        _t0 = time.perf_counter()
        send_raw = self.adapter.order_send(resolved)
        timing_ms["order_send_ms"] = round((time.perf_counter() - _t0) * 1000, 1)
        # mt5.last_error() is only ever meaningful immediately after the call
        # that might have set it (spec section 1) — captured here, right
        # after order_send, not reused from an earlier point.
        last_error_after_send = self._last_error()
        # RAW result, before any interpretation (spec: "Do not transform
        # retcode=0 into a documented MT5 success code" / "capture repr(result),
        # result._asdict(), and result.request._asdict() when available") —
        # development diagnostics only, logged exactly as the MetaTrader5
        # package returned it, never credentials (a trade result never
        # carries any).
        logger.debug(
            "RAW ORDER_SEND RESULT: %r | ASDICT: %s | REQUEST_ASDICT: %s | LAST_ERROR: %s",
            send_raw,
            _obj(send_raw) if send_raw is not None else None,
            _obj(getattr(send_raw, "request", None)) if send_raw is not None else None,
            last_error_after_send,
        )
        if send_raw is None:
            # No MqlTradeResult ever came back from the trade server — there is
            # no retcode/order/deal/request_id to report. Never constructed as
            # a fake retcode-0 result (spec section 2/5): raised as its own
            # distinct exception type so the router/Node/frontend can show
            # "MT5 ORDER SEND FAILED BEFORE TRADE-SERVER RESULT", never
            # "0 — UNKNOWN_RETCODE_0".
            last_error_parts_after_send = self._last_error_parts()
            raise MT5OrderSendReturnedNoneError(
                f"MT5 order_send returned no result before any trade-server response — "
                f"terminal/IPC error: {last_error_parts_after_send}",
                diagnostics={
                    "request": request_diagnostics,
                    "order_check": check_diagnostics,
                    "last_error_code": last_error_parts_after_send["code"],
                    "last_error_message": last_error_parts_after_send["message"],
                    "last_error": last_error_after_send,
                },
            )
        result = _obj(send_raw)
        send_retcode = int(result.get("retcode", -1) if result.get("retcode") is not None else -1)
        send_retcode_name = _retcode_name(mt5, send_retcode)
        send_diagnostics = _safe_send_diagnostics(result, mt5, last_error_after_send)

        # Full MqlTradeResult, logged server-side only — never credentials,
        # and never shown verbatim to the client. This is the record of
        # exactly what this broker/environment actually returned, so a
        # retcode this codebase doesn't yet recognize is diagnosable instead
        # of silently swallowed.
        logger.info(
            "mt5 pending ORDER_SEND result symbol=%s retcode=%s retcode_name=%s deal=%s order=%s "
            "volume=%s price=%s bid=%s ask=%s comment=%s request_id=%s retcode_external=%s "
            "last_error=%s",
            symbol,
            send_retcode,
            send_retcode_name,
            result.get("deal"),
            result.get("order"),
            result.get("volume"),
            result.get("price"),
            result.get("bid"),
            result.get("ask"),
            result.get("comment"),
            result.get("request_id"),
            result.get("retcode_external"),
            last_error_after_send,
        )
        result["retcode_name"] = send_retcode_name
        result["last_error"] = last_error_after_send
        result["request_diagnostics"] = request_diagnostics
        result["retcode_is_broker_nonstandard_zero"] = send_retcode == 0

        # Explicit, narrow membership test against real MT5 retcode
        # constants (spec section 2) — never a range check, a truthy check,
        # or reuse of the order_check result. TRADE_RETCODE_PLACED (10008)
        # is the documented success code for a pending order that actually
        # registered as pending; TRADE_RETCODE_DONE/DONE_PARTIAL (10009/
        # 10010) are also accepted here (spec section 3: "if retcode ==
        # TRADE_RETCODE_DONE, inspect result.order/result.deal and
        # reconciliation evidence before deciding what actually happened") —
        # some brokers return DONE instead of PLACED when a STOP/LIMIT
        # order's trigger condition is already effectively met and it fills
        # immediately rather than registering as a waiting order. 0 is not a
        # defined retcode anywhere in the MT5 enum (it starts at 10004); it
        # is accepted ONLY because this specific broker/account has been
        # empirically observed returning literal 0 with comment="Done" on a
        # genuine placement. In every one of these cases retcode is still
        # never trusted alone: reconciliation below requires independent MT5
        # evidence (orders_get/positions_get/history) before ever reporting
        # success — this set only controls whether that reconciliation is
        # even attempted, versus an immediate, definite rejection.
        placed_retcode_ok = {
            0,
            getattr(mt5, "TRADE_RETCODE_PLACED", 10008),
            getattr(mt5, "TRADE_RETCODE_DONE", 10009),
            getattr(mt5, "TRADE_RETCODE_DONE_PARTIAL", 10010),
        }
        if send_retcode not in placed_retcode_ok:
            raise MT5DemoSafetyError(
                f"MT5 order_send rejected the pending order: "
                f"retcode={send_retcode} ({send_retcode_name}) comment={result.get('comment')}",
                diagnostics={
                    "request": request_diagnostics,
                    "order_check": check_diagnostics,
                    "order_send": send_diagnostics,
                    "timing_ms": timing_ms,
                },
            )
        if send_retcode == 0:
            logger.warning(
                "mt5 pending order_send returned the undocumented retcode 0 (not a real MT5 "
                "TRADE_RETCODE_* constant) for symbol=%s comment=%s — relying entirely on "
                "independent reconciliation evidence, never trusting this retcode alone",
                symbol,
                comment,
            )

        # Marks explicitly, for the router/Node/frontend, that this send_retcode
        # is this broker's own non-standard 0 (never a documented MT5 code) —
        # unlike a real TRADE_RETCODE_* value, there is no independent proof
        # anywhere (market-order tests only) that 0 ever means "placed" for a
        # PENDING order specifically. If reconciliation below still finds no
        # evidence, this flag is what lets the failure be reported as
        # genuinely indeterminate rather than "a real retcode was returned but
        # unconfirmed" (spec: never present retcode 0 as if it behaves like a
        # normal documented result).
        send_diagnostics["retcode_is_broker_nonstandard_zero"] = send_retcode == 0

        diagnostics = {
            "request": request_diagnostics,
            "order_check": check_diagnostics,
            "order_send": send_diagnostics,
            "timing_ms": timing_ms,
        }

        _t0 = time.perf_counter()
        order_ticket = result.get("order") or 0
        reconciliation: PendingOrderReconciliation | None = None
        if order_ticket:
            # Preferred path (spec section 2): a real ticket plus an
            # independent orders_get() confirmation of it. Fast — a single
            # orders_get() call, no sleep.
            ticket_order = self._confirm_pending_order_by_ticket(symbol, order_ticket)
            if ticket_order is not None:
                reconciliation = PendingOrderReconciliation(state="PENDING", order=ticket_order)

        if reconciliation is None:
            # Either order_send reported no ticket at all (result.order == 0,
            # observed on this broker/environment even on genuine success —
            # spec section 3), or it gave a ticket that never shows up.
            # Neither is immediately treated as failure: a SHORT, bounded,
            # synchronous reconciliation pass (spec: "<=300-500ms beyond
            # order_send()" — see _RECONCILE_DELAYS_SECONDS) across every MT5
            # source identifies the exact outcome, if any, before this ever
            # returns success or failure. If the broker genuinely needs more
            # real wall-clock time than this short pass allows, the caller
            # (Node) continues checking in a bounded, non-blocking background
            # pass instead of this call ever blocking longer or guessing.
            try:
                reconciliation = self._reconcile_pending_order(symbol, resolved, comment)
            except MT5DemoSafetyError as exc:
                timing_ms["initial_confirmation_ms"] = round((time.perf_counter() - _t0) * 1000, 1)
                exc.diagnostics = diagnostics
                raise
        timing_ms["initial_confirmation_ms"] = round((time.perf_counter() - _t0) * 1000, 1)
        logger.info(
            "mt5 pending order timing symbol=%s order_check_ms=%s order_send_ms=%s "
            "initial_confirmation_ms=%s",
            symbol,
            timing_ms.get("order_check_ms"),
            timing_ms.get("order_send_ms"),
            timing_ms.get("initial_confirmation_ms"),
        )

        result["checked_request"] = check
        result["resolved_type_filling"] = resolved.get("type_filling")
        result["executed_at"] = datetime.now(tz=UTC).isoformat()
        result["timing_ms"] = timing_ms
        result["execution_state"] = reconciliation.state
        result["confirmed_order"] = reconciliation.order
        result["confirmed_position"] = reconciliation.position
        result["confirmed_history_order"] = reconciliation.history_order
        result["confirmed_history_deal"] = reconciliation.history_deal
        # The confirmed MT5 object is the only source of truth for the ticket
        # returned to the caller — never the raw (possibly zero) order_send
        # value, even when order_ticket was already non-zero above. A
        # TRIGGERED_POSITION/FILLED_HISTORY outcome surfaces the POSITION
        # ticket here (there is no longer a pending order ticket to report).
        if reconciliation.order is not None:
            result["order"] = reconciliation.order.get("ticket")
        elif reconciliation.position is not None:
            result["order"] = reconciliation.position.get("ticket")
        elif reconciliation.history_order is not None:
            result["order"] = reconciliation.history_order.get("ticket")
        elif reconciliation.history_deal is not None:
            result["order"] = reconciliation.history_deal.get(
                "position_id"
            ) or reconciliation.history_deal.get("order")
        return result

    def cancel_pending_order(self, ticket: int) -> dict[str, Any]:
        """Cancels a real MT5 pending order (TRADE_ACTION_REMOVE). Confirms
        via orders_get() that the ticket is actually gone rather than
        trusting order_send()'s retcode alone."""
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")

        request = {"action": self.adapter.mt5.TRADE_ACTION_REMOVE, "order": int(ticket)}
        send_raw = self.adapter.order_send(request)
        if send_raw is None:
            raise MT5DemoSafetyError(
                f"MT5 order_send (cancel) returned no result (terminal error: {self._last_error()})"
            )
        result = _obj(send_raw)
        send_retcode = int(result.get("retcode", -1) if result.get("retcode") is not None else -1)
        ok_retcodes = {0, getattr(self.adapter.mt5, "TRADE_RETCODE_DONE", 10009)}
        if send_retcode not in ok_retcodes:
            send_comment = result.get("comment")
            raise MT5DemoSafetyError(
                f"MT5 order_send rejected the pending order cancellation: "
                f"retcode={send_retcode} comment={send_comment}"
            )

        for attempt in range(3):
            remaining = [_obj(o) for o in self.adapter.orders_get()]
            if not any(str(o.get("ticket") or "") == str(ticket) for o in remaining):
                result["executed_at"] = datetime.now(tz=UTC).isoformat()
                return result
            if attempt < 2:
                time.sleep(0.25)
        raise MT5ReconciliationError(
            f"MT5 order_send (cancel) reported success (retcode={send_retcode}) "
            f"but ticket {ticket} is still present via orders_get(); "
            "refusing to record it as cancelled"
        )

    def _verify_tradable_symbol(self, request: dict[str, Any]) -> None:
        from mt5.session_status import evaluate_symbol_session

        symbol = str(request.get("symbol") or "")
        stale_seconds = int(
            os.environ.get(
                "MT5_QUOTE_STALENESS_SECONDS",
                os.environ.get("MT5_QUOTE_STALE_SECONDS", "120"),
            )
        )
        status = evaluate_symbol_session(self.adapter, symbol, stale_seconds)
        if status.market_status != "OPEN":
            raise MT5DemoSafetyError(f"MT5 market is not open for {symbol}: {status.market_status}")
        if status.data_status != "LIVE":
            raise MT5DemoSafetyError(
                f"MT5 market data is not live for {symbol}: {status.data_status}"
            )
