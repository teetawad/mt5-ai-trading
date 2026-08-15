from __future__ import annotations

import time
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from auth import verify_internal_token
from mt5.adapter import DemoExecutionGateway, MT5Adapter, MT5DemoSafetyError, MT5UnavailableError
from mt5.strategy import analyze_completed_h1

router = APIRouter(prefix="/mt5", tags=["mt5"])
_adapter = MT5Adapter()
_gateway = DemoExecutionGateway(_adapter)


class MT5OrderRequest(BaseModel):
    idempotency_key: str
    symbol: str
    side: str
    volume: float
    stop_loss: float
    take_profit: float
    deviation: int = 20
    comment: str = "MT5_AI_DEMO_LAB"


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
    try:
        return _adapter.timeframe(value)
    except Exception as exc:
        raise HTTPException(status_code=422, detail="Unsupported timeframe") from exc


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


@router.get("/bars/{symbol}")
async def bars(
    symbol: str, timeframe: str = "H1", count: int = 200, _: None = Depends(verify_internal_token)
) -> list[dict[str, Any]]:
    if count < 1 or count > 5000:
        raise HTTPException(status_code=422, detail="count must be between 1 and 5000")
    try:
        _adapter.ensure_connected()
        _adapter.symbol_select(symbol, True)
        return _bar_dicts(_adapter.copy_rates_from_pos(symbol, _timeframe(timeframe), 1, count))
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.get("/positions")
async def positions(_: None = Depends(verify_internal_token)) -> list[dict[str, Any]]:
    try:
        _adapter.ensure_connected()
        return [_obj(pos) for pos in _adapter.positions_get()]
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/analyze/{symbol}")
async def analyze(symbol: str, _: None = Depends(verify_internal_token)) -> dict[str, Any]:
    try:
        _adapter.ensure_connected()
        _adapter.symbol_select(symbol, True)
        info = _obj(_adapter.symbol_info(symbol))
        tick = _obj(_adapter.symbol_info_tick(symbol))
        point = Decimal(str(info.get("point") or "0.00001"))
        h1 = _bar_dicts(_adapter.copy_rates_from_pos(symbol, _adapter.timeframe("H1"), 1, 220))
        decision = analyze_completed_h1(symbol, h1, tick, point)
        return decision.__dict__
    except MT5UnavailableError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@router.post("/order-check")
async def order_check(
    request: MT5OrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    return _gateway.order_check(_order_request(request))


@router.post("/orders")
async def submit_demo_order(
    request: MT5OrderRequest, _: None = Depends(verify_internal_token)
) -> dict[str, Any]:
    try:
        return _gateway.execute_market_order(_order_request(request))
    except MT5DemoSafetyError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc


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
        "type_filling": _adapter.mt5.ORDER_FILLING_IOC,
    }
