from __future__ import annotations

import logging
import os
import time
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import verify_internal_token
from mt5.adapter import (
    DemoExecutionGateway,
    MT5Adapter,
    MT5DemoSafetyError,
    MT5OrderSendReturnedNoneError,
    MT5PendingOrderCancelledError,
    MT5PendingOrderConfirmationAmbiguousError,
    MT5PendingOrderNotConfirmedError,
    MT5UnavailableError,
)
from mt5.chart import render_candlestick_chart
from mt5.session_status import evaluate_symbol_session
from mt5.strategy import analyze_completed_h1
from mt5.timeframes import UnsupportedTimeframeError

router = APIRouter(prefix="/mt5", tags=["mt5"])
_adapter = MT5Adapter()
_gateway = DemoExecutionGateway(_adapter)
logger = logging.getLogger("mt5.router")


class MT5OrderRequest(BaseModel):
    idempotency_key: str
    symbol: str
    side: str
    volume: float
    stop_loss: float
    take_profit: float
    deviation: int = 20
    comment: str = "MT5_AI_DEMO_LAB"


PENDING_ORDER_TYPES = {"BUY_LIMIT", "SELL_LIMIT", "BUY_STOP", "SELL_STOP"}


class MT5PendingOrderRequest(BaseModel):
    idempotency_key: str
    symbol: str
    order_type: str
    price: float
    volume: float
    stop_loss: float
    take_profit: float
    expiration: str | None = None
    comment: str = "AI_TRADE_V3"


class MT5CancelPendingOrderRequest(BaseModel):
    ticket: int


def _quote_stale_seconds() -> int:
    try:
        return int(
            os.environ.get(
                "MT5_QUOTE_STALENESS_SECONDS",
                os.environ.get("MT5_QUOTE_STALE_SECONDS", "120"),
            )
        )
    except ValueError:
        return 120


def _obj(value: Any) -> dict[str, Any]:
    if value is None:
        return {}
    if hasattr(value, "_asdict"):
        return dict(value._asdict())
    if hasattr(value, "__dict__"):
        return dict(value.__dict__)
    return {"value": value}


def _bar_dicts(raw: Any) -> list[dict[str, Any]]:
    if raw is None:
        return []
    rows: list[dict[str, Any]] = []
    for row in raw:
        if hasattr(row, "dtype") and getattr(row, "dtype", None) is not None:
            rows.append(
                {
                    name: row[name].item() if hasattr(row[name], "item") else row[name]
                    for name in row.dtype.names
                }
            )
        elif isinstance(row, dict):
            rows.append(row)
        else:
            rows.append(_obj(row))
    return rows


def _timeframe(value: str) -> int:
    """Resolves a timeframe string to the real MT5 constant, or raises a 422
    that names the ACTUAL offending value (e.g. "Unsupported timeframe:
    'M5'. Supported: M1, M5, M15, M30, H1, H4, D1") instead of a bare,
    unhelpful "Unsupported timeframe"."""
    try:
        return _adapter.timeframe(value)
    except UnsupportedTimeframeError as exc:
        raise HTTPException(
            status_code=422,
            detail={"error": "UNSUPPORTED_TIMEFRAME", "message": str(exc)},
        ) from exc


def _mt5_last_error() -> str:
    """Best-effort mt5.last_error() for server-side diagnostics only. Never
    contains credentials/secrets — MT5's own error tuples are just
    (code, description) — but is deliberately kept out of client-facing
    detail strings to avoid leaking terminal-internal detail unnecessarily."""
    try:
        return str(_adapter.mt5.last_error())
    except Exception:  # pragma: no cover - defensive only
        return "unavailable"


def _select_symbol_or_404(symbol: str) -> None:
    selected = _adapter.symbol_select(symbol, True)
    if not selected:
        logger.warning("symbol_select failed for %s (last_error=%s)", symbol, _mt5_last_error())
        raise HTTPException(
            status_code=404,
            detail={
                "error": "SYMBOL_NOT_FOUND",
                "message": f"MT5 does not recognize symbol {symbol}",
            },
        )


def _copy_rates_or_502(symbol: str, timeframe_const: int, count: int) -> Any:
    try:
        return _adapter.copy_rates_from_pos(symbol, timeframe_const, 1, count)
    except Exception as exc:
        last_error = _mt5_last_error()
        logger.error(
            "copy_rates_from_pos failed for %s (last_error=%s): %s", symbol, last_error, exc
        )
        raise HTTPException(
            status_code=502,
            detail={
                "error": "MT5_COPY_RATES_FAILED",
                "message": f"MT5 copy_rates_from_pos failed for {symbol}",
            },
        ) from exc


@router.get("/status")
async def status(_: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        guard = _gateway.verify_demo_environment()
        return {
            "connected": guard.account is not None,
            "demo_verified": guard.ok,
            "blocked_reason": guard.reason,
            **guard.to_dict(),
        }
    except MT5UnavailableError as exc:
        return {
            "connected": False,
            "demo_verified": False,
            "blocked_reason": str(exc),
            "account": None,
            "terminal": None,
        }


@router.get("/symbols")
async def symbols(_: None = Depends(verify_internal_token)) -> list[dict[str, Any]]:
    try:
        _adapter.ensure_connected()
        return [_obj(symbol) for symbol in _adapter.symbols_get()]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/tick/{symbol}")
async def tick(symbol: str, _: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        _adapter.ensure_connected()
        _adapter.symbol_select(symbol, True)
        data = _obj(_adapter.symbol_info_tick(symbol))
        if not data:
            raise HTTPException(status_code=404, detail="Symbol tick unavailable")
        data["symbol"] = symbol
        data["timestamp"] = datetime.fromtimestamp(
            int(data.get("time", time.time())), tz=UTC
        ).isoformat()
        return data
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/market-status/{symbol}")
async def market_status(symbol: str, _: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        return evaluate_symbol_session(_adapter, symbol, _quote_stale_seconds()).to_dict()
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/bars/{symbol}")
async def bars(
    symbol: str, timeframe: str = "H1", count: int = 200, _: None = Depends(verify_internal_token)
) -> list[dict[str, Any]]:
    if count < 1 or count > 5000:
        raise HTTPException(status_code=422, detail="count must be between 1 and 5000")
    try:
        _adapter.ensure_connected()
    except MT5UnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "MT5_NOT_CONNECTED", "message": str(exc)},
        ) from exc
    timeframe_const = _timeframe(timeframe)
    _select_symbol_or_404(symbol)
    raw = _copy_rates_or_502(symbol, timeframe_const, count)
    bar_rows = _bar_dicts(raw)
    if not bar_rows:
        # Not a hard failure — a valid, connected symbol can legitimately have
        # no bars yet for a given timeframe/range (e.g. a newly listed
        # symbol). Logged with mt5.last_error() for diagnosability; callers
        # (e.g. MarketAnalysisPackage) already tolerate an empty bar list for
        # one timeframe without failing the whole request.
        logger.warning(
            "copy_rates_from_pos returned no bars for %s %s (last_error=%s)",
            symbol,
            timeframe,
            _mt5_last_error(),
        )
    return bar_rows


@router.get("/chart/{symbol}")
async def chart(
    symbol: str, timeframe: str = "H1", count: int = 120, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    if count < 20 or count > 500:
        raise HTTPException(status_code=422, detail="count must be between 20 and 500")
    try:
        _adapter.ensure_connected()
    except MT5UnavailableError as exc:
        raise HTTPException(
            status_code=503,
            detail={"error": "MT5_NOT_CONNECTED", "message": str(exc)},
        ) from exc
    timeframe_const = _timeframe(timeframe)
    _select_symbol_or_404(symbol)
    raw = _copy_rates_or_502(symbol, timeframe_const, count)
    bars = _bar_dicts(raw)
    if not bars:
        logger.warning(
            "copy_rates_from_pos returned no bars for chart %s %s (last_error=%s)",
            symbol,
            timeframe,
            _mt5_last_error(),
        )
        raise HTTPException(
            status_code=404,
            detail={
                "error": "NO_CANDLE_DATA",
                "message": f"No candle data available to render a chart for {symbol} {timeframe}",
            },
        )
    try:
        tick = _obj(_adapter.symbol_info_tick(symbol))
        current_price = None
        if tick.get("bid") and tick.get("ask"):
            current_price = (float(tick["bid"]) + float(tick["ask"])) / 2
        image_base64 = render_candlestick_chart(symbol, timeframe, bars, current_price)
        return {
            "symbol": symbol,
            "timeframe": timeframe,
            "bar_count": len(bars),
            "media_type": "image/png",
            "image_base64": image_base64,
        }
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.get("/positions")
async def positions(_: None = Depends(verify_internal_token)) -> list[dict[str, Any]]:
    try:
        _adapter.ensure_connected()
        return [_obj(pos) for pos in _adapter.positions_get()]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/orders")
async def pending_orders(_: None = Depends(verify_internal_token)) -> list[dict[str, Any]]:
    try:
        _adapter.ensure_connected()
        return [_obj(order) for order in _adapter.orders_get()]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/symbol-info/{symbol}")
async def symbol_info(symbol: str, _: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        _adapter.ensure_connected()
        _adapter.symbol_select(symbol, True)
        info = _obj(_adapter.symbol_info(symbol))
        if not info:
            raise HTTPException(status_code=404, detail="Symbol info unavailable")
        return info
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/analyze/{symbol}")
async def analyze(symbol: str, _: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        _adapter.ensure_connected()
        _adapter.symbol_select(symbol, True)
        info = _obj(_adapter.symbol_info(symbol))
        tick = _obj(_adapter.symbol_info_tick(symbol))
        market = evaluate_symbol_session(_adapter, symbol, _quote_stale_seconds()).to_dict()
        point = Decimal(str(info.get("point") or "0.00001"))
        h1 = _bar_dicts(_adapter.copy_rates_from_pos(symbol, _adapter.timeframe("H1"), 1, 220))
        decision = analyze_completed_h1(symbol, h1, tick, point)
        data = decision.__dict__
        data["market"] = market
        data["market_status"] = market["market_status"]
        data["data_status"] = market["data_status"]
        data["session_open"] = market["session_open"]
        data["session_close"] = market["session_close"]
        data["next_session_open"] = market["next_session_open"]
        data["server_time"] = market["server_time"]
        data["local_time"] = market["local_time"]
        data["quote_age_seconds"] = market["quote_age_seconds"]
        data["source"] = market["source"]
        if market["market_status"] != "OPEN" or market["data_status"] != "LIVE":
            reasons = list(data.get("reasons") or [])
            if market["market_status"] != "OPEN":
                reasons.append(f"NO_TRADE: broker market status is {market['market_status']}")
            if market["data_status"] != "LIVE":
                reasons.append(f"NO_TRADE: market data status is {market['data_status']}")
            if market.get("reason"):
                reasons.append(str(market["reason"]))
            data["decision"] = "NO_TRADE"
            data["confidence"] = 0
            data["opportunity_score"] = 0
            data["entry_strategy"] = "NO_ENTRY"
            data["entry_zone_low"] = None
            data["entry_zone_high"] = None
            data["trigger_price"] = None
            data["entry_reason"] = "No entry because broker market or data status is not tradable."
            data["current_entry_status"] = "BLOCKED"
            data["stop_loss"] = None
            data["take_profit"] = None
            data["risk_reward"] = None
            data["reasons"] = reasons
        return data
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/order-check")
async def order_check(
    request: MT5OrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.order_check(_order_request(request))
    except MT5DemoSafetyError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


@router.post("/orders")
async def submit_demo_order(
    request: MT5OrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.execute_market_order(_order_request(request))
    except MT5DemoSafetyError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


def _pending_order_error(exc: MT5DemoSafetyError) -> HTTPException:
    """Maps the pending-order exception hierarchy to distinct, diagnosable
    HTTP responses — never a single generic 403 for every failure mode
    (spec section 5/7: differentiate rejection from not-yet-confirmed from
    genuinely ambiguous). Every response carries `diagnostics` (spec
    section 1) — the safe request/order_check/order_send/last_error subset
    the gateway attached to the exception — so the caller (and the DB row it
    persists) always has the exact MqlTradeResult, never just free text."""
    diagnostics = getattr(exc, "diagnostics", None)
    if isinstance(exc, MT5OrderSendReturnedNoneError):
        # No MqlTradeResult ever came back from the trade server (spec
        # section 2/5/11) — this is an infrastructure/IPC failure, never a
        # trade-server rejection, so it gets its own distinct code/status
        # (503, not 403/409) rather than being folded into the generic
        # PENDING_ORDER_REJECTED branch below, which would let the frontend
        # mistakenly display order_check's retcode as if it were the
        # (nonexistent) order_send result.
        return HTTPException(
            status_code=503,
            detail={
                "error": "MT5_ORDER_SEND_RETURNED_NONE",
                "message": str(exc),
                "diagnostics": diagnostics,
            },
        )
    if isinstance(exc, MT5PendingOrderConfirmationAmbiguousError):
        return HTTPException(
            status_code=409,
            detail={
                "error": "PENDING_ORDER_CONFIRMATION_AMBIGUOUS",
                "message": str(exc),
                "diagnostics": diagnostics,
            },
        )
    if isinstance(exc, MT5PendingOrderCancelledError):
        # A definite, distinct terminal outcome (history proved the broker
        # itself cancelled/rejected/expired it) — never the same code as
        # "we genuinely found no evidence anywhere" (PENDING_ORDER_NOT_CONFIRMED),
        # since the caller must never blindly retry order_send for this case
        # (spec section 8) but MUST record it as a real cancellation, not an
        # unresolved failure.
        return HTTPException(
            status_code=409,
            detail={
                "error": "PENDING_ORDER_CANCELLED",
                "message": str(exc),
                "diagnostics": diagnostics,
            },
        )
    if isinstance(exc, MT5PendingOrderNotConfirmedError):
        return HTTPException(
            status_code=409,
            detail={
                "error": "PENDING_ORDER_NOT_CONFIRMED",
                "message": str(exc),
                "diagnostics": diagnostics,
            },
        )
    return HTTPException(
        status_code=403,
        detail={"error": "PENDING_ORDER_REJECTED", "message": str(exc), "diagnostics": diagnostics},
    )


@router.post("/pending-order-check")
async def pending_order_check(
    request: MT5PendingOrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.order_check(_pending_order_request(request))
    except MT5DemoSafetyError as exc:
        raise _pending_order_error(exc) from exc


@router.post("/pending-orders")
async def submit_pending_order(
    request: MT5PendingOrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.execute_pending_order(_pending_order_request(request))
    except MT5DemoSafetyError as exc:
        raise _pending_order_error(exc) from exc


@router.delete("/pending-orders/{ticket}")
async def cancel_pending_order(
    ticket: int, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.cancel_pending_order(ticket)
    except MT5DemoSafetyError as exc:
        raise _pending_order_error(exc) from exc


def _pending_order_request(request: MT5PendingOrderRequest) -> dict[str, Any]:
    order_type = request.order_type.upper()
    if order_type not in PENDING_ORDER_TYPES:
        raise HTTPException(
            status_code=422,
            detail="order_type must be one of BUY_LIMIT, SELL_LIMIT, BUY_STOP, SELL_STOP",
        )
    mt5 = _adapter.mt5
    type_map = {
        "BUY_LIMIT": mt5.ORDER_TYPE_BUY_LIMIT,
        "SELL_LIMIT": mt5.ORDER_TYPE_SELL_LIMIT,
        "BUY_STOP": mt5.ORDER_TYPE_BUY_STOP,
        "SELL_STOP": mt5.ORDER_TYPE_SELL_STOP,
    }
    payload: dict[str, Any] = {
        "action": mt5.TRADE_ACTION_PENDING,
        "symbol": request.symbol,
        "volume": request.volume,
        "type": type_map[order_type],
        "price": request.price,
        "sl": request.stop_loss,
        "tp": request.take_profit,
        "magic": 27002,
        "comment": request.comment,
    }
    if request.expiration:
        try:
            expiry = datetime.fromisoformat(request.expiration.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(
                status_code=422, detail="expiration must be an ISO-8601 timestamp"
            ) from exc
        payload["type_time"] = mt5.ORDER_TIME_SPECIFIED
        payload["expiration"] = int(expiry.timestamp())
    else:
        payload["type_time"] = mt5.ORDER_TIME_GTC
    return payload


def _order_request(request: MT5OrderRequest) -> dict[str, Any]:
    side = request.side.upper()
    if side not in {"BUY", "SELL"}:
        raise HTTPException(status_code=422, detail="side must be BUY or SELL")
    tick = _obj(_adapter.symbol_info_tick(request.symbol))
    price = float(tick.get("ask") if side == "BUY" else tick.get("bid"))
    order_type = _adapter.mt5.ORDER_TYPE_BUY if side == "BUY" else _adapter.mt5.ORDER_TYPE_SELL
    return {
        "action": _adapter.mt5.TRADE_ACTION_DEAL,
        "symbol": request.symbol,
        "volume": request.volume,
        "type": order_type,
        "price": price,
        "sl": request.stop_loss,
        "tp": request.take_profit,
        "deviation": request.deviation,
        "magic": 27001,
        "comment": request.comment,
        "type_time": _adapter.mt5.ORDER_TIME_GTC,
        # type_filling is intentionally omitted: DemoExecutionGateway resolves
        # the broker/symbol-supported filling mode itself before every
        # order_check/order_send call. Hardcoding one here previously caused
        # silent order_check/order_send failures on brokers that don't
        # support it.
    }


@router.get("/history-deals")
async def history_deals(
    symbol: str | None = None,
    hours: int = 168,
    _: None = Depends(verify_internal_token),
) -> list[dict[str, Any]]:
    if hours < 1 or hours > 24 * 90:
        raise HTTPException(status_code=422, detail="hours must be between 1 and 2160")
    try:
        _adapter.ensure_connected()
        now = datetime.now(tz=UTC)
        # history_deals_get() filters strictly by each deal's broker-server-
        # clock timestamp. This broker's server clock runs hours ahead of
        # this process's real UTC clock (confirmed against the live DEMO
        # terminal: quote/deal timestamps ~3h ahead of datetime.now(UTC)) —
        # a common MT5 quirk since the terminal reports server time, not the
        # client machine's time. Using date_to=now(UTC) silently excluded
        # deals for positions that had just closed, which was the actual
        # root cause of genuinely-closed trades being reconciled as
        # RECONCILIATION_FAILED. A generous forward buffer on date_to alone
        # (date_from stays anchored to real "now - hours", so the requested
        # lookback depth is unchanged) costs nothing — history_deals_get
        # simply returns no rows for a window that hasn't happened yet.
        date_to = now + timedelta(hours=12)
        date_from = now - timedelta(hours=hours)
        kwargs = {"group": symbol} if symbol else {}
        deals = _adapter.history_deals_get(date_from, date_to, **kwargs)
        return [_obj(deal) for deal in deals]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/history-orders")
async def history_orders(
    symbol: str | None = None,
    hours: int = 168,
    _: None = Depends(verify_internal_token),
) -> list[dict[str, Any]]:
    """Order HISTORY (spec section 1C) — distinct from /orders (only
    currently-active pending orders): proves a pending order that no longer
    shows up via orders_get() was actually FILLED, CANCELED, REJECTED, or
    EXPIRED, instead of leaving that outcome unknowable from this app's
    perspective. Same broker-server-clock forward-buffer quirk as
    /history-deals — see the comment there."""
    if hours < 1 or hours > 24 * 90:
        raise HTTPException(status_code=422, detail="hours must be between 1 and 2160")
    try:
        _adapter.ensure_connected()
        now = datetime.now(tz=UTC)
        date_to = now + timedelta(hours=12)
        date_from = now - timedelta(hours=hours)
        kwargs = {"group": symbol} if symbol else {}
        orders = _adapter.history_orders_get(date_from, date_to, **kwargs)
        return [_obj(order) for order in orders]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
