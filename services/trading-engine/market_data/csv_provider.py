"""CSV-based market data provider for replaying historical price series.

Expected CSV format (one file per symbol, e.g. data/market_data/AAPL.csv):
    timestamp,open,high,low,close,volume
    2024-01-02T09:30:00Z,185.00,186.50,184.75,186.00,12345678
    ...

Rows are replayed in order, looping back to the start when exhausted.
Call `advance()` manually or rely on `tick_interval_seconds` to progress.
"""

import csv
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from .provider import MarketDataProvider, SymbolNotFoundError
from .snapshot import MarketSnapshot


class CSVMarketDataProvider(MarketDataProvider):
    def __init__(
        self,
        data_dir: str | Path,
        tick_interval_seconds: float = 5.0,
        half_spread_pct: float = 0.0005,
        staleness_threshold_seconds: int = 60,
    ) -> None:
        self._data_dir = Path(data_dir)
        self._tick_interval = tick_interval_seconds
        self._half_spread = Decimal(str(half_spread_pct))
        self._staleness_threshold = staleness_threshold_seconds

        self._rows: dict[str, list[dict[str, str]]] = {}
        self._index: dict[str, int] = {}
        self._last_tick: dict[str, datetime] = {}
        self._current_rows: dict[str, dict[str, str]] = {}

        self._load_all()

    def _load_all(self) -> None:
        for csv_file in self._data_dir.glob("*.csv"):
            symbol = csv_file.stem.upper()
            rows: list[dict[str, str]] = []
            with open(csv_file, newline="", encoding="utf-8") as f:
                for row in csv.DictReader(f):
                    rows.append(row)
            if rows:
                self._rows[symbol] = rows
                self._index[symbol] = 0

    def _advance(self, symbol: str) -> None:
        rows = self._rows[symbol]
        idx = self._index[symbol]
        self._current_rows[symbol] = rows[idx]
        self._index[symbol] = (idx + 1) % len(rows)
        self._last_tick[symbol] = datetime.now(UTC)

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol not in self._rows:
            raise SymbolNotFoundError(f"No CSV data for symbol: {symbol}")

        now = datetime.now(UTC)
        last = self._last_tick.get(symbol)
        if last is None or (now - last).total_seconds() >= self._tick_interval:
            self._advance(symbol)

        row = self._current_rows[symbol]
        price = Decimal(row.get("close", row.get("price", "0"))).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        bid = (price * (1 - self._half_spread)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        ask = (price * (1 + self._half_spread)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        tick_time = self._last_tick[symbol]
        age_seconds = (now - tick_time).total_seconds()

        return MarketSnapshot(
            symbol=symbol,
            price=price,
            bid=bid,
            ask=ask,
            volume=int(row.get("volume", 0)),
            timestamp=tick_time,
            is_stale=age_seconds > self._staleness_threshold,
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self.get_snapshot(sym) for sym in self._rows]

    def tracked_symbols(self) -> list[str]:
        return list(self._rows.keys())
