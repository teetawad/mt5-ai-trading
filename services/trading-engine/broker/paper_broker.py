import random
import threading
import uuid
from collections import deque
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from decimal import ROUND_DOWN, Decimal

from broker.adapter import BrokerAdapter, OrderNotFoundError
from broker.types import (
    BrokerError,
    FillEvent,
    OrderRequest,
    OrderResult,
    OrderSide,
    OrderStatus,
    OrderType,
    PaperBrokerConfig,
    PaperPortfolio,
)
from market_data.provider import MarketDataProvider, SymbolNotFoundError


@dataclass
class _BracketLegs:
    """Tracks the two virtual exit legs of a bracket order (BUY entries only).

    Evaluated lazily — mirrors the existing pending-limit-order pattern — on
    every get_order/get_open_orders/check_pending_orders call rather than via
    a background scheduler, since none exists in this service.
    """

    symbol: str
    quantity: Decimal
    stop_loss_price: Decimal
    take_profit_price: Decimal
    take_profit_id: str
    stop_loss_id: str


class PaperBrokerAdapter(BrokerAdapter):
    def __init__(
        self,
        market_data: MarketDataProvider,
        config: PaperBrokerConfig | None = None,
        initial_cash: Decimal = Decimal("100000.00"),
        simulation_mode: bool = False,
    ) -> None:
        self._config = config or PaperBrokerConfig()
        self._market_data = market_data
        self._simulation_mode = simulation_mode
        self._lock = threading.Lock()
        self._rng = random.Random(self._config.random_seed)

        self._orders: dict[str, OrderResult] = {}
        self._idempotency_index: dict[str, str] = {}
        self._pending_limit_orders: dict[str, OrderRequest] = {}
        self._pending_brackets: dict[str, _BracketLegs] = {}
        self._bracket_leg_parent: dict[str, str] = {}
        self._paper_cash: Decimal = initial_cash
        self._paper_positions: dict[str, Decimal] = {}

        self._unavailable_until: datetime | None = None
        self._injected_errors: deque[BrokerError] = deque()
        self._injected_partials: deque[Decimal] = deque()
        self._injected_rejections: deque[str] = deque()

    # ── Availability ──────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        if self._unavailable_until is not None:
            if datetime.now(tz=UTC) < self._unavailable_until:
                return False
            self._unavailable_until = None
        return True

    # ── Error injection (simulation_mode only) ────────────────────────────────

    def inject_error(self, _scope: str, error: BrokerError) -> None:
        self._require_simulation()
        self._injected_errors.append(error)

    def inject_partial_fill(self, _scope: str, fill_fraction: Decimal) -> None:
        self._require_simulation()
        self._injected_partials.append(fill_fraction)

    def inject_rejection(self, _scope: str, reason: str) -> None:
        self._require_simulation()
        self._injected_rejections.append(reason)

    def inject_unavailable(self, duration_seconds: float) -> None:
        self._require_simulation()
        self._unavailable_until = datetime.now(tz=UTC) + timedelta(
            seconds=duration_seconds
        )

    def _require_simulation(self) -> None:
        if not self._simulation_mode:
            raise RuntimeError("Injection methods require simulation_mode=True")

    # ── Public broker interface ───────────────────────────────────────────────

    def submit_order(self, request: OrderRequest) -> OrderResult:
        if not self.is_available():
            return OrderResult(
                broker_order_id=str(uuid.uuid4()),
                status=OrderStatus.ERROR,
                fills=[],
                error_message="Broker unavailable",
            )

        # Fast idempotency check before the market-data I/O
        with self._lock:
            if request.idempotency_key in self._idempotency_index:
                return self._orders[self._idempotency_index[request.idempotency_key]]

        # Fetch price outside lock to avoid holding lock during I/O
        try:
            snapshot = self._market_data.get_snapshot(request.symbol)
            current_price = snapshot.price
        except SymbolNotFoundError:
            broker_order_id = str(uuid.uuid4())
            result = OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason=f"Unknown symbol: {request.symbol}",
            )
            with self._lock:
                self._store(request.idempotency_key, broker_order_id, result)
            return result

        with self._lock:
            # Re-check idempotency in case of concurrent submission
            if request.idempotency_key in self._idempotency_index:
                return self._orders[self._idempotency_index[request.idempotency_key]]

            broker_order_id = str(uuid.uuid4())

            if self._simulation_mode and self._injected_errors:
                result = self._make_error_result(
                    broker_order_id, self._injected_errors.popleft()
                )
                self._store(request.idempotency_key, broker_order_id, result)
                return result

            if self._simulation_mode and self._injected_rejections:
                result = OrderResult(
                    broker_order_id=broker_order_id,
                    status=OrderStatus.REJECTED,
                    fills=[],
                    rejected_reason=self._injected_rejections.popleft(),
                )
                self._store(request.idempotency_key, broker_order_id, result)
                return result

            # Probabilistic rejection only when NOT deterministic (no fixed seed)
            if (
                self._config.enable_rejections
                and self._config.random_seed is None
                and self._rng.random() < self._config.rejection_probability
            ):
                result = OrderResult(
                    broker_order_id=broker_order_id,
                    status=OrderStatus.REJECTED,
                    fills=[],
                    rejected_reason="Simulated random rejection",
                )
                self._store(request.idempotency_key, broker_order_id, result)
                return result

            if request.order_type == OrderType.MARKET:
                result = self._execute_market(broker_order_id, request, current_price)
                if (
                    request.bracket is not None
                    and request.side == OrderSide.BUY
                    and result.status == OrderStatus.FILLED
                ):
                    result = self._register_bracket(broker_order_id, request, result)
            else:
                result = self._handle_limit(broker_order_id, request, current_price)

            self._store(request.idempotency_key, broker_order_id, result)
            return result

    def get_order(self, broker_order_id: str) -> OrderResult:
        with self._lock:
            if broker_order_id not in self._orders:
                raise OrderNotFoundError(f"Order not found: {broker_order_id}")
            if broker_order_id in self._pending_limit_orders:
                self._lazy_fill_limit(broker_order_id)
            parent_id = self._bracket_leg_parent.get(broker_order_id)
            if parent_id is not None:
                self._evaluate_bracket(parent_id)
            return self._orders[broker_order_id]

    def cancel_order(self, broker_order_id: str) -> OrderResult:
        with self._lock:
            if broker_order_id not in self._orders:
                raise OrderNotFoundError(f"Order not found: {broker_order_id}")
            current = self._orders[broker_order_id]
            if current.status in (
                OrderStatus.FILLED,
                OrderStatus.CANCELLED,
                OrderStatus.REJECTED,
                OrderStatus.ERROR,
            ):
                return current
            cancelled = OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.CANCELLED,
                fills=current.fills,
            )
            self._orders[broker_order_id] = cancelled
            self._pending_limit_orders.pop(broker_order_id, None)
            return cancelled

    def get_paper_portfolio(self) -> PaperPortfolio:
        with self._lock:
            return PaperPortfolio(
                cash=self._paper_cash,
                positions=dict(self._paper_positions),
            )

    def get_open_orders(self) -> list[OrderResult]:
        with self._lock:
            for parent_id in list(self._pending_brackets.keys()):
                self._evaluate_bracket(parent_id)
            return [
                order
                for order in self._orders.values()
                if order.status
                in {
                    OrderStatus.PENDING,
                    OrderStatus.SUBMITTED,
                    OrderStatus.PARTIALLY_FILLED,
                }
            ]

    def check_pending_orders(
        self, symbol: str, current_price: Decimal
    ) -> list[OrderResult]:
        """Evaluate pending limit orders and bracket exit legs for a symbol
        against current_price.

        Returns a list of OrderResults for any orders that were filled.
        """
        filled: list[OrderResult] = []
        with self._lock:
            pending_ids = [
                oid
                for oid, req in list(self._pending_limit_orders.items())
                if req.symbol == symbol
            ]
            for oid in pending_ids:
                if oid not in self._pending_limit_orders:
                    continue
                req = self._pending_limit_orders[oid]
                limit_price = req.limit_price
                if limit_price is None:
                    continue
                if self._price_crosses(req.side, limit_price, current_price):
                    result = self._fill_at_price(oid, req, limit_price)
                    self._orders[oid] = result
                    del self._pending_limit_orders[oid]
                    filled.append(result)

            bracket_parent_ids = [
                parent_id
                for parent_id, bracket in list(self._pending_brackets.items())
                if bracket.symbol == symbol
            ]
            for parent_id in bracket_parent_ids:
                bracket_result = self._evaluate_bracket(parent_id, price=current_price)
                if bracket_result is not None:
                    filled.append(bracket_result)
        return filled

    # ── Private helpers ───────────────────────────────────────────────────────

    def _execute_market(
        self, broker_order_id: str, request: OrderRequest, current_price: Decimal
    ) -> OrderResult:
        slippage = Decimal(self._config.slippage_bps) / Decimal("10000")
        fill_price = (
            current_price * (1 + slippage)
            if request.side == OrderSide.BUY
            else current_price * (1 - slippage)
        ).quantize(Decimal("0.00000001"))

        fill_qty, is_partial = self._resolve_quantity(request.quantity)

        fee = max(
            fill_qty * self._config.fee_per_share,
            self._config.min_fee,
        ).quantize(Decimal("0.00000001"))

        rejection = self._check_funds(request, fill_qty, fill_price, fee)
        if rejection:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason=rejection,
            )

        self._apply_fill(request, fill_qty, fill_price, fee)
        fill = FillEvent(
            order_id=broker_order_id,
            fill_id=str(uuid.uuid4()),
            quantity=fill_qty,
            price=fill_price,
            fee=fee,
            is_partial=is_partial,
            filled_at=datetime.now(tz=UTC).isoformat(),
        )
        return OrderResult(
            broker_order_id=broker_order_id,
            status=OrderStatus.PARTIALLY_FILLED if is_partial else OrderStatus.FILLED,
            fills=[fill],
        )

    def _handle_limit(
        self, broker_order_id: str, request: OrderRequest, current_price: Decimal
    ) -> OrderResult:
        limit_price = request.limit_price
        if limit_price is None:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason="Limit price required for LIMIT orders",
            )

        if self._price_crosses(request.side, limit_price, current_price):
            return self._fill_at_price(broker_order_id, request, limit_price)

        result = OrderResult(
            broker_order_id=broker_order_id,
            status=OrderStatus.SUBMITTED,
            fills=[],
        )
        self._pending_limit_orders[broker_order_id] = request
        return result

    def _fill_at_price(
        self, broker_order_id: str, request: OrderRequest, fill_price: Decimal
    ) -> OrderResult:
        fee = max(
            request.quantity * self._config.fee_per_share,
            self._config.min_fee,
        ).quantize(Decimal("0.00000001"))

        rejection = self._check_funds(request, request.quantity, fill_price, fee)
        if rejection:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason=rejection,
            )

        self._apply_fill(request, request.quantity, fill_price, fee)
        fill = FillEvent(
            order_id=broker_order_id,
            fill_id=str(uuid.uuid4()),
            quantity=request.quantity,
            price=fill_price,
            fee=fee,
            is_partial=False,
            filled_at=datetime.now(tz=UTC).isoformat(),
        )
        return OrderResult(
            broker_order_id=broker_order_id,
            status=OrderStatus.FILLED,
            fills=[fill],
        )

    def _register_bracket(
        self, parent_id: str, request: OrderRequest, result: OrderResult
    ) -> OrderResult:
        """Register the SL/TP exit legs for a filled bracket BUY entry.

        Only BUY-entry brackets reach here (the Node caller only ever builds a
        bracket for BUY proposals). The two exit legs are virtual pending
        orders evaluated lazily, mirroring _lazy_fill_limit.
        """
        bracket = request.bracket
        if bracket is None:
            return result
        stop_loss_price = bracket.get("stop_loss_price")
        take_profit_price = bracket.get("take_profit_price")
        if stop_loss_price is None or take_profit_price is None:
            return result

        take_profit_id = str(uuid.uuid4())
        stop_loss_id = str(uuid.uuid4())
        legs = _BracketLegs(
            symbol=request.symbol,
            quantity=request.quantity,
            stop_loss_price=stop_loss_price,
            take_profit_price=take_profit_price,
            take_profit_id=take_profit_id,
            stop_loss_id=stop_loss_id,
        )
        self._pending_brackets[parent_id] = legs
        self._bracket_leg_parent[take_profit_id] = parent_id
        self._bracket_leg_parent[stop_loss_id] = parent_id
        self._bracket_leg_parent[parent_id] = parent_id

        bracket_ids = {
            "parent": parent_id,
            "take_profit": take_profit_id,
            "stop_loss": stop_loss_id,
        }
        self._orders[take_profit_id] = OrderResult(
            broker_order_id=take_profit_id,
            status=OrderStatus.PENDING,
            fills=[],
            bracket_order_ids=bracket_ids,
        )
        self._orders[stop_loss_id] = OrderResult(
            broker_order_id=stop_loss_id,
            status=OrderStatus.PENDING,
            fills=[],
            bracket_order_ids=bracket_ids,
        )
        return result.model_copy(update={"bracket_order_ids": bracket_ids})

    def _evaluate_bracket(
        self, parent_id: str, price: Decimal | None = None
    ) -> OrderResult | None:
        """Check whether a pending bracket's SL or TP has been crossed.

        Assumes the caller already holds self._lock (called only from within
        locked sections, matching _lazy_fill_limit). Returns the OrderResult
        of whichever leg filled, or None if the bracket is still pending or
        already resolved.
        """
        legs = self._pending_brackets.get(parent_id)
        if legs is None:
            return None
        if price is None:
            try:
                snapshot = self._market_data.get_snapshot(legs.symbol)
            except SymbolNotFoundError:
                return None
            price = snapshot.price

        if price >= legs.take_profit_price:
            return self._fill_bracket_leg(parent_id, legs, "take_profit", price)
        if price <= legs.stop_loss_price:
            return self._fill_bracket_leg(parent_id, legs, "stop_loss", price)
        return None

    def _fill_bracket_leg(
        self,
        parent_id: str,
        legs: _BracketLegs,
        triggered_reason: str,
        trigger_price: Decimal,
    ) -> OrderResult:
        slippage = Decimal(self._config.slippage_bps) / Decimal("10000")
        fill_price = (trigger_price * (1 - slippage)).quantize(Decimal("0.00000001"))
        fee = max(
            legs.quantity * self._config.fee_per_share,
            self._config.min_fee,
        ).quantize(Decimal("0.00000001"))

        exit_request = OrderRequest(
            idempotency_key=f"bracket-exit:{parent_id}:{triggered_reason}",
            symbol=legs.symbol,
            side=OrderSide.SELL,
            quantity=legs.quantity,
            order_type=OrderType.MARKET,
        )
        self._apply_fill(exit_request, legs.quantity, fill_price, fee)

        is_take_profit = triggered_reason == "take_profit"
        filled_leg_id = legs.take_profit_id if is_take_profit else legs.stop_loss_id
        cancelled_leg_id = legs.stop_loss_id if is_take_profit else legs.take_profit_id
        bracket_ids = {
            "parent": parent_id,
            "take_profit": legs.take_profit_id,
            "stop_loss": legs.stop_loss_id,
        }
        fill = FillEvent(
            order_id=filled_leg_id,
            fill_id=str(uuid.uuid4()),
            quantity=legs.quantity,
            price=fill_price,
            fee=fee,
            is_partial=False,
            filled_at=datetime.now(tz=UTC).isoformat(),
        )
        filled_result = OrderResult(
            broker_order_id=filled_leg_id,
            status=OrderStatus.FILLED,
            fills=[fill],
            bracket_order_ids=bracket_ids,
        )
        self._orders[filled_leg_id] = filled_result
        self._orders[cancelled_leg_id] = OrderResult(
            broker_order_id=cancelled_leg_id,
            status=OrderStatus.CANCELLED,
            fills=[],
            bracket_order_ids=bracket_ids,
        )
        del self._pending_brackets[parent_id]
        return filled_result

    def _lazy_fill_limit(self, broker_order_id: str) -> None:
        """Evaluate one pending limit order using the current market price."""
        req = self._pending_limit_orders[broker_order_id]
        try:
            snap = self._market_data.get_snapshot(req.symbol)
        except SymbolNotFoundError:
            return
        limit_price = req.limit_price
        if limit_price is None:
            return
        if self._price_crosses(req.side, limit_price, snap.price):
            result = self._fill_at_price(broker_order_id, req, limit_price)
            self._orders[broker_order_id] = result
            del self._pending_limit_orders[broker_order_id]

    @staticmethod
    def _price_crosses(side: OrderSide, limit_price: Decimal, market_price: Decimal) -> bool:
        if side == OrderSide.BUY:
            return limit_price >= market_price
        return limit_price <= market_price

    def _resolve_quantity(self, quantity: Decimal) -> tuple[Decimal, bool]:
        if self._simulation_mode and self._injected_partials:
            fraction = self._injected_partials.popleft()
            fill_qty = (quantity * fraction).quantize(Decimal("1"), rounding=ROUND_DOWN)
            if fill_qty <= 0:
                return quantity, False
            return fill_qty, True
        if (
            self._config.enable_partial_fills
            and self._config.random_seed is None
            and self._rng.random() < self._config.partial_fill_probability
        ):
            fill_qty = (quantity / 2).quantize(Decimal("1"), rounding=ROUND_DOWN)
            if fill_qty <= 0:
                return quantity, False
            return fill_qty, True
        return quantity, False

    def _check_funds(
        self,
        request: OrderRequest,
        fill_qty: Decimal,
        fill_price: Decimal,
        fee: Decimal,
    ) -> str | None:
        if request.side == OrderSide.BUY:
            if self._paper_cash < fill_qty * fill_price + fee:
                return "Insufficient funds"
        else:
            pos = self._paper_positions.get(request.symbol, Decimal("0"))
            if pos < fill_qty:
                return "Insufficient position"
        return None

    def _apply_fill(
        self,
        request: OrderRequest,
        fill_qty: Decimal,
        fill_price: Decimal,
        fee: Decimal,
    ) -> None:
        if request.side == OrderSide.BUY:
            self._paper_cash -= fill_qty * fill_price + fee
            self._paper_positions[request.symbol] = (
                self._paper_positions.get(request.symbol, Decimal("0")) + fill_qty
            )
        else:
            self._paper_cash += fill_qty * fill_price - fee
            self._paper_positions[request.symbol] = (
                self._paper_positions.get(request.symbol, Decimal("0")) - fill_qty
            )

    def _make_error_result(self, broker_order_id: str, error: BrokerError) -> OrderResult:
        if error == BrokerError.INSUFFICIENT_FUNDS:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason="Insufficient funds (injected)",
            )
        if error == BrokerError.INSUFFICIENT_POSITION:
            return OrderResult(
                broker_order_id=broker_order_id,
                status=OrderStatus.REJECTED,
                fills=[],
                rejected_reason="Insufficient position (injected)",
            )
        return OrderResult(
            broker_order_id=broker_order_id,
            status=OrderStatus.ERROR,
            fills=[],
            error_message=f"Injected broker error: {error.value}",
        )

    def _store(
        self, idempotency_key: str, broker_order_id: str, result: OrderResult
    ) -> None:
        self._orders[broker_order_id] = result
        self._idempotency_index[idempotency_key] = broker_order_id
