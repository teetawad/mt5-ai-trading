from abc import ABC, abstractmethod

from broker.types import OrderRequest, OrderResult


class OrderNotFoundError(Exception):
    pass


class BrokerAdapter(ABC):
    @abstractmethod
    def submit_order(self, request: OrderRequest) -> OrderResult:
        """Submit an order. Same idempotency_key always returns the same result."""
        ...

    @abstractmethod
    def get_order(self, broker_order_id: str) -> OrderResult:
        """Fetch current status. Raises OrderNotFoundError if not found."""
        ...

    @abstractmethod
    def cancel_order(self, broker_order_id: str) -> OrderResult:
        """Cancel an open order. Returns current state if already terminal."""
        ...

    @abstractmethod
    def is_available(self) -> bool:
        """Return True if the broker is operational."""
        ...
