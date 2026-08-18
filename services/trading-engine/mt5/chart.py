from __future__ import annotations

import base64
import io
import math
from datetime import UTC, datetime
from typing import Any

import matplotlib

matplotlib.use("Agg")  # server-side rendering only, never opens a GUI window

import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
from matplotlib.patches import Rectangle  # noqa: E402


def _sma(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = []
    for i in range(len(values)):
        if i + 1 < period:
            out.append(None)
            continue
        window = values[i + 1 - period : i + 1]
        out.append(sum(window) / period)
    return out


def render_candlestick_chart(
    symbol: str,
    timeframe: str,
    bars: list[dict[str, Any]],
    current_price: float | None = None,
) -> str:
    """Renders a clean candlestick chart with SMA20/SMA50 overlays and the
    current price line directly from MT5 OHLC data (never a desktop
    screenshot), so chart generation can run entirely server-side. Returns a
    base64-encoded PNG (no data: prefix)."""
    rows = sorted(bars, key=lambda b: b.get("time", 0))
    if not rows:
        raise ValueError("no bars to render")

    times = [mdates.date2num(_to_datetime(row.get("time"))) for row in rows]  # type: ignore[no-untyped-call]
    opens = [float(row.get("open", 0)) for row in rows]
    highs = [float(row.get("high", 0)) for row in rows]
    lows = [float(row.get("low", 0)) for row in rows]
    closes = [float(row.get("close", 0)) for row in rows]

    sma20 = _sma(closes, 20)
    sma50 = _sma(closes, 50)

    fig, ax = plt.subplots(figsize=(9, 4.5), dpi=110)
    fig.patch.set_facecolor("#0f172a")
    ax.set_facecolor("#0f172a")

    width = (times[-1] - times[0]) / max(len(times), 1) * 0.6 if len(times) > 1 else 0.0006
    for t, o, h, low, c in zip(times, opens, highs, lows, closes, strict=True):
        color = "#34d399" if c >= o else "#fb7185"
        ax.plot([t, t], [low, h], color=color, linewidth=0.8, zorder=2)
        rect = Rectangle(
            (t - width / 2, min(o, c)), width, max(abs(c - o), 1e-9),
            facecolor=color, edgecolor=color, zorder=3,
        )
        ax.add_patch(rect)

    if any(v is not None for v in sma20):
        ax.plot(times, _to_plot_series(sma20), color="#38bdf8", linewidth=1.1, label="SMA20")
    if any(v is not None for v in sma50):
        ax.plot(times, _to_plot_series(sma50), color="#fbbf24", linewidth=1.1, label="SMA50")

    if current_price is not None:
        ax.axhline(current_price, color="#e2e8f0", linewidth=0.8, linestyle="--", alpha=0.7)
        ax.text(
            times[-1], current_price, f" {current_price:g}",
            color="#e2e8f0", fontsize=8, va="center",
        )

    recent_high = max(highs[-40:]) if len(highs) >= 1 else max(highs)
    recent_low = min(lows[-40:]) if len(lows) >= 1 else min(lows)
    ax.axhline(recent_high, color="#94a3b8", linewidth=0.6, linestyle=":", alpha=0.6)
    ax.axhline(recent_low, color="#94a3b8", linewidth=0.6, linestyle=":", alpha=0.6)

    ax.set_title(f"{symbol} {timeframe}", color="#e2e8f0", fontsize=11, loc="left")
    ax.tick_params(colors="#94a3b8", labelsize=7)
    ax.xaxis.set_major_formatter(mdates.DateFormatter("%m-%d %H:%M"))  # type: ignore[no-untyped-call]
    for spine in ax.spines.values():
        spine.set_color("#1e293b")
    ax.grid(color="#1e293b", linewidth=0.5, alpha=0.6)
    if any(v is not None for v in sma20) or any(v is not None for v in sma50):
        legend = ax.legend(loc="upper left", fontsize=7, framealpha=0.2)
        for text in legend.get_texts():
            text.set_color("#e2e8f0")

    fig.autofmt_xdate()
    fig.tight_layout()

    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", facecolor=fig.get_facecolor())
    plt.close(fig)
    buffer.seek(0)
    return base64.b64encode(buffer.read()).decode("ascii")


def _to_plot_series(values: list[float | None]) -> list[float]:
    return [math.nan if v is None else v for v in values]


def _to_datetime(value: Any) -> datetime:
    if value is None:
        return datetime.now(tz=UTC)
    return datetime.fromtimestamp(int(value), tz=UTC)
