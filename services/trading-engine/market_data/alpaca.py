"""Alpaca US stock market data provider.

This module only reads market data. It does not place orders and has no live
trading capability.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from collections.abc import Callable
from datetime import UTC, datetime
from decimal import Decimal
from types import TracebackType
from typing import Any, Self

import httpx
import websockets

from .provider import (
    MarketDataProvider,
    MarketDataProviderError,
    MarketDataRateLimitError,
    SymbolNotFoundError,
)
from .snapshot import MarketBar, MarketQuote, MarketSnapshot, MarketTrade

LOGGER = logging.getLogger(__name__)

DEFAULT_REST_URL = "https://data.alpaca.markets"
DEFAULT_STREAM_URL = "wss://stream.data.alpaca.markets"
DEFAULT_FEED = "iex"
DEFAULT_SYMBOLS = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "TSLA", "NVDA", "SPY", "QQQ"]


def _parse_time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=UTC)
    return parsed.astimezone(UTC)


def _decimal(value: Any) -> Decimal:
    return Decimal(str(value))


def _is_stale(timestamp: datetime, threshold_seconds: int) -> bool:
    return (datetime.now(UTC) - timestamp).total_seconds() > threshold_seconds


class AlpacaMarketDataProvider(MarketDataProvider):
    def __init__(
        self,
        *,
        key_id: str,
        secret_key: str,
        symbols: list[str] | None = None,
        feed: str = DEFAULT_FEED,
        base_url: str = DEFAULT_REST_URL,
        staleness_threshold_seconds: int = 60,
        timeout_seconds: float = 10.0,
        client: httpx.Client | None = None,
    ) -> None:
        if not key_id or not secret_key:
            raise ValueError("Alpaca API credentials are required")

        self._key_id = key_id
        self._secret_key = secret_key
        self._symbols = [symbol.upper() for symbol in (symbols or DEFAULT_SYMBOLS)]
        self._feed = feed
        self._base_url = base_url.rstrip("/")
        self._staleness_threshold = staleness_threshold_seconds
        self._client = client or httpx.Client(timeout=timeout_seconds)
        self._owns_client = client is None
        self._stream: AlpacaMarketDataStream | None = None

    @classmethod
    def from_env(cls) -> AlpacaMarketDataProvider:
        key_id = os.environ.get("ALPACA_API_KEY_ID") or os.environ.get("APCA_API_KEY_ID", "")
        secret_key = os.environ.get("ALPACA_API_SECRET_KEY") or os.environ.get(
            "APCA_API_SECRET_KEY", ""
        )
        configured_symbols = os.environ.get("MARKET_DATA_SYMBOLS", ",".join(DEFAULT_SYMBOLS))
        symbols = [
            symbol.strip().upper()
            for symbol in configured_symbols.split(",")
            if symbol.strip()
        ]
        return cls(
            key_id=key_id,
            secret_key=secret_key,
            symbols=symbols,
            feed=os.environ.get("ALPACA_DATA_FEED", DEFAULT_FEED),
            base_url=os.environ.get("ALPACA_DATA_BASE_URL", DEFAULT_REST_URL),
            staleness_threshold_seconds=int(
                os.environ.get("MARKET_DATA_STALENESS_SECONDS", "60")
            ),
        )

    def close(self) -> None:
        if self._owns_client:
            self._client.close()

    def __enter__(self) -> Self:
        return self

    def __exit__(
        self,
        _exc_type: type[BaseException] | None,
        _exc: BaseException | None,
        _traceback: TracebackType | None,
    ) -> None:
        self.close()

    def attach_stream(self, stream: AlpacaMarketDataStream) -> None:
        """Wire the WebSocket stream as the preferred price source.

        Once attached, get_snapshot/get_all_snapshots prefer the stream's
        cached trade/quote over a REST call whenever the stream is connected
        and has a fresh-enough entry for the symbol. This is the only
        market-data connection this provider ever opens — REST remains the
        fallback for symbols the stream hasn't (yet) delivered a message for,
        which also covers the post-reconnect case: a freshly reconnected
        stream has an empty cache, so callers transparently fall back to REST
        until the stream repopulates, instead of serving stale cached data.
        """
        self._stream = stream

    def connection_status(self) -> dict[str, object]:
        if self._stream is None:
            return {"mode": "poll", "connected": True, "last_message_at": None}
        last_message_at = self._stream.last_message_at()
        return {
            "mode": "stream",
            "connected": self._stream.connected,
            "last_message_at": last_message_at.isoformat() if last_message_at else None,
        }

    def _snapshot_from_stream(self, symbol: str) -> MarketSnapshot | None:
        if self._stream is None or not self._stream.connected:
            return None
        trade = self._stream.latest_trade(symbol)
        if trade is None or _is_stale(trade.timestamp, self._staleness_threshold):
            return None
        quote = self._stream.latest_quote(symbol)
        bid = quote.bid if quote is not None else trade.price
        ask = quote.ask if quote is not None else trade.price
        return MarketSnapshot(
            symbol=symbol,
            price=trade.price,
            bid=bid,
            ask=ask,
            volume=trade.size,
            timestamp=trade.timestamp,
            is_stale=False,
        )

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        symbol = symbol.upper()
        streamed = self._snapshot_from_stream(symbol)
        if streamed is not None:
            return streamed

        data = self._request("GET", f"/v2/stocks/{symbol.upper()}/snapshot")
        snapshot = data.get("snapshot") if isinstance(data.get("snapshot"), dict) else data
        if not isinstance(snapshot, dict):
            raise SymbolNotFoundError(f"Symbol not found: {symbol}")

        trade = snapshot.get("latestTrade") or {}
        quote = snapshot.get("latestQuote") or {}
        minute_bar = snapshot.get("minuteBar") or {}
        if not isinstance(trade, dict) or not isinstance(quote, dict):
            raise MarketDataProviderError(f"Malformed Alpaca snapshot for {symbol}")

        timestamp_value = trade.get("t") or quote.get("t") or minute_bar.get("t")
        if not isinstance(timestamp_value, str):
            raise MarketDataProviderError(f"Alpaca snapshot missing timestamp for {symbol}")
        timestamp = _parse_time(timestamp_value)

        price_value = trade.get("p") or minute_bar.get("c")
        bid_value = quote.get("bp") or price_value
        ask_value = quote.get("ap") or price_value
        if price_value is None or bid_value is None or ask_value is None:
            raise MarketDataProviderError(f"Alpaca snapshot missing prices for {symbol}")

        return MarketSnapshot(
            symbol=symbol.upper(),
            price=_decimal(price_value),
            bid=_decimal(bid_value),
            ask=_decimal(ask_value),
            volume=int(minute_bar.get("v") or trade.get("s") or 0),
            timestamp=timestamp,
            is_stale=_is_stale(timestamp, self._staleness_threshold),
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self.get_snapshot(symbol) for symbol in self._symbols]

    def tracked_symbols(self) -> list[str]:
        return list(self._symbols)

    def get_historical_bars(
        self,
        symbol: str,
        *,
        timeframe: str,
        start: str,
        end: str | None = None,
        limit: int = 100,
    ) -> list[MarketBar]:
        params: dict[str, str | int] = {
            "timeframe": timeframe,
            "start": start,
            "limit": limit,
            "feed": self._feed,
        }
        if end is not None:
            params["end"] = end
        data = self._request("GET", f"/v2/stocks/{symbol.upper()}/bars", params=params)
        bars = data.get("bars")
        if not isinstance(bars, list):
            raise SymbolNotFoundError(f"Symbol not found: {symbol}")
        return [self._map_bar(symbol.upper(), bar) for bar in bars if isinstance(bar, dict)]

    def get_latest_quote(self, symbol: str) -> MarketQuote:
        data = self._request("GET", f"/v2/stocks/{symbol.upper()}/quotes/latest")
        quote = data.get("quote")
        if not isinstance(quote, dict):
            raise SymbolNotFoundError(f"Symbol not found: {symbol}")
        return self._map_quote(symbol.upper(), quote)

    def get_latest_trade(self, symbol: str) -> MarketTrade:
        data = self._request("GET", f"/v2/stocks/{symbol.upper()}/trades/latest")
        trade = data.get("trade")
        if not isinstance(trade, dict):
            raise SymbolNotFoundError(f"Symbol not found: {symbol}")
        return self._map_trade(symbol.upper(), trade)

    def create_stream(self) -> AlpacaMarketDataStream:
        return AlpacaMarketDataStream(
            key_id=self._key_id,
            secret_key=self._secret_key,
            feed=self._feed,
            stream_url=os.environ.get("ALPACA_STREAM_URL", DEFAULT_STREAM_URL),
        )

    def _request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, str | int] | None = None,
    ) -> dict[str, Any]:
        request_params: dict[str, str | int] = {"feed": self._feed}
        if params:
            request_params.update(params)
        response = self._client.request(
            method,
            f"{self._base_url}{path}",
            params=request_params,
            headers={
                "APCA-API-KEY-ID": self._key_id,
                "APCA-API-SECRET-KEY": self._secret_key,
            },
        )
        if response.status_code == 404:
            raise SymbolNotFoundError(path)
        if response.status_code == 429:
            retry_after = response.headers.get("Retry-After")
            raise MarketDataRateLimitError(
                "Alpaca market data rate limit exceeded",
                float(retry_after) if retry_after else None,
            )
        if response.status_code >= 500:
            raise MarketDataProviderError(f"Alpaca market data error: {response.status_code}")
        if response.status_code >= 400:
            raise MarketDataProviderError(
                f"Alpaca market data rejected request: {response.status_code}"
            )
        parsed = response.json()
        if not isinstance(parsed, dict):
            raise MarketDataProviderError("Malformed Alpaca market data response")
        return parsed

    def _map_bar(self, symbol: str, bar: dict[str, Any]) -> MarketBar:
        return MarketBar(
            symbol=symbol,
            open=_decimal(bar["o"]),
            high=_decimal(bar["h"]),
            low=_decimal(bar["l"]),
            close=_decimal(bar["c"]),
            volume=int(bar.get("v") or 0),
            timestamp=_parse_time(str(bar["t"])),
            trade_count=int(bar["n"]) if bar.get("n") is not None else None,
            vwap=_decimal(bar["vw"]) if bar.get("vw") is not None else None,
        )

    def _map_quote(self, symbol: str, quote: dict[str, Any]) -> MarketQuote:
        timestamp = _parse_time(str(quote["t"]))
        return MarketQuote(
            symbol=symbol,
            bid=_decimal(quote["bp"]),
            ask=_decimal(quote["ap"]),
            bid_size=int(quote.get("bs") or 0),
            ask_size=int(quote.get("as") or 0),
            timestamp=timestamp,
            is_stale=_is_stale(timestamp, self._staleness_threshold),
        )

    def _map_trade(self, symbol: str, trade: dict[str, Any]) -> MarketTrade:
        timestamp = _parse_time(str(trade["t"]))
        return MarketTrade(
            symbol=symbol,
            price=_decimal(trade["p"]),
            size=int(trade.get("s") or 0),
            timestamp=timestamp,
            exchange=str(trade["x"]) if trade.get("x") is not None else None,
            trade_id=trade.get("i"),
            is_stale=_is_stale(timestamp, self._staleness_threshold),
        )


class AlpacaMarketDataStream:
    def __init__(
        self,
        *,
        key_id: str,
        secret_key: str,
        feed: str = DEFAULT_FEED,
        stream_url: str = DEFAULT_STREAM_URL,
        reconnect_initial_seconds: float = 1.0,
        reconnect_max_seconds: float = 30.0,
        websocket_factory: Callable[..., Any] | None = None,
    ) -> None:
        self._key_id = key_id
        self._secret_key = secret_key
        self._feed = feed
        self._stream_url = stream_url.rstrip("/")
        self._reconnect_initial = reconnect_initial_seconds
        self._reconnect_max = reconnect_max_seconds
        self._websocket_factory = websocket_factory or websockets.connect
        self._lock = threading.Lock()
        self._quotes: dict[str, MarketQuote] = {}
        self._trades: dict[str, MarketTrade] = {}
        self._bars: dict[str, MarketBar] = {}
        self._last_message_at: datetime | None = None
        self.last_error: str | None = None
        self.connected = False

    @classmethod
    def from_env(cls) -> AlpacaMarketDataStream:
        key_id = os.environ.get("ALPACA_API_KEY_ID") or os.environ.get("APCA_API_KEY_ID", "")
        secret_key = os.environ.get("ALPACA_API_SECRET_KEY") or os.environ.get(
            "APCA_API_SECRET_KEY", ""
        )
        if not key_id or not secret_key:
            raise ValueError("Alpaca API credentials are required")
        return cls(
            key_id=key_id,
            secret_key=secret_key,
            feed=os.environ.get("ALPACA_DATA_FEED", DEFAULT_FEED),
            stream_url=os.environ.get("ALPACA_STREAM_URL", DEFAULT_STREAM_URL),
        )

    @property
    def url(self) -> str:
        return f"{self._stream_url}/v2/{self._feed}"

    def latest_quote(self, symbol: str) -> MarketQuote | None:
        with self._lock:
            return self._quotes.get(symbol.upper())

    def latest_trade(self, symbol: str) -> MarketTrade | None:
        with self._lock:
            return self._trades.get(symbol.upper())

    def latest_bar(self, symbol: str) -> MarketBar | None:
        with self._lock:
            return self._bars.get(symbol.upper())

    def last_message_at(self) -> datetime | None:
        with self._lock:
            return self._last_message_at

    async def run_forever(
        self,
        *,
        symbols: list[str],
        stop_event: asyncio.Event,
    ) -> None:
        backoff = self._reconnect_initial
        while not stop_event.is_set():
            try:
                await self._connect_once(
                    symbols=[symbol.upper() for symbol in symbols],
                    stop_event=stop_event,
                )
                backoff = self._reconnect_initial
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                self.connected = False
                self.last_error = str(exc)
                LOGGER.warning("Alpaca stream disconnected: %s", exc)
                try:
                    await asyncio.wait_for(stop_event.wait(), timeout=backoff)
                except TimeoutError:
                    pass
                backoff = min(backoff * 2, self._reconnect_max)

    async def _connect_once(self, *, symbols: list[str], stop_event: asyncio.Event) -> None:
        async with self._websocket_factory(self.url) as websocket:
            self.connected = True
            await self._send_json(
                websocket,
                {"action": "auth", "key": self._key_id, "secret": self._secret_key},
            )
            await self._send_json(
                websocket,
                {
                    "action": "subscribe",
                    "trades": symbols,
                    "quotes": symbols,
                    "bars": symbols,
                },
            )
            while not stop_event.is_set():
                raw = await asyncio.wait_for(websocket.recv(), timeout=5.0)
                self._handle_message(raw)

    async def _send_json(self, websocket: Any, payload: dict[str, Any]) -> None:
        await websocket.send(json.dumps(payload))

    def _handle_message(self, raw: str | bytes) -> None:
        decoded = raw.decode("utf-8") if isinstance(raw, bytes) else raw
        data = json.loads(decoded)
        messages = data if isinstance(data, list) else [data]
        with self._lock:
            self._last_message_at = datetime.now(UTC)
            for message in messages:
                if not isinstance(message, dict):
                    continue
                msg_type = message.get("T")
                symbol = str(message.get("S", "")).upper()
                if not symbol:
                    continue
                if msg_type == "q":
                    self._quotes[symbol] = MarketQuote(
                        symbol=symbol,
                        bid=_decimal(message["bp"]),
                        ask=_decimal(message["ap"]),
                        bid_size=int(message.get("bs") or 0),
                        ask_size=int(message.get("as") or 0),
                        timestamp=_parse_time(str(message["t"])),
                    )
                elif msg_type == "t":
                    self._trades[symbol] = MarketTrade(
                        symbol=symbol,
                        price=_decimal(message["p"]),
                        size=int(message.get("s") or 0),
                        timestamp=_parse_time(str(message["t"])),
                        exchange=str(message["x"]) if message.get("x") is not None else None,
                        trade_id=message.get("i"),
                    )
                elif msg_type == "b":
                    self._bars[symbol] = MarketBar(
                        symbol=symbol,
                        open=_decimal(message["o"]),
                        high=_decimal(message["h"]),
                        low=_decimal(message["l"]),
                        close=_decimal(message["c"]),
                        volume=int(message.get("v") or 0),
                        timestamp=_parse_time(str(message["t"])),
                        trade_count=int(message["n"]) if message.get("n") is not None else None,
                        vwap=_decimal(message["vw"]) if message.get("vw") is not None else None,
                    )
