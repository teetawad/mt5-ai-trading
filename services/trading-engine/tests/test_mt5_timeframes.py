from types import SimpleNamespace

import pytest

from mt5.timeframes import (
    CANONICAL_TIMEFRAMES,
    UnsupportedTimeframeError,
    normalize_timeframe,
    resolve_mt5_timeframe,
)


class FakeMT5Constants:
    TIMEFRAME_M1 = 1
    TIMEFRAME_M5 = 5
    TIMEFRAME_M15 = 15
    TIMEFRAME_M30 = 30
    TIMEFRAME_H1 = 16385
    TIMEFRAME_H4 = 16388
    TIMEFRAME_D1 = 16408


@pytest.mark.parametrize(
    "value,expected_constant",
    [
        ("M1", FakeMT5Constants.TIMEFRAME_M1),
        ("M5", FakeMT5Constants.TIMEFRAME_M5),
        ("M15", FakeMT5Constants.TIMEFRAME_M15),
        ("M30", FakeMT5Constants.TIMEFRAME_M30),
        ("H1", FakeMT5Constants.TIMEFRAME_H1),
        ("H4", FakeMT5Constants.TIMEFRAME_H4),
        ("D1", FakeMT5Constants.TIMEFRAME_D1),
    ],
)
def test_resolve_mt5_timeframe_maps_every_required_timeframe(value, expected_constant):
    assert resolve_mt5_timeframe(FakeMT5Constants(), value) == expected_constant


def test_m5_was_the_regression_now_fixed():
    """Direct regression test for the reported bug: requesting M5 (used by
    Trading AI V3's MarketAnalysisPackage) must resolve, not KeyError."""
    assert resolve_mt5_timeframe(FakeMT5Constants(), "M5") == FakeMT5Constants.TIMEFRAME_M5


@pytest.mark.parametrize(
    "raw,expected_canonical",
    [
        ("m5", "M5"), ("M5", "M5"), ("5m", "M5"), ("5M", "M5"),
        ("m15", "M15"), ("15m", "M15"),
        ("h1", "H1"), ("1h", "H1"),
        ("h4", "H4"), ("4h", "H4"),
        ("d1", "D1"), ("1d", "D1"),
        ("  M30  ", "M30"),
    ],
)
def test_normalize_timeframe_accepts_case_and_alias_variants(raw, expected_canonical):
    assert normalize_timeframe(raw) == expected_canonical


def test_unsupported_timeframe_names_the_actual_offending_value():
    with pytest.raises(UnsupportedTimeframeError) as exc_info:
        normalize_timeframe("H7")
    message = str(exc_info.value)
    assert "H7" in message
    assert message != "Unsupported timeframe"  # regression: must not be the old bare message
    for tf in CANONICAL_TIMEFRAMES:
        assert tf in message  # supported list is included for a discoverable error


def test_unsupported_timeframe_rejects_none_and_empty_string():
    with pytest.raises(UnsupportedTimeframeError):
        normalize_timeframe("")
    with pytest.raises(UnsupportedTimeframeError):
        normalize_timeframe(None)  # type: ignore[arg-type]


def test_does_not_invent_ambiguous_mappings():
    # "M" alone and made-up aliases must not silently resolve to anything.
    for bogus in ("M", "MM5", "5", "WEEK1", "MN1"):
        with pytest.raises(UnsupportedTimeframeError):
            normalize_timeframe(bogus)


def test_resolve_mt5_timeframe_raises_unsupported_when_constant_missing_from_module():
    # Canonical name accepted, but this "MT5 module" doesn't define it —
    # still surfaced as UnsupportedTimeframeError, not AttributeError.
    stub = SimpleNamespace(TIMEFRAME_M1=1)
    with pytest.raises(UnsupportedTimeframeError):
        resolve_mt5_timeframe(stub, "H4")


def test_all_required_timeframes_are_canonical():
    for required in ("M1", "M5", "M15", "M30", "H1", "H4", "D1"):
        assert required in CANONICAL_TIMEFRAMES
