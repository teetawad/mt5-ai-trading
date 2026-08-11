from datetime import UTC, datetime, time
from decimal import Decimal

from risk.types import (
    EvaluationStage,
    RiskEvaluationRequest,
    RiskResult,
    RuleOutcome,
    TradeSide,
)


def evaluate(request: RiskEvaluationRequest, _now: datetime | None = None) -> RiskResult:
    """Evaluate a trade proposal against all configured risk rules.

    Args:
        request: Full risk evaluation request including proposal, market, portfolio, and config.
        _now: Override for current time; used in tests to avoid time-sensitive flakiness.

    Returns:
        RiskResult with PASS or REJECT, listing all rules checked and any failures.
    """
    rules_checked: list[str] = []
    failed_rules: list[str] = []
    reasons: list[str] = []
    now = _now if _now is not None else datetime.now(tz=UTC)

    cfg = request.config
    proposal = request.proposal
    market = request.market
    portfolio = request.portfolio

    # Rule 1: KILL_SWITCH — early exit on fail
    rules_checked.append("KILL_SWITCH")
    if not cfg.kill_switch_enabled:
        failed_rules.append("KILL_SWITCH")
        return _build_result(
            RuleOutcome.REJECT,
            request.stage,
            rules_checked,
            failed_rules,
            ["Kill switch is disabled"],
            request,
            now,
        )

    # Rule 2: TRADING_MODE — early exit on fail
    rules_checked.append("TRADING_MODE")
    if cfg.trading_mode != "PAPER":
        failed_rules.append("TRADING_MODE")
        return _build_result(
            RuleOutcome.REJECT,
            request.stage,
            rules_checked,
            failed_rules,
            [f"Trading mode is not PAPER: {cfg.trading_mode}"],
            request,
            now,
        )

    # Rule 3: PROPOSAL_EXPIRATION — PRE_EXECUTION only
    if request.stage == EvaluationStage.PRE_EXECUTION:
        rules_checked.append("PROPOSAL_EXPIRATION")
        if proposal.expires_at is not None:
            expires = datetime.fromisoformat(proposal.expires_at)
            if expires <= now:
                failed_rules.append("PROPOSAL_EXPIRATION")
                reasons.append(f"Proposal expired at {proposal.expires_at}")

    # Rule 4: MARKET_DATA_FRESHNESS
    rules_checked.append("MARKET_DATA_FRESHNESS")
    if market.is_stale:
        failed_rules.append("MARKET_DATA_FRESHNESS")
        reasons.append(
            f"Market data is stale (threshold: {cfg.market_data_staleness_seconds}s)"
        )

    # Rule 5: PRICE_DRIFT — PRE_EXECUTION only
    if request.stage == EvaluationStage.PRE_EXECUTION and proposal.reference_price > Decimal("0"):
        rules_checked.append("PRICE_DRIFT")
        drift_pct = (
            abs(market.price - proposal.reference_price)
            / proposal.reference_price
            * Decimal("100")
        )
        if drift_pct > cfg.price_drift_threshold_pct:
            failed_rules.append("PRICE_DRIFT")
            reasons.append(
                f"Price drifted {drift_pct:.4f}% from reference"
                f" ${proposal.reference_price} to ${market.price}"
                f" (threshold: {cfg.price_drift_threshold_pct}%)"
            )

    # Rule 6: MAX_ORDER_NOTIONAL
    rules_checked.append("MAX_ORDER_NOTIONAL")
    notional = proposal.quantity * market.price
    if notional > cfg.max_order_notional_usd:
        failed_rules.append("MAX_ORDER_NOTIONAL")
        reasons.append(
            f"Order notional ${notional:.2f} exceeds limit ${cfg.max_order_notional_usd}"
        )

    # Rule 7: AVAILABLE_CASH (BUY) / AVAILABLE_POSITION (SELL)
    if proposal.side == TradeSide.BUY:
        rules_checked.append("AVAILABLE_CASH")
        if portfolio.cash < notional:
            failed_rules.append("AVAILABLE_CASH")
            reasons.append(
                f"Insufficient cash: have ${portfolio.cash:.2f}, need ${notional:.2f}"
            )
    else:
        rules_checked.append("AVAILABLE_POSITION")
        held = portfolio.positions.get(proposal.symbol, Decimal("0"))
        if held < proposal.quantity:
            failed_rules.append("AVAILABLE_POSITION")
            reasons.append(
                f"Insufficient position in {proposal.symbol}:"
                f" have {held}, need {proposal.quantity}"
            )

    # Rule 8: MAX_POSITION_SIZE — BUY only
    if proposal.side == TradeSide.BUY:
        rules_checked.append("MAX_POSITION_SIZE")
        existing_qty = portfolio.positions.get(proposal.symbol, Decimal("0"))
        new_position_value = (existing_qty + proposal.quantity) * market.price
        if new_position_value > cfg.max_position_size_usd:
            failed_rules.append("MAX_POSITION_SIZE")
            reasons.append(
                f"Position value ${new_position_value:.2f} would exceed"
                f" limit ${cfg.max_position_size_usd}"
            )

    # Rule 9: MAX_PORTFOLIO_CONCENTRATION — BUY only, skip if equity is zero
    if proposal.side == TradeSide.BUY and portfolio.equity > Decimal("0"):
        rules_checked.append("MAX_PORTFOLIO_CONCENTRATION")
        existing_qty = portfolio.positions.get(proposal.symbol, Decimal("0"))
        new_position_value = (existing_qty + proposal.quantity) * market.price
        concentration_pct = new_position_value / portfolio.equity * Decimal("100")
        if concentration_pct > cfg.max_portfolio_concentration_pct:
            failed_rules.append("MAX_PORTFOLIO_CONCENTRATION")
            reasons.append(
                f"Portfolio concentration {concentration_pct:.4f}% would exceed"
                f" limit {cfg.max_portfolio_concentration_pct}%"
            )

    # Rule 10: MAX_OPEN_POSITIONS — BUY only, only when opening a new position
    if proposal.side == TradeSide.BUY:
        current_qty = portfolio.positions.get(proposal.symbol, Decimal("0"))
        if current_qty == Decimal("0"):
            rules_checked.append("MAX_OPEN_POSITIONS")
            open_count = sum(1 for qty in portfolio.positions.values() if qty > Decimal("0"))
            if open_count >= cfg.max_open_positions:
                failed_rules.append("MAX_OPEN_POSITIONS")
                reasons.append(
                    f"Already at maximum open positions:"
                    f" {open_count} of {cfg.max_open_positions}"
                )

    # Rule 11: MAX_DAILY_LOSS
    # Note: when this rule fails, the caller (Node API) should also disable the kill switch.
    rules_checked.append("MAX_DAILY_LOSS")
    if portfolio.daily_pnl < -cfg.max_daily_loss_usd:
        failed_rules.append("MAX_DAILY_LOSS")
        reasons.append(
            f"Daily loss ${abs(portfolio.daily_pnl):.2f} exceeds"
            f" limit ${cfg.max_daily_loss_usd}"
        )

    # Rule 12: DUPLICATE_EXPOSURE
    rules_checked.append("DUPLICATE_EXPOSURE")
    for pending in request.pending_proposals:
        if pending.symbol == proposal.symbol and pending.side == proposal.side:
            failed_rules.append("DUPLICATE_EXPOSURE")
            reasons.append(
                f"Pending {pending.side} proposal already exists for {pending.symbol}"
            )
            break

    # Rule 13: TRADING_SESSION — skipped when session bounds are not configured
    if cfg.trading_session_start is not None and cfg.trading_session_end is not None:
        rules_checked.append("TRADING_SESSION")
        current_time = now.time().replace(tzinfo=None)
        start = time.fromisoformat(cfg.trading_session_start)
        end = time.fromisoformat(cfg.trading_session_end)
        if start <= end:
            in_session = start <= current_time <= end
        else:
            # Overnight session (e.g., 22:00–02:00)
            in_session = current_time >= start or current_time <= end
        if not in_session:
            failed_rules.append("TRADING_SESSION")
            reasons.append(
                f"Outside trading session"
                f" {cfg.trading_session_start}–{cfg.trading_session_end} UTC"
            )

    # Rule 14: COOLDOWN — skipped when cooldown_between_trades_seconds == 0
    if cfg.cooldown_between_trades_seconds > 0:
        rules_checked.append("COOLDOWN")
        last_fill_iso = request.last_fill_times.get(proposal.symbol)
        if last_fill_iso is not None:
            last_fill = datetime.fromisoformat(last_fill_iso)
            elapsed = (now - last_fill).total_seconds()
            if elapsed < cfg.cooldown_between_trades_seconds:
                remaining = cfg.cooldown_between_trades_seconds - elapsed
                failed_rules.append("COOLDOWN")
                reasons.append(
                    f"Cooldown active for {proposal.symbol}:"
                    f" {remaining:.0f}s remaining"
                )

    outcome = RuleOutcome.REJECT if failed_rules else RuleOutcome.PASS
    return _build_result(outcome, request.stage, rules_checked, failed_rules, reasons, request, now)


def _build_result(
    outcome: RuleOutcome,
    stage: EvaluationStage,
    rules_checked: list[str],
    failed_rules: list[str],
    reasons: list[str],
    request: RiskEvaluationRequest,
    now: datetime,
) -> RiskResult:
    return RiskResult(
        result=outcome,
        stage=stage,
        rules_checked=rules_checked,
        failed_rules=failed_rules,
        reason="; ".join(reasons) if reasons else None,
        market_snapshot=request.market.model_dump(mode="json"),
        portfolio_snapshot=request.portfolio.model_dump(mode="json"),
        evaluated_at=now.isoformat(),
    )
