"""Bar resampling for building higher timeframes from a finer bar stream.

Used by the backtest engine to derive 15m/1h bars from a single 5m series
without look-ahead: a coarser bar is only emitted once enough finer bars
have been added to fully cover its window, and it is built exclusively from
bars already seen (never a partial/in-progress window).
"""

from market_data.snapshot import MarketBar


class BarResampler:
    """Aggregates a stream of fine-grained bars into closed coarser bars.

    Call `add(bar)` once per fine-grained bar, in chronological order.
    Returns the merged coarser bar once `group_size` fine bars have been
    accumulated, otherwise None. The partial (not-yet-closed) group is never
    exposed to callers.
    """

    def __init__(self, group_size: int) -> None:
        if group_size < 1:
            raise ValueError("group_size must be at least 1")
        self._group_size = group_size
        self._buffer: list[MarketBar] = []

    def add(self, bar: MarketBar) -> MarketBar | None:
        self._buffer.append(bar)
        if len(self._buffer) < self._group_size:
            return None
        merged = _merge(self._buffer)
        self._buffer = []
        return merged


def _merge(bars: list[MarketBar]) -> MarketBar:
    volume = 0
    for bar in bars:
        volume += bar.volume
    return MarketBar(
        symbol=bars[0].symbol,
        open=bars[0].open,
        high=max(b.high for b in bars),
        low=min(b.low for b in bars),
        close=bars[-1].close,
        volume=volume,
        timestamp=bars[-1].timestamp,
    )


def resample_closed_bars(bars: list[MarketBar], group_size: int) -> list[MarketBar]:
    """Batch variant of BarResampler for offline use (e.g. tests)."""
    resampler = BarResampler(group_size)
    out: list[MarketBar] = []
    for bar in bars:
        merged = resampler.add(bar)
        if merged is not None:
            out.append(merged)
    return out


__all__ = ["BarResampler", "resample_closed_bars"]
