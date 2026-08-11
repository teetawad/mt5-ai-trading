
from broker.adapter import BrokerAdapter

_broker: BrokerAdapter | None = None


def init_broker(broker: BrokerAdapter | None = None) -> None:
    """Initialise the broker registry.  Call once at startup."""
    global _broker
    if broker is not None:
        _broker = broker
        return
    from decimal import Decimal

    from broker.paper_broker import PaperBrokerAdapter
    from broker.types import PaperBrokerConfig
    from market_data.registry import get_provider

    _broker = PaperBrokerAdapter(
        market_data=get_provider(),
        config=PaperBrokerConfig(),
        initial_cash=Decimal("100000.00"),
    )


def get_broker() -> BrokerAdapter:
    if _broker is None:
        raise RuntimeError("Broker has not been initialised — call init_broker() at startup")
    return _broker
