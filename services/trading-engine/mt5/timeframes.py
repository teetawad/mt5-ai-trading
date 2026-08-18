from __future__ import annotations

from typing import Any

# Single canonical timeframe contract for the whole trading engine. Every
# caller that needs an MT5 TIMEFRAME_* constant from a string (bars, chart
# generation, analysis) MUST go through resolve_mt5_timeframe() — never build
# a second ad-hoc mapping or pass a raw string into mt5.copy_rates_*.
#
# Root cause of "Unsupported timeframe" on M5 (2026): the previous mapping in
# MT5Adapter.timeframe() only listed M1/M15/H1/H4 — M5, M30, and D1 were
# simply never added, so mapping["M5"] raised a bare KeyError that the router
# turned into a generic 422 with no indication of which value failed.

CANONICAL_TIMEFRAMES: tuple[str, ...] = ("M1", "M5", "M15", "M30", "H1", "H4", "D1")

# Explicit alias table only — no ambiguous/inferred mappings. Each canonical
# timeframe accepts its own name and the reversed "<n><unit>" form already in
# use elsewhere in this codebase (e.g. "4H" for H4).
_ALIASES: dict[str, str] = {
    "M1": "M1", "1M": "M1",
    "M5": "M5", "5M": "M5",
    "M15": "M15", "15M": "M15",
    "M30": "M30", "30M": "M30",
    "H1": "H1", "1H": "H1",
    "H4": "H4", "4H": "H4",
    "D1": "D1", "1D": "D1",
}


class UnsupportedTimeframeError(ValueError):
    """Raised with the ACTUAL offending value, never a bare/generic message."""

    def __init__(self, raw_value: Any) -> None:
        self.raw_value = raw_value
        super().__init__(
            f"Unsupported timeframe: {raw_value!r}. "
            f"Supported: {', '.join(CANONICAL_TIMEFRAMES)}"
        )


def normalize_timeframe(value: Any) -> str:
    """Normalizes a user/caller-supplied timeframe string (any case, either
    alias order) to its canonical form, e.g. "m5" / "M5" / "5m" -> "M5"."""
    if not isinstance(value, str) or not value.strip():
        raise UnsupportedTimeframeError(value)
    canonical = _ALIASES.get(value.strip().upper())
    if canonical is None:
        raise UnsupportedTimeframeError(value)
    return canonical


def resolve_mt5_timeframe(mt5_module: Any, value: Any) -> int:
    """Normalizes `value` and maps it to the real mt5.TIMEFRAME_* constant.
    Never passes the raw string into any MetaTrader5 call — every candle
    request goes through this single, testable conversion."""
    canonical = normalize_timeframe(value)
    attr_name = f"TIMEFRAME_{canonical}"
    try:
        return int(getattr(mt5_module, attr_name))
    except AttributeError as exc:
        # The canonical name was accepted above but the loaded MetaTrader5
        # module (or a test fake) doesn't define this constant — still the
        # caller's timeframe that's unsupported in this environment, not a
        # different failure mode.
        raise UnsupportedTimeframeError(value) from exc
