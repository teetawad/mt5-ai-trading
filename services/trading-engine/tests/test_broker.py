"""Unit and integration tests for the paper broker.

All tests run without a database or network connection.
"""

from datetime import UTC, datetime
from decimal import Decimal

import pytest

from broker.adapter import BrokerAdapter, OrderNotFoundError
from broker.paper_broker import PaperBrokerAdapter
from broker.types import (
    BrokerError,
    OrderRequest,
    OrderSide,
    OrderStatus,
    OrderType,
    PaperBrokerConfig,
)
from market_data.provider import MarketDataProvider, SymbolNotFoundError
from market_data.snapshot import MarketSnapshot

TEST_INTERNAL_TOKEN = "test-internal-token"


@pytest.fixture(autouse=True)
def _internal_service_token(monkeypatch):
    """Every HTTP-layer test needs INTERNAL_SERVICE_TOKEN set now that the
    dependency fails closed; individual token tests override this locally."""
    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", TEST_INTERNAL_TOKEN)


# ── Mock market data provider ─────────────────────────────────────────────────

class MockMarketDataProvider(MarketDataProvider):
    def __init__(self, prices: dict[str, Decimal] | None = None) -> None:
        self._prices: dict[str, Decimal] = prices or {"AAPL": Decimal("150.00")}

    def get_snapshot(self, symbol: str) -> MarketSnapshot:
        if symbol not in self._prices:
            raise SymbolNotFoundError(f"Unknown symbol: {symbol}")
        price = self._prices[symbol]
        return MarketSnapshot(
            symbol=symbol,
            price=price,
            bid=price * Decimal("0.999"),
            ask=price * Decimal("1.001"),
            volume=1000,
            timestamp=datetime.now(tz=UTC),
        )

    def get_all_snapshots(self) -> list[MarketSnapshot]:
        return [self.get_snapshot(s) for s in self._prices]

    def tracked_symbols(self) -> list[str]:
        return list(self._prices.keys())

    def set_price(self, symbol: str, price: Decimal) -> None:
        self._prices[symbol] = price


# ── Factory helpers ───────────────────────────────────────────────────────────

def _make_broker(
    prices: dict[str, Decimal] | None = None,
    initial_cash: Decimal = Decimal("100000.00"),
    simulation_mode: bool = True,
    config: PaperBrokerConfig | None = None,
) -> tuple[PaperBrokerAdapter, MockMarketDataProvider]:
    md = MockMarketDataProvider(prices)
    cfg = config or PaperBrokerConfig(
        random_seed=42,
        enable_partial_fills=False,
        enable_rejections=False,
    )
    broker = PaperBrokerAdapter(
        market_data=md,
        config=cfg,
        initial_cash=initial_cash,
        simulation_mode=simulation_mode,
    )
    return broker, md


def _req(
    symbol: str = "AAPL",
    side: OrderSide = OrderSide.BUY,
    quantity: Decimal = Decimal("10"),
    order_type: OrderType = OrderType.MARKET,
    limit_price: Decimal | None = None,
    idem_key: str = "k-1",
    bracket: dict[str, Decimal] | None = None,
    fractionable: bool = False,
    fee_bps: int | None = None,
) -> OrderRequest:
    return OrderRequest(
        idempotency_key=idem_key,
        symbol=symbol,
        side=side,
        quantity=quantity,
        order_type=order_type,
        limit_price=limit_price,
        bracket=bracket,
        fractionable=fractionable,
        fee_bps=fee_bps,
    )


# ── BrokerAdapter interface ───────────────────────────────────────────────────

class TestBrokerAdapterInterface:
    def test_paper_broker_is_broker_adapter(self):
        broker, _ = _make_broker()
        assert isinstance(broker, BrokerAdapter)

    def test_all_abstract_methods_implemented(self):
        broker, _ = _make_broker()
        assert callable(broker.submit_order)
        assert callable(broker.get_order)
        assert callable(broker.cancel_order)
        assert callable(broker.is_available)


# ── Market orders ─────────────────────────────────────────────────────────────

class TestMarketOrders:
    def test_market_buy_returns_filled(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(side=OrderSide.BUY, quantity=Decimal("10")))
        assert result.status == OrderStatus.FILLED
        assert len(result.fills) == 1

    def test_market_sell_returns_filled(self):
        broker, md = _make_broker(initial_cash=Decimal("200000.00"))
        # Buy first to get a position
        broker.submit_order(_req(side=OrderSide.BUY, quantity=Decimal("10"), idem_key="buy"))
        result = broker.submit_order(
            _req(side=OrderSide.SELL, quantity=Decimal("10"), idem_key="sell")
        )
        assert result.status == OrderStatus.FILLED
        assert len(result.fills) == 1

    def test_slippage_applied_to_buy(self):
        broker, _ = _make_broker(
            config=PaperBrokerConfig(
                slippage_bps=100,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            )
        )
        result = broker.submit_order(_req())
        fill_price = result.fills[0].price
        expected = Decimal("150.00") * Decimal("1.0100")
        assert fill_price > Decimal("150.00")
        assert abs(fill_price - expected) < Decimal("0.001")

    def test_slippage_applied_to_sell(self):
        broker, _ = _make_broker(
            initial_cash=Decimal("200000.00"),
            config=PaperBrokerConfig(
                slippage_bps=100,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            ),
        )
        broker.submit_order(_req(side=OrderSide.BUY, quantity=Decimal("10"), idem_key="buy"))
        result = broker.submit_order(
            _req(side=OrderSide.SELL, quantity=Decimal("10"), idem_key="sell")
        )
        fill_price = result.fills[0].price
        assert fill_price < Decimal("150.00")

    def test_fee_deducted_from_cash(self):
        broker, _ = _make_broker(
            config=PaperBrokerConfig(
                fee_per_share=Decimal("0.01"),
                min_fee=Decimal("0.00"),
                slippage_bps=0,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            )
        )
        broker.submit_order(_req(quantity=Decimal("100")))
        portfolio = broker.get_paper_portfolio()
        # cost = 100 * 150 + 100 * 0.01 = 15001
        assert portfolio.cash == Decimal("100000.00") - Decimal("15001.00")

    def test_min_fee_applied(self):
        broker, _ = _make_broker(
            config=PaperBrokerConfig(
                fee_per_share=Decimal("0.001"),
                min_fee=Decimal("5.00"),
                slippage_bps=0,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            )
        )
        # 1 share * 0.001 < min_fee 5.00 → min_fee used
        broker.submit_order(_req(quantity=Decimal("1")))
        portfolio = broker.get_paper_portfolio()
        # cost = 1 * 150 + 5.00 = 155.00
        portfolio_cost = Decimal("100000.00") - portfolio.cash
        assert portfolio_cost == Decimal("155.00")

    def test_fill_event_fields(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req())
        fill = result.fills[0]
        assert fill.order_id == result.broker_order_id
        assert fill.fill_id != ""
        assert fill.quantity == Decimal("10")
        assert fill.price > 0
        assert fill.fee > 0
        assert fill.is_partial is False
        assert fill.filled_at != ""

    def test_fill_serialises_decimals_as_strings(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req())
        data = result.model_dump()
        fill_data = data["fills"][0]
        assert isinstance(fill_data["quantity"], str)
        assert isinstance(fill_data["price"], str)
        assert isinstance(fill_data["fee"], str)


# ── Phase 26: fractional quantities and percentage fees ─────────────────────

class TestFractionalQuantityAndFeeBps:
    def test_fractionable_partial_fill_keeps_fractional_quantity(self):
        broker, _ = _make_broker(prices={"BTC/USD": Decimal("60000.00")})
        broker.inject_partial_fill("NEXT_ORDER", Decimal("0.12345678"))
        result = broker.submit_order(
            _req(symbol="BTC/USD", quantity=Decimal("1"), fractionable=True)
        )
        assert result.fills[0].is_partial is True
        assert result.fills[0].quantity == Decimal("0.12345678")

    def test_non_fractionable_partial_fill_rounds_to_whole_unit(self):
        broker, _ = _make_broker()
        broker.inject_partial_fill("NEXT_ORDER", Decimal("0.55"))
        result = broker.submit_order(_req(quantity=Decimal("10")))
        assert result.fills[0].quantity == Decimal("5")

    def test_fractionable_partial_fill_below_one_unit_still_fills(self):
        """A whole-unit rounding rule would zero out a sub-1-unit crypto
        partial fill; the fractionable path must not do that."""
        broker, _ = _make_broker(prices={"BTC/USD": Decimal("60000.00")})
        broker.inject_partial_fill("NEXT_ORDER", Decimal("0.4"))
        result = broker.submit_order(
            _req(symbol="BTC/USD", quantity=Decimal("0.01"), fractionable=True)
        )
        assert result.fills[0].is_partial is True
        assert result.fills[0].quantity == Decimal("0.00400000")

    def test_fee_bps_computes_percentage_of_notional(self):
        broker, _ = _make_broker(
            prices={"BTC/USD": Decimal("60000.00")},
            config=PaperBrokerConfig(
                slippage_bps=0,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            ),
        )
        result = broker.submit_order(
            _req(symbol="BTC/USD", quantity=Decimal("0.1"), fee_bps=10, fractionable=True)
        )
        # fee = 0.1 * 60000 * 10/10000 = 6.00
        assert result.fills[0].fee == Decimal("6.00000000")

    def test_fee_bps_overrides_flat_per_share_fee(self):
        broker, _ = _make_broker(
            prices={"BTC/USD": Decimal("60000.00")},
            config=PaperBrokerConfig(
                fee_per_share=Decimal("0.005"),
                min_fee=Decimal("1.00"),
                slippage_bps=0,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            ),
        )
        result = broker.submit_order(
            _req(symbol="BTC/USD", quantity=Decimal("0.001"), fee_bps=10, fractionable=True)
        )
        # fee_bps result (0.001 * 60000 * 10/10000 = 0.06) is used, not the
        # $1.00 flat min_fee the per-share model would otherwise apply.
        assert result.fills[0].fee == Decimal("0.06000000")

    def test_bracket_exit_reuses_entry_fee_bps(self):
        broker, md = _make_broker(
            prices={"BTC/USD": Decimal("60000.00")},
            initial_cash=Decimal("100000.00"),
            config=PaperBrokerConfig(
                slippage_bps=0,
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            ),
        )
        entry = broker.submit_order(
            _req(
                symbol="BTC/USD",
                quantity=Decimal("0.1"),
                fractionable=True,
                fee_bps=10,
                bracket={
                    "stop_loss_price": Decimal("59000.00"),
                    "take_profit_price": Decimal("61000.00"),
                },
                idem_key="entry",
            )
        )
        assert entry.bracket_order_ids is not None
        md.set_price("BTC/USD", Decimal("61500.00"))
        filled = broker.check_pending_orders("BTC/USD", Decimal("61500.00"))
        assert len(filled) == 1
        exit_fill = filled[0].fills[0]
        # fee = 0.1 * fill_price * 10/10000 — percentage, not the $1 flat min_fee
        expected_fee = (
            Decimal("0.1") * exit_fill.price * Decimal("10") / Decimal("10000")
        ).quantize(Decimal("0.00000001"))
        assert exit_fill.fee == expected_fee


# ── Insufficient funds / position ─────────────────────────────────────────────

class TestFundsAndPositionChecks:
    def test_insufficient_funds_rejects_buy(self):
        broker, _ = _make_broker(initial_cash=Decimal("1.00"))
        result = broker.submit_order(_req(side=OrderSide.BUY, quantity=Decimal("10")))
        assert result.status == OrderStatus.REJECTED
        assert result.rejected_reason is not None
        assert "funds" in result.rejected_reason.lower()

    def test_insufficient_position_rejects_sell(self):
        broker, _ = _make_broker()
        result = broker.submit_order(
            _req(side=OrderSide.SELL, quantity=Decimal("10"), idem_key="sell")
        )
        assert result.status == OrderStatus.REJECTED
        assert result.rejected_reason is not None
        assert "position" in result.rejected_reason.lower()

    def test_cash_updated_after_buy(self):
        broker, _ = _make_broker(
            config=PaperBrokerConfig(
                slippage_bps=0,
                fee_per_share=Decimal("0.00"),
                min_fee=Decimal("0.00"),
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            )
        )
        broker.submit_order(_req(quantity=Decimal("10")))
        portfolio = broker.get_paper_portfolio()
        assert portfolio.cash == Decimal("100000.00") - Decimal("1500.00")

    def test_position_updated_after_buy(self):
        broker, _ = _make_broker()
        broker.submit_order(_req(quantity=Decimal("10")))
        portfolio = broker.get_paper_portfolio()
        assert portfolio.positions.get("AAPL", Decimal("0")) == Decimal("10")

    def test_cash_and_position_updated_after_sell(self):
        broker, _ = _make_broker(
            initial_cash=Decimal("200000.00"),
            config=PaperBrokerConfig(
                slippage_bps=0,
                fee_per_share=Decimal("0.00"),
                min_fee=Decimal("0.00"),
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            ),
        )
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="buy"))
        broker.submit_order(
            _req(side=OrderSide.SELL, quantity=Decimal("10"), idem_key="sell")
        )
        portfolio = broker.get_paper_portfolio()
        assert portfolio.positions.get("AAPL", Decimal("0")) == Decimal("0")
        assert portfolio.cash == Decimal("200000.00")  # net zero (no fees/slippage)


# ── Idempotency ───────────────────────────────────────────────────────────────

class TestIdempotency:
    def test_same_key_returns_same_result(self):
        broker, _ = _make_broker()
        r1 = broker.submit_order(_req(idem_key="dup"))
        r2 = broker.submit_order(_req(idem_key="dup"))
        assert r1.broker_order_id == r2.broker_order_id
        assert r1.status == r2.status

    def test_idempotency_does_not_double_fill(self):
        broker, _ = _make_broker(
            config=PaperBrokerConfig(
                slippage_bps=0,
                fee_per_share=Decimal("0.00"),
                min_fee=Decimal("0.00"),
                random_seed=42,
                enable_partial_fills=False,
                enable_rejections=False,
            )
        )
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="dup"))
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="dup"))
        portfolio = broker.get_paper_portfolio()
        assert portfolio.positions.get("AAPL", Decimal("0")) == Decimal("10")

    def test_rejection_idempotent(self):
        broker, _ = _make_broker(initial_cash=Decimal("1.00"))
        r1 = broker.submit_order(_req(idem_key="rej"))
        r2 = broker.submit_order(_req(idem_key="rej"))
        assert r1.broker_order_id == r2.broker_order_id
        assert r1.status == OrderStatus.REJECTED


# ── Partial fill simulation ───────────────────────────────────────────────────

class TestPartialFills:
    def test_inject_partial_fill(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_partial_fill("NEXT_ORDER", Decimal("0.5"))
        result = broker.submit_order(_req(quantity=Decimal("10")))
        assert result.status == OrderStatus.PARTIALLY_FILLED
        assert result.fills[0].is_partial is True
        assert result.fills[0].quantity == Decimal("5")

    def test_injection_consumed_once(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_partial_fill("NEXT_ORDER", Decimal("0.5"))
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="p"))
        result2 = broker.submit_order(_req(quantity=Decimal("10"), idem_key="p2"))
        assert result2.status == OrderStatus.FILLED

    def test_partial_fill_injection_requires_simulation_mode(self):
        broker, _ = _make_broker(simulation_mode=False)
        with pytest.raises(RuntimeError, match="simulation_mode"):
            broker.inject_partial_fill("x", Decimal("0.5"))


# ── Rejection simulation ──────────────────────────────────────────────────────

class TestRejectionSimulation:
    def test_inject_rejection(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_rejection("NEXT_ORDER", "Symbol not tradeable")
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.REJECTED
        assert result.rejected_reason == "Symbol not tradeable"

    def test_inject_rejection_requires_simulation_mode(self):
        broker, _ = _make_broker(simulation_mode=False)
        with pytest.raises(RuntimeError, match="simulation_mode"):
            broker.inject_rejection("x", "reason")

    def test_inject_error_insufficient_funds(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_error("NEXT_ORDER", BrokerError.INSUFFICIENT_FUNDS)
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.REJECTED
        assert "funds" in (result.rejected_reason or "").lower()

    def test_inject_error_insufficient_position(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_error("NEXT_ORDER", BrokerError.INSUFFICIENT_POSITION)
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.REJECTED
        assert "position" in (result.rejected_reason or "").lower()

    def test_inject_error_unknown_returns_error_status(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_error("NEXT_ORDER", BrokerError.UNAVAILABLE)
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.ERROR

    def test_inject_error_requires_simulation_mode(self):
        broker, _ = _make_broker(simulation_mode=False)
        with pytest.raises(RuntimeError, match="simulation_mode"):
            broker.inject_error("x", BrokerError.INSUFFICIENT_FUNDS)


# ── Unavailability ────────────────────────────────────────────────────────────

class TestUnavailability:
    def test_is_available_true_by_default(self):
        broker, _ = _make_broker()
        assert broker.is_available() is True

    def test_inject_unavailable_makes_broker_unavailable(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_unavailable(duration_seconds=9999)
        assert broker.is_available() is False

    def test_unavailable_broker_returns_error_result(self):
        broker, _ = _make_broker(simulation_mode=True)
        broker.inject_unavailable(duration_seconds=9999)
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.ERROR
        assert result.error_message is not None

    def test_inject_unavailable_requires_simulation_mode(self):
        broker, _ = _make_broker(simulation_mode=False)
        with pytest.raises(RuntimeError, match="simulation_mode"):
            broker.inject_unavailable(duration_seconds=5)


# ── Unknown symbol ────────────────────────────────────────────────────────────

class TestUnknownSymbol:
    def test_unknown_symbol_rejected(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(symbol="ZZZZZ"))
        assert result.status == OrderStatus.REJECTED
        assert result.rejected_reason is not None
        assert "ZZZZZ" in result.rejected_reason


# ── Limit orders ──────────────────────────────────────────────────────────────

class TestLimitOrders:
    def test_limit_buy_fills_immediately_when_limit_gte_market(self):
        broker, _ = _make_broker()  # AAPL at 150
        result = broker.submit_order(
            _req(
                order_type=OrderType.LIMIT,
                limit_price=Decimal("155.00"),  # above market → immediate fill
            )
        )
        assert result.status == OrderStatus.FILLED
        assert result.fills[0].price == Decimal("155.00")

    def test_limit_sell_fills_immediately_when_limit_lte_market(self):
        broker, _ = _make_broker(initial_cash=Decimal("200000.00"))
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="buy"))
        result = broker.submit_order(
            _req(
                side=OrderSide.SELL,
                order_type=OrderType.LIMIT,
                limit_price=Decimal("145.00"),  # below market → immediate fill
                idem_key="sell",
            )
        )
        assert result.status == OrderStatus.FILLED

    def test_limit_buy_queued_when_limit_lt_market(self):
        broker, _ = _make_broker()  # AAPL at 150
        result = broker.submit_order(
            _req(
                order_type=OrderType.LIMIT,
                limit_price=Decimal("140.00"),  # below market → queued
            )
        )
        assert result.status == OrderStatus.SUBMITTED
        assert result.fills == []

    def test_limit_sell_queued_when_limit_gt_market(self):
        broker, _ = _make_broker(initial_cash=Decimal("200000.00"))
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="buy"))
        result = broker.submit_order(
            _req(
                side=OrderSide.SELL,
                order_type=OrderType.LIMIT,
                limit_price=Decimal("160.00"),  # above market → queued
                idem_key="sell",
            )
        )
        assert result.status == OrderStatus.SUBMITTED

    def test_queued_limit_fills_on_price_cross_via_get_order(self):
        broker, md = _make_broker()  # AAPL at 150
        result = broker.submit_order(
            _req(order_type=OrderType.LIMIT, limit_price=Decimal("140.00"))
        )
        assert result.status == OrderStatus.SUBMITTED
        md.set_price("AAPL", Decimal("138.00"))  # price dropped below limit
        updated = broker.get_order(result.broker_order_id)
        assert updated.status == OrderStatus.FILLED

    def test_queued_limit_fills_via_check_pending_orders(self):
        broker, _ = _make_broker()  # AAPL at 150
        result = broker.submit_order(
            _req(order_type=OrderType.LIMIT, limit_price=Decimal("140.00"))
        )
        assert result.status == OrderStatus.SUBMITTED
        filled = broker.check_pending_orders("AAPL", Decimal("138.00"))
        assert len(filled) == 1
        assert filled[0].status == OrderStatus.FILLED

    def test_limit_order_missing_price_rejected(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(order_type=OrderType.LIMIT, limit_price=None))
        assert result.status == OrderStatus.REJECTED
        assert "Limit price required" in (result.rejected_reason or "")

    def test_check_pending_orders_only_matches_symbol(self):
        broker, _ = _make_broker(prices={"AAPL": Decimal("150"), "MSFT": Decimal("300")})
        broker.submit_order(
            _req(
                symbol="AAPL",
                order_type=OrderType.LIMIT,
                limit_price=Decimal("140.00"),
                idem_key="aapl",
            )
        )
        filled = broker.check_pending_orders("MSFT", Decimal("100.00"))
        assert len(filled) == 0


# ── Bracket orders (stop-loss / take-profit) ──────────────────────────────────

class TestBracketOrders:
    def _bracket(self, stop_loss="140.00", take_profit="160.00"):
        return {
            "stop_loss_price": Decimal(stop_loss),
            "take_profit_price": Decimal(take_profit),
        }

    def test_bracket_entry_fills_and_registers_pending_exit_legs(self):
        broker, _ = _make_broker()  # AAPL at 150
        result = broker.submit_order(_req(bracket=self._bracket()))

        assert result.status == OrderStatus.FILLED
        assert result.bracket_order_ids is not None
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]
        assert tp_id != sl_id
        assert broker.get_order(tp_id).status == OrderStatus.PENDING
        assert broker.get_order(sl_id).status == OrderStatus.PENDING

    def test_bracket_pending_legs_appear_in_open_orders(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        open_ids = {order.broker_order_id for order in broker.get_open_orders()}

        assert result.bracket_order_ids["take_profit"] in open_ids
        assert result.bracket_order_ids["stop_loss"] in open_ids
        assert result.broker_order_id not in open_ids  # entry itself is already FILLED

    def test_take_profit_fills_and_cancels_stop_loss_via_get_order(self):
        broker, md = _make_broker()  # AAPL at 150
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]

        md.set_price("AAPL", Decimal("165.00"))
        updated_tp = broker.get_order(tp_id)
        updated_sl = broker.get_order(sl_id)

        assert updated_tp.status == OrderStatus.FILLED
        assert updated_sl.status == OrderStatus.CANCELLED
        assert len(updated_tp.fills) == 1
        # slippage_bps default = 5 (0.05%): 165.00 * (1 - 0.0005)
        assert updated_tp.fills[0].price == Decimal("164.91750000")
        assert updated_tp.fills[0].fee == Decimal("1.00000000")
        assert broker.get_paper_portfolio().positions.get("AAPL", Decimal("0")) == Decimal("0")

    def test_stop_loss_fills_and_cancels_take_profit_via_get_order(self):
        broker, md = _make_broker()  # AAPL at 150
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]

        md.set_price("AAPL", Decimal("130.00"))
        updated_sl = broker.get_order(sl_id)
        updated_tp = broker.get_order(tp_id)

        assert updated_sl.status == OrderStatus.FILLED
        assert updated_tp.status == OrderStatus.CANCELLED
        assert len(updated_sl.fills) == 1
        assert updated_sl.fills[0].price == Decimal("129.93500000")
        assert broker.get_paper_portfolio().positions.get("AAPL", Decimal("0")) == Decimal("0")

    def test_bracket_leg_fills_via_check_pending_orders(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))

        filled = broker.check_pending_orders("AAPL", Decimal("165.00"))

        assert len(filled) == 1
        assert filled[0].broker_order_id == result.bracket_order_ids["take_profit"]
        assert filled[0].status == OrderStatus.FILLED

    def test_bracket_leg_fills_via_get_open_orders(self):
        broker, md = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        md.set_price("AAPL", Decimal("165.00"))

        open_ids = {order.broker_order_id for order in broker.get_open_orders()}

        assert result.bracket_order_ids["take_profit"] not in open_ids
        assert result.bracket_order_ids["stop_loss"] not in open_ids

    def test_bracket_not_triggered_while_price_stays_between_legs(self):
        broker, md = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        md.set_price("AAPL", Decimal("152.00"))

        tp = broker.get_order(result.bracket_order_ids["take_profit"])
        sl = broker.get_order(result.bracket_order_ids["stop_loss"])
        assert tp.status == OrderStatus.PENDING
        assert sl.status == OrderStatus.PENDING

    def test_cancel_order_on_take_profit_leg_cancels_whole_bracket(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]

        cancelled = broker.cancel_order(tp_id)

        assert cancelled.status == OrderStatus.CANCELLED
        assert broker.get_order(sl_id).status == OrderStatus.CANCELLED

    def test_cancel_order_on_stop_loss_leg_cancels_whole_bracket(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]

        cancelled = broker.cancel_order(sl_id)

        assert cancelled.status == OrderStatus.CANCELLED
        assert broker.get_order(tp_id).status == OrderStatus.CANCELLED

    def test_cancelled_bracket_does_not_phantom_fill_on_later_price_cross(self):
        """Regression test (Phase 25): a bracket cancelled out-of-band (e.g. a
        manual/time-based position close) must never let a later price cross
        still fill a leg — that would apply a second, unchecked exit fill on
        top of a position that was already closed some other way."""
        broker, _ = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]

        broker.cancel_order(tp_id)
        # Manually flatten the position out-of-band, as a time-based/EOD exit would.
        broker.submit_order(_req(side=OrderSide.SELL, idem_key="manual-exit"))
        cash_after_manual_exit = broker.get_paper_portfolio().cash

        # A price cross that would have triggered the take-profit leg must be a no-op.
        filled = broker.check_pending_orders("AAPL", Decimal("165.00"))

        assert filled == []
        assert broker.get_paper_portfolio().positions.get("AAPL", Decimal("0")) == Decimal("0")
        assert broker.get_paper_portfolio().cash == cash_after_manual_exit

    def test_cancel_order_on_already_filled_leg_is_a_no_op(self):
        broker, md = _make_broker()
        result = broker.submit_order(_req(bracket=self._bracket()))
        tp_id = result.bracket_order_ids["take_profit"]
        sl_id = result.bracket_order_ids["stop_loss"]
        md.set_price("AAPL", Decimal("165.00"))
        broker.get_order(tp_id)  # lazily fills take-profit, cancels stop-loss

        cancelled_again = broker.cancel_order(tp_id)

        assert cancelled_again.status == OrderStatus.FILLED
        assert broker.get_order(sl_id).status == OrderStatus.CANCELLED

    def test_bracket_only_registered_for_buy_entries(self):
        broker, _ = _make_broker(initial_cash=Decimal("200000.00"))
        broker.submit_order(_req(quantity=Decimal("10"), idem_key="buy-first"))
        result = broker.submit_order(
            _req(
                side=OrderSide.SELL,
                quantity=Decimal("10"),
                idem_key="sell-with-bracket",
                bracket=self._bracket(),
            )
        )
        assert result.status == OrderStatus.FILLED
        assert result.bracket_order_ids is None


# ── Order cancellation ────────────────────────────────────────────────────────

class TestOrderCancellation:
    def test_cancel_pending_limit_order(self):
        broker, _ = _make_broker()
        result = broker.submit_order(
            _req(order_type=OrderType.LIMIT, limit_price=Decimal("140.00"))
        )
        assert result.status == OrderStatus.SUBMITTED
        cancelled = broker.cancel_order(result.broker_order_id)
        assert cancelled.status == OrderStatus.CANCELLED

    def test_cancel_filled_order_is_noop(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req())
        assert result.status == OrderStatus.FILLED
        noop = broker.cancel_order(result.broker_order_id)
        assert noop.status == OrderStatus.FILLED

    def test_cancel_cancelled_order_is_noop(self):
        broker, _ = _make_broker()
        result = broker.submit_order(
            _req(order_type=OrderType.LIMIT, limit_price=Decimal("140.00"))
        )
        broker.cancel_order(result.broker_order_id)
        noop = broker.cancel_order(result.broker_order_id)
        assert noop.status == OrderStatus.CANCELLED

    def test_cancel_unknown_order_raises(self):
        broker, _ = _make_broker()
        with pytest.raises(OrderNotFoundError):
            broker.cancel_order("nonexistent-id")

    def test_cancelled_order_not_filled_on_price_cross(self):
        broker, md = _make_broker()
        result = broker.submit_order(
            _req(order_type=OrderType.LIMIT, limit_price=Decimal("140.00"))
        )
        broker.cancel_order(result.broker_order_id)
        md.set_price("AAPL", Decimal("130.00"))
        # check_pending_orders should not fill a cancelled order
        filled = broker.check_pending_orders("AAPL", Decimal("130.00"))
        assert len(filled) == 0


# ── get_order ─────────────────────────────────────────────────────────────────

class TestGetOrder:
    def test_get_order_returns_result(self):
        broker, _ = _make_broker()
        result = broker.submit_order(_req())
        fetched = broker.get_order(result.broker_order_id)
        assert fetched.broker_order_id == result.broker_order_id

    def test_get_order_not_found_raises(self):
        broker, _ = _make_broker()
        with pytest.raises(OrderNotFoundError):
            broker.get_order("nonexistent")


# ── Paper portfolio ───────────────────────────────────────────────────────────

class TestPaperPortfolio:
    def test_initial_cash(self):
        broker, _ = _make_broker(initial_cash=Decimal("50000.00"))
        p = broker.get_paper_portfolio()
        assert p.cash == Decimal("50000.00")
        assert p.positions == {}

    def test_portfolio_serialises_decimals_as_strings(self):
        broker, _ = _make_broker()
        broker.submit_order(_req())
        data = broker.get_paper_portfolio().model_dump()
        assert isinstance(data["cash"], str)
        assert isinstance(list(data["positions"].values())[0], str)

    def test_portfolio_reflects_fills(self):
        broker, _ = _make_broker()
        broker.submit_order(_req(quantity=Decimal("5"), idem_key="b1"))
        broker.submit_order(_req(quantity=Decimal("3"), idem_key="b2"))
        p = broker.get_paper_portfolio()
        assert p.positions.get("AAPL", Decimal("0")) == Decimal("8")


# ── FastAPI endpoint integration ──────────────────────────────────────────────

class TestBrokerEndpoints:
    @pytest.fixture(autouse=True)
    def setup_broker(self):
        from broker.registry import init_broker
        from market_data.registry import init_provider
        from market_data.synthetic import SyntheticMarketDataProvider

        init_provider(
            SyntheticMarketDataProvider(
                symbols={"AAPL": Decimal("150.00")},
                tick_interval_seconds=9999,
                random_seed=42,
            )
        )
        broker, _ = _make_broker(simulation_mode=True)
        init_broker(broker)
        self._broker = broker

    def test_submit_order_returns_200(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post(
            "/broker/orders",
            json={
                "idempotency_key": "e2e-1",
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "10",
                "order_type": "MARKET",
            },
        )
        assert res.status_code == 200
        data = res.json()
        assert data["status"] == "FILLED"
        assert len(data["fills"]) == 1

    def test_get_order_returns_200(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        post_res = client.post(
            "/broker/orders",
            json={
                "idempotency_key": "e2e-2",
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "10",
                "order_type": "MARKET",
            },
        )
        order_id = post_res.json()["broker_order_id"]
        get_res = client.get(f"/broker/orders/{order_id}")
        assert get_res.status_code == 200
        assert get_res.json()["broker_order_id"] == order_id

    def test_get_order_404_for_unknown(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/orders/nonexistent-id")
        assert res.status_code == 404

    def test_cancel_order_returns_200(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        post_res = client.post(
            "/broker/orders",
            json={
                "idempotency_key": "e2e-limit",
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "5",
                "order_type": "LIMIT",
                "limit_price": "50.00",  # far below market → queued
            },
        )
        order_id = post_res.json()["broker_order_id"]
        cancel_res = client.post(f"/broker/orders/{order_id}/cancel")
        assert cancel_res.status_code == 200
        assert cancel_res.json()["status"] == "CANCELLED"

    def test_cancel_order_404_for_unknown(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.post("/broker/orders/nonexistent-id/cancel")
        assert res.status_code == 404

    def test_broker_health_returns_available(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/health")
        assert res.status_code == 200
        assert res.json()["available"] is True
        assert res.json()["provider"] == "local_paper"
        assert res.json()["trading_mode"] == "PAPER"

    def test_broker_health_unavailable_when_injected(self):
        from fastapi.testclient import TestClient

        from main import app

        self._broker.inject_unavailable(duration_seconds=9999)
        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/health")
        assert res.status_code == 200
        assert res.json()["available"] is False
        assert res.json()["trading_mode"] == "PAPER"

    def test_paper_portfolio_returns_200(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/paper-portfolio")
        assert res.status_code == 200
        data = res.json()
        assert "cash" in data
        assert "positions" in data

    def test_paper_account_returns_cash_and_buying_power(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/paper-account")
        assert res.status_code == 200
        data = res.json()
        assert data["cash"] == "100000.00000000"
        assert data["buying_power"] == "100000.00000000"

    def test_open_orders_returns_pending_paper_orders(self):
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        post_res = client.post(
            "/broker/orders",
            json={
                "idempotency_key": "e2e-open-limit",
                "symbol": "AAPL",
                "side": "BUY",
                "quantity": "5",
                "order_type": "LIMIT",
                "limit_price": "50.00",
            },
        )
        assert post_res.status_code == 200

        res = client.get("/broker/open-orders")
        assert res.status_code == 200
        assert res.json()[0]["status"] == "SUBMITTED"

    def test_internal_token_rejected_when_set(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret")
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/health")
        assert res.status_code == 403

    def test_internal_token_accepted(self, monkeypatch):
        monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "secret")
        from fastapi.testclient import TestClient

        from main import app

        client = TestClient(app, headers={"X-Internal-Token": TEST_INTERNAL_TOKEN})
        res = client.get("/broker/health", headers={"X-Internal-Token": "secret"})
        assert res.status_code == 200
