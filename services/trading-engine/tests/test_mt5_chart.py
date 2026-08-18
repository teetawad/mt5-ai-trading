import base64

from mt5.chart import render_candlestick_chart


def _bars(n=60):
    bars = []
    price = 100.0
    for i in range(n):
        o = price
        c = price + (0.5 if i % 2 == 0 else -0.3)
        h = max(o, c) + 0.2
        low = min(o, c) - 0.2
        bars.append(
            {"time": 1_700_000_000 + i * 3600, "open": o, "high": h, "low": low, "close": c}
        )
        price = c
    return bars


def test_render_candlestick_chart_returns_valid_png_base64():
    encoded = render_candlestick_chart("EURUSD", "H1", _bars(), current_price=100.5)
    raw = base64.b64decode(encoded)
    assert raw[:8] == b"\x89PNG\r\n\x1a\n"
    assert len(raw) > 500


def test_render_candlestick_chart_rejects_empty_bars():
    import pytest

    with pytest.raises(ValueError):
        render_candlestick_chart("EURUSD", "H1", [])
