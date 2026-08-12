"""Tests for the Risk Engine — Phase 7.

Coverage strategy:
  - One test per rule × PASS and FAIL paths
  - Multi-failure accumulation
  - PRE_EXECUTION-only rules vs PRE_PROPOSAL
  - Stage skipping (session, cooldown when disabled)
  - FastAPI endpoint smoke tests (no DB required)
"""

from datetime import UTC, datetime, timedelta
from decimal import Decimal

import pytest
from fastapi.testclient import TestClient

from risk.engine import evaluate
from risk.types import (
    EvaluationStage,
    MarketInput,
    PendingProposalInput,
    PortfolioInput,
    ProposalInput,
    RiskConfig,
    RiskEvaluationRequest,
    RuleOutcome,
    TradeSide,
)

# ── Helpers ──────────────────────────────────────────────────────────────────

_NOW = datetime(2024, 6, 15, 12, 0, 0, tzinfo=UTC)  # Saturday noon UTC


def _market(price: str = "100.00", is_stale: bool = False) -> MarketInput:
    return MarketInput(
        symbol="AAPL",
        price=Decimal(price),
        is_stale=is_stale,
        timestamp=_NOW.isoformat(),
    )


def _portfolio(
    cash: str = "50000.00",
    equity: str = "100000.00",
    daily_pnl: str = "0.00",
    positions: dict[str, str] | None = None,
) -> PortfolioInput:
    return PortfolioInput(
        cash=Decimal(cash),
        equity=Decimal(equity),
        daily_pnl=Decimal(daily_pnl),
        positions={k: Decimal(v) for k, v in (positions or {}).items()},
    )


def _proposal(
    side: TradeSide = TradeSide.BUY,
    quantity: str = "10",
    reference_price: str = "100.00",
    expires_at: str | None = None,
) -> ProposalInput:
    return ProposalInput(
        symbol="AAPL",
        side=side,
        quantity=Decimal(quantity),
        reference_price=Decimal(reference_price),
        expires_at=expires_at,
    )


def _config(**overrides: object) -> RiskConfig:
    defaults: dict[str, object] = {
        "kill_switch_enabled": True,
        "trading_mode": "PAPER",
        "market_data_staleness_seconds": 60,
        "price_drift_threshold_pct": Decimal("2.0"),
        "max_order_notional_usd": Decimal("10000.00"),
        "max_position_size_usd": Decimal("50000.00"),
        "max_portfolio_concentration_pct": Decimal("20.0"),
        "max_open_positions": 10,
        "max_daily_loss_usd": Decimal("1000.00"),
        "trading_session_start": None,
        "trading_session_end": None,
        "cooldown_between_trades_seconds": 0,
    }
    defaults.update(overrides)
    return RiskConfig(**defaults)  # type: ignore[arg-type]


def _request(
    stage: EvaluationStage = EvaluationStage.PRE_PROPOSAL,
    proposal: ProposalInput | None = None,
    market: MarketInput | None = None,
    portfolio: PortfolioInput | None = None,
    config: RiskConfig | None = None,
    pending_proposals: list[PendingProposalInput] | None = None,
    last_fill_times: dict[str, str] | None = None,
) -> RiskEvaluationRequest:
    return RiskEvaluationRequest(
        stage=stage,
        proposal=proposal or _proposal(),
        market=market or _market(),
        portfolio=portfolio or _portfolio(),
        config=config or _config(),
        pending_proposals=pending_proposals or [],
        last_fill_times=last_fill_times or {},
    )


def _eval(req: RiskEvaluationRequest):
    return evaluate(req, _now=_NOW)


# ── Full pass ─────────────────────────────────────────────────────────────────

class TestFullPass:
    def test_pre_proposal_all_pass(self):
        result = _eval(_request())
        assert result.result == RuleOutcome.PASS
        assert result.failed_rules == []
        assert result.reason is None
        assert "KILL_SWITCH" in result.rules_checked
        assert "TRADING_MODE" in result.rules_checked

    def test_pre_execution_all_pass(self):
        future = (_NOW + timedelta(hours=1)).isoformat()
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(expires_at=future),
        ))
        assert result.result == RuleOutcome.PASS
        assert "PROPOSAL_EXPIRATION" in result.rules_checked
        assert "PRICE_DRIFT" in result.rules_checked

    def test_result_includes_stage_and_timestamp(self):
        result = _eval(_request())
        assert result.stage == EvaluationStage.PRE_PROPOSAL
        assert result.evaluated_at.startswith("2024-06-15T12:00:00")


# ── Rule 1: KILL_SWITCH ───────────────────────────────────────────────────────

class TestKillSwitch:
    def test_disabled_rejects_immediately(self):
        result = _eval(_request(config=_config(kill_switch_enabled=False)))
        assert result.result == RuleOutcome.REJECT
        assert "KILL_SWITCH" in result.failed_rules
        assert result.rules_checked == ["KILL_SWITCH"]  # early exit — nothing else checked

    def test_enabled_continues(self):
        result = _eval(_request(config=_config(kill_switch_enabled=True)))
        assert result.result == RuleOutcome.PASS
        assert "KILL_SWITCH" not in result.failed_rules


# ── Rule 2: TRADING_MODE ──────────────────────────────────────────────────────

class TestTradingMode:
    def test_live_mode_rejects_immediately(self):
        result = _eval(_request(config=_config(trading_mode="LIVE")))
        assert result.result == RuleOutcome.REJECT
        assert "TRADING_MODE" in result.failed_rules
        assert result.rules_checked == ["KILL_SWITCH", "TRADING_MODE"]

    def test_paper_mode_continues(self):
        result = _eval(_request(config=_config(trading_mode="PAPER")))
        assert result.result == RuleOutcome.PASS

    def test_reason_contains_mode_name(self):
        result = _eval(_request(config=_config(trading_mode="LIVE")))
        assert result.reason is not None
        assert "LIVE" in result.reason


# ── Rule 3: PROPOSAL_EXPIRATION ───────────────────────────────────────────────

class TestProposalExpiration:
    def test_expired_proposal_fails(self):
        past = (_NOW - timedelta(minutes=5)).isoformat()
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(expires_at=past),
        ))
        assert "PROPOSAL_EXPIRATION" in result.failed_rules

    def test_future_expiry_passes(self):
        future = (_NOW + timedelta(hours=1)).isoformat()
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(expires_at=future),
        ))
        assert "PROPOSAL_EXPIRATION" not in result.failed_rules

    def test_no_expiry_date_passes(self):
        result = _eval(_request(stage=EvaluationStage.PRE_EXECUTION))
        assert "PROPOSAL_EXPIRATION" not in result.failed_rules

    def test_not_checked_in_pre_proposal(self):
        past = (_NOW - timedelta(minutes=5)).isoformat()
        result = _eval(_request(
            stage=EvaluationStage.PRE_PROPOSAL,
            proposal=_proposal(expires_at=past),
        ))
        assert "PROPOSAL_EXPIRATION" not in result.rules_checked


# ── Rule 4: MARKET_DATA_FRESHNESS ─────────────────────────────────────────────

class TestMarketDataFreshness:
    def test_stale_data_fails(self):
        result = _eval(_request(market=_market(is_stale=True)))
        assert "MARKET_DATA_FRESHNESS" in result.failed_rules

    def test_fresh_data_passes(self):
        result = _eval(_request(market=_market(is_stale=False)))
        assert "MARKET_DATA_FRESHNESS" not in result.failed_rules

    def test_always_checked_regardless_of_stage(self):
        r1 = _eval(_request(stage=EvaluationStage.PRE_PROPOSAL, market=_market(is_stale=True)))
        r2 = _eval(_request(stage=EvaluationStage.PRE_EXECUTION, market=_market(is_stale=True)))
        assert "MARKET_DATA_FRESHNESS" in r1.rules_checked
        assert "MARKET_DATA_FRESHNESS" in r2.rules_checked


# ── Rule 5: PRICE_DRIFT ───────────────────────────────────────────────────────

class TestPriceDrift:
    def test_large_drift_fails_in_pre_execution(self):
        # reference_price=100, current=103 → 3% drift > 2% threshold
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(reference_price="100.00"),
            market=_market(price="103.00"),
        ))
        assert "PRICE_DRIFT" in result.failed_rules

    def test_small_drift_passes(self):
        # reference_price=100, current=101 → 1% drift < 2% threshold
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(reference_price="100.00"),
            market=_market(price="101.00"),
        ))
        assert "PRICE_DRIFT" not in result.failed_rules

    def test_not_checked_in_pre_proposal(self):
        result = _eval(_request(
            stage=EvaluationStage.PRE_PROPOSAL,
            proposal=_proposal(reference_price="100.00"),
            market=_market(price="200.00"),  # huge drift, but wrong stage
        ))
        assert "PRICE_DRIFT" not in result.rules_checked

    def test_exactly_at_threshold_passes(self):
        # reference=100, current=102 → exactly 2% → must pass (threshold is exclusive)
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(reference_price="100.00"),
            market=_market(price="102.00"),
            config=_config(price_drift_threshold_pct=Decimal("2.0")),
        ))
        assert "PRICE_DRIFT" not in result.failed_rules

    def test_reason_includes_prices(self):
        result = _eval(_request(
            stage=EvaluationStage.PRE_EXECUTION,
            proposal=_proposal(reference_price="100.00"),
            market=_market(price="110.00"),
        ))
        assert result.reason is not None
        assert "100" in result.reason
        assert "110" in result.reason


# ── Rule 6: MAX_ORDER_NOTIONAL ────────────────────────────────────────────────

class TestMaxOrderNotional:
    def test_exceeds_limit_fails(self):
        # 200 shares × $100 = $20,000 > $10,000 limit
        result = _eval(_request(proposal=_proposal(quantity="200")))
        assert "MAX_ORDER_NOTIONAL" in result.failed_rules

    def test_within_limit_passes(self):
        # 10 shares × $100 = $1,000 < $10,000 limit
        result = _eval(_request(proposal=_proposal(quantity="10")))
        assert "MAX_ORDER_NOTIONAL" not in result.failed_rules

    def test_exactly_at_limit_passes(self):
        # 100 shares × $100 = $10,000 = limit
        result = _eval(_request(proposal=_proposal(quantity="100")))
        assert "MAX_ORDER_NOTIONAL" not in result.failed_rules


# ── Rule 7: AVAILABLE_CASH / AVAILABLE_POSITION ───────────────────────────────

class TestAvailableFunds:
    def test_insufficient_cash_buy_fails(self):
        # 10 shares × $100 = $1,000 but only $500 cash
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            market=_market(price="100.00"),
            portfolio=_portfolio(cash="500.00"),
        ))
        assert "AVAILABLE_CASH" in result.failed_rules

    def test_sufficient_cash_buy_passes(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            market=_market(price="100.00"),
            portfolio=_portfolio(cash="5000.00"),
        ))
        assert "AVAILABLE_CASH" not in result.failed_rules

    def test_insufficient_position_sell_fails(self):
        # Trying to sell 10 but only hold 5
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="10"),
            portfolio=_portfolio(positions={"AAPL": "5"}),
        ))
        assert "AVAILABLE_POSITION" in result.failed_rules

    def test_sufficient_position_sell_passes(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="10"),
            portfolio=_portfolio(positions={"AAPL": "15"}),
        ))
        assert "AVAILABLE_POSITION" not in result.failed_rules

    def test_zero_position_sell_fails(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="10"),
            portfolio=_portfolio(positions={}),
        ))
        assert "AVAILABLE_POSITION" in result.failed_rules

    def test_buy_checks_cash_not_position(self):
        result = _eval(_request(proposal=_proposal(side=TradeSide.BUY)))
        assert "AVAILABLE_CASH" in result.rules_checked
        assert "AVAILABLE_POSITION" not in result.rules_checked

    def test_sell_checks_position_not_cash(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="1"),
            portfolio=_portfolio(positions={"AAPL": "10"}),
        ))
        assert "AVAILABLE_POSITION" in result.rules_checked
        assert "AVAILABLE_CASH" not in result.rules_checked


# ── Rule 8: MAX_POSITION_SIZE ─────────────────────────────────────────────────

class TestMaxPositionSize:
    def test_new_position_exceeds_limit_fails(self):
        # 600 shares × $100 = $60,000 > $50,000 limit
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="600"),
            market=_market(price="100.00"),
            portfolio=_portfolio(cash="100000.00"),
            config=_config(
                max_order_notional_usd=Decimal("100000.00"),
                max_position_size_usd=Decimal("50000.00"),
            ),
        ))
        assert "MAX_POSITION_SIZE" in result.failed_rules

    def test_within_limit_passes(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            market=_market(price="100.00"),
        ))
        assert "MAX_POSITION_SIZE" not in result.failed_rules

    def test_existing_position_included_in_check(self):
        # Already hold 400 shares, buying 200 more → 600 × $100 = $60,000 > $50,000
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="200"),
            market=_market(price="100.00"),
            portfolio=_portfolio(
                cash="100000.00",
                positions={"AAPL": "400"},
            ),
            config=_config(
                max_order_notional_usd=Decimal("100000.00"),
                max_position_size_usd=Decimal("50000.00"),
            ),
        ))
        assert "MAX_POSITION_SIZE" in result.failed_rules

    def test_not_checked_for_sell(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="1"),
            portfolio=_portfolio(positions={"AAPL": "10"}),
        ))
        assert "MAX_POSITION_SIZE" not in result.rules_checked


# ── Rule 9: MAX_PORTFOLIO_CONCENTRATION ───────────────────────────────────────

class TestMaxPortfolioConcentration:
    def test_concentration_exceeds_limit_fails(self):
        # Buy 10 @ $100 = $1,000 in a $2,000 equity portfolio → 50% > 20%
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            market=_market(price="100.00"),
            portfolio=_portfolio(
                cash="2000.00",
                equity="2000.00",
            ),
        ))
        assert "MAX_PORTFOLIO_CONCENTRATION" in result.failed_rules

    def test_concentration_within_limit_passes(self):
        # Buy 10 @ $100 = $1,000 in a $100,000 equity portfolio → 1% < 20%
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            market=_market(price="100.00"),
            portfolio=_portfolio(equity="100000.00"),
        ))
        assert "MAX_PORTFOLIO_CONCENTRATION" not in result.failed_rules

    def test_skipped_when_equity_is_zero(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY),
            portfolio=_portfolio(equity="0.00"),
        ))
        assert "MAX_PORTFOLIO_CONCENTRATION" not in result.rules_checked

    def test_not_checked_for_sell(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="1"),
            portfolio=_portfolio(positions={"AAPL": "10"}),
        ))
        assert "MAX_PORTFOLIO_CONCENTRATION" not in result.rules_checked


# ── Rule 10: MAX_OPEN_POSITIONS ───────────────────────────────────────────────

class TestMaxOpenPositions:
    def test_at_limit_opening_new_position_fails(self):
        # 10 open positions + trying to open AAPL (not already held) → fails
        existing = {f"SYM{i}": "10" for i in range(10)}
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            portfolio=_portfolio(positions=existing, cash="100000.00"),
            config=_config(max_open_positions=10),
        ))
        assert "MAX_OPEN_POSITIONS" in result.failed_rules

    def test_below_limit_passes(self):
        existing = {f"SYM{i}": "10" for i in range(5)}
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            portfolio=_portfolio(positions=existing, cash="100000.00"),
            config=_config(max_open_positions=10),
        ))
        assert "MAX_OPEN_POSITIONS" not in result.failed_rules

    def test_adding_to_existing_position_not_checked(self):
        # Already hold AAPL → not opening a new position → rule not evaluated
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="10"),
            portfolio=_portfolio(positions={"AAPL": "5"}, cash="100000.00"),
        ))
        assert "MAX_OPEN_POSITIONS" not in result.rules_checked

    def test_not_checked_for_sell(self):
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.SELL, quantity="1"),
            portfolio=_portfolio(positions={"AAPL": "10"}),
        ))
        assert "MAX_OPEN_POSITIONS" not in result.rules_checked


# ── Rule 11: MAX_DAILY_LOSS ───────────────────────────────────────────────────

class TestMaxDailyLoss:
    def test_loss_exceeds_limit_fails(self):
        result = _eval(_request(
            portfolio=_portfolio(daily_pnl="-1500.00"),
            config=_config(max_daily_loss_usd=Decimal("1000.00")),
        ))
        assert "MAX_DAILY_LOSS" in result.failed_rules

    def test_loss_within_limit_passes(self):
        result = _eval(_request(
            portfolio=_portfolio(daily_pnl="-500.00"),
        ))
        assert "MAX_DAILY_LOSS" not in result.failed_rules

    def test_zero_pnl_passes(self):
        result = _eval(_request(portfolio=_portfolio(daily_pnl="0.00")))
        assert "MAX_DAILY_LOSS" not in result.failed_rules

    def test_positive_pnl_passes(self):
        result = _eval(_request(portfolio=_portfolio(daily_pnl="500.00")))
        assert "MAX_DAILY_LOSS" not in result.failed_rules

    def test_reason_includes_loss_amount(self):
        result = _eval(_request(
            portfolio=_portfolio(daily_pnl="-1200.00"),
            config=_config(max_daily_loss_usd=Decimal("1000.00")),
        ))
        assert result.reason is not None
        assert "1200" in result.reason or "1,200" in result.reason


# ── Rule 12: DUPLICATE_EXPOSURE ───────────────────────────────────────────────

class TestDuplicateExposure:
    def test_duplicate_same_symbol_and_side_fails(self):
        pending = [PendingProposalInput(symbol="AAPL", side=TradeSide.BUY)]
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY),
            pending_proposals=pending,
        ))
        assert "DUPLICATE_EXPOSURE" in result.failed_rules

    def test_same_symbol_different_side_passes(self):
        # Pending SELL while we're BUYing → not a duplicate
        pending = [PendingProposalInput(symbol="AAPL", side=TradeSide.SELL)]
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY),
            pending_proposals=pending,
        ))
        assert "DUPLICATE_EXPOSURE" not in result.failed_rules

    def test_different_symbol_passes(self):
        pending = [PendingProposalInput(symbol="GOOG", side=TradeSide.BUY)]
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY),
            pending_proposals=pending,
        ))
        assert "DUPLICATE_EXPOSURE" not in result.failed_rules

    def test_no_pending_passes(self):
        result = _eval(_request(pending_proposals=[]))
        assert "DUPLICATE_EXPOSURE" not in result.failed_rules


# ── Rule 13: TRADING_SESSION ──────────────────────────────────────────────────

class TestTradingSession:
    # _NOW is 2024-06-15 12:00:00 UTC

    def test_within_session_passes(self):
        result = _eval(_request(config=_config(
            trading_session_start="09:00",
            trading_session_end="17:00",
        )))
        assert "TRADING_SESSION" not in result.failed_rules

    def test_outside_session_fails(self):
        result = _eval(_request(config=_config(
            trading_session_start="13:00",
            trading_session_end="15:00",
        )))
        assert "TRADING_SESSION" in result.failed_rules

    def test_not_checked_when_session_not_configured(self):
        result = _eval(_request(config=_config(
            trading_session_start=None,
            trading_session_end=None,
        )))
        assert "TRADING_SESSION" not in result.rules_checked

    def test_overnight_session_in_window(self):
        # Session 22:00–02:00; current time is noon → outside
        result = _eval(_request(config=_config(
            trading_session_start="22:00",
            trading_session_end="02:00",
        )))
        assert "TRADING_SESSION" in result.failed_rules

    def test_reason_includes_session_bounds(self):
        result = _eval(_request(config=_config(
            trading_session_start="14:00",
            trading_session_end="16:00",
        )))
        assert result.reason is not None
        assert "14:00" in result.reason
        assert "16:00" in result.reason


# ── Rule 14: COOLDOWN ─────────────────────────────────────────────────────────

class TestCooldown:
    def test_within_cooldown_fails(self):
        # Last fill 10 seconds ago, cooldown is 60 seconds
        last_fill = (_NOW - timedelta(seconds=10)).isoformat()
        result = _eval(_request(
            config=_config(cooldown_between_trades_seconds=60),
            last_fill_times={"AAPL": last_fill},
        ))
        assert "COOLDOWN" in result.failed_rules

    def test_after_cooldown_passes(self):
        # Last fill 120 seconds ago, cooldown is 60 seconds
        last_fill = (_NOW - timedelta(seconds=120)).isoformat()
        result = _eval(_request(
            config=_config(cooldown_between_trades_seconds=60),
            last_fill_times={"AAPL": last_fill},
        ))
        assert "COOLDOWN" not in result.failed_rules

    def test_no_last_fill_passes(self):
        result = _eval(_request(
            config=_config(cooldown_between_trades_seconds=60),
            last_fill_times={},
        ))
        assert "COOLDOWN" not in result.failed_rules

    def test_not_checked_when_cooldown_disabled(self):
        result = _eval(_request(config=_config(cooldown_between_trades_seconds=0)))
        assert "COOLDOWN" not in result.rules_checked

    def test_reason_includes_remaining_time(self):
        last_fill = (_NOW - timedelta(seconds=30)).isoformat()
        result = _eval(_request(
            config=_config(cooldown_between_trades_seconds=60),
            last_fill_times={"AAPL": last_fill},
        ))
        assert result.reason is not None
        assert "30s" in result.reason or "30" in result.reason

    def test_different_symbol_not_affected(self):
        last_fill = (_NOW - timedelta(seconds=10)).isoformat()
        result = _eval(_request(
            config=_config(cooldown_between_trades_seconds=60),
            last_fill_times={"GOOG": last_fill},  # different symbol
        ))
        assert "COOLDOWN" not in result.failed_rules


# ── Multi-failure ─────────────────────────────────────────────────────────────

class TestMultipleFailures:
    def test_all_failed_rules_are_recorded(self):
        # Trigger stale data + order too big + not enough cash
        result = _eval(_request(
            proposal=_proposal(side=TradeSide.BUY, quantity="200"),  # $20k > $10k limit
            market=_market(price="100.00", is_stale=True),
            portfolio=_portfolio(cash="500.00"),  # insufficient
        ))
        assert result.result == RuleOutcome.REJECT
        assert "MARKET_DATA_FRESHNESS" in result.failed_rules
        assert "MAX_ORDER_NOTIONAL" in result.failed_rules
        assert "AVAILABLE_CASH" in result.failed_rules
        # Reason combines all messages
        assert result.reason is not None
        assert ";" in result.reason

    def test_evaluation_continues_after_non_critical_failure(self):
        # Market data stale should not stop other rules from running
        result = _eval(_request(market=_market(is_stale=True)))
        checked = result.rules_checked
        assert "MAX_ORDER_NOTIONAL" in checked
        assert "AVAILABLE_CASH" in checked
        assert "MAX_DAILY_LOSS" in checked


# ── FastAPI endpoint ──────────────────────────────────────────────────────────

class TestRiskEndpoint:
    @pytest.fixture()
    def client(self):
        import os

        os.environ["INTERNAL_SERVICE_TOKEN"] = "test-internal-token"
        from main import app

        return TestClient(app, headers={"X-Internal-Token": "test-internal-token"})

    def test_evaluate_returns_200(self, client):
        payload = {
            "stage": "PRE_PROPOSAL",
            "proposal": {
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "10",
                "reference_price": "100.00",
            },
            "market": {
                "symbol": "AAPL",
                "price": "100.00",
                "is_stale": False,
                "timestamp": _NOW.isoformat(),
            },
            "portfolio": {
                "cash": "50000.00",
                "positions": {},
                "equity": "100000.00",
                "daily_pnl": "0.00",
            },
        }
        resp = client.post("/risk/evaluate", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert data["result"] in ("PASS", "REJECT")
        assert "rules_checked" in data
        assert "failed_rules" in data
        assert data["market_snapshot"]["symbol"] == "AAPL"
        assert data["portfolio_snapshot"]["cash"] == "50000.00"
        assert "evaluated_at" in data

    def test_evaluate_reject_kill_switch_off(self, client):
        payload = {
            "stage": "PRE_PROPOSAL",
            "proposal": {
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "10",
                "reference_price": "100.00",
            },
            "market": {
                "symbol": "AAPL",
                "price": "100.00",
                "is_stale": False,
                "timestamp": _NOW.isoformat(),
            },
            "portfolio": {
                "cash": "50000.00",
                "positions": {},
                "equity": "100000.00",
                "daily_pnl": "0.00",
            },
            "config": {"kill_switch_enabled": False},
        }
        resp = client.post("/risk/evaluate", json=payload)
        assert resp.status_code == 200
        assert resp.json()["result"] == "REJECT"
        assert "KILL_SWITCH" in resp.json()["failed_rules"]

    def test_evaluate_forbidden_with_wrong_token(self, client):
        import os

        os.environ["INTERNAL_SERVICE_TOKEN"] = "secret"
        try:
            resp = client.post(
                "/risk/evaluate",
                json={},
                headers={"X-Internal-Token": "wrong"},
            )
            assert resp.status_code == 403
        finally:
            os.environ.pop("INTERNAL_SERVICE_TOKEN", None)

    def test_evaluate_invalid_payload_returns_422(self, client):
        resp = client.post("/risk/evaluate", json={"stage": "BAD_STAGE"})
        assert resp.status_code == 422
