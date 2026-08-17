from __future__ import annotations

import os
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any


class MT5UnavailableError(RuntimeError):
    pass


class MT5DemoSafetyError(RuntimeError):
    pass


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
        mapping = {
            "M1": self.mt5.TIMEFRAME_M1,
            "1M": self.mt5.TIMEFRAME_M1,
            "M15": self.mt5.TIMEFRAME_M15,
            "15M": self.mt5.TIMEFRAME_M15,
            "H1": self.mt5.TIMEFRAME_H1,
            "1H": self.mt5.TIMEFRAME_H1,
            "H4": self.mt5.TIMEFRAME_H4,
            "4H": self.mt5.TIMEFRAME_H4,
        }
        return mapping[value.upper()]


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

    def order_check(self, request: dict[str, Any]) -> dict[str, Any]:
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")
        self._verify_tradable_symbol(request)
        return _obj(self.adapter.order_check(request))

    def execute_market_order(self, request: dict[str, Any]) -> dict[str, Any]:
        guard = self.verify_demo_environment()
        if not guard.ok:
            raise MT5DemoSafetyError(guard.reason or "MT5 demo guard failed")
        self._verify_tradable_symbol(request)
        check = _obj(self.adapter.order_check(request))
        retcode = int(check.get("retcode", 0) or 0)
        ok_retcode = getattr(self.adapter.mt5, "TRADE_RETCODE_DONE", 10009)
        placed_retcode = getattr(self.adapter.mt5, "TRADE_RETCODE_PLACED", 10008)
        if retcode not in {ok_retcode, placed_retcode, 0}:
            raise MT5DemoSafetyError(f"MT5 order_check rejected request: {check}")
        result = _obj(self.adapter.order_send(request))
        result["checked_request"] = check
        result["executed_at"] = datetime.now(tz=UTC).isoformat()
        return result

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
            raise MT5DemoSafetyError(
                f"MT5 market is not open for {symbol}: {status.market_status}"
            )
        if status.data_status != "LIVE":
            raise MT5DemoSafetyError(
                f"MT5 market data is not live for {symbol}: {status.data_status}"
            )
