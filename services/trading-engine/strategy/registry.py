from strategy.base import Strategy

_strategies: dict[str, Strategy] = {}


def register_strategy(strategy: Strategy) -> None:
    _strategies[strategy.name] = strategy


def get_strategy(name: str) -> Strategy:
    if name not in _strategies:
        raise KeyError(f"Strategy not found: {name!r}")
    return _strategies[name]


def list_strategies() -> list[str]:
    return list(_strategies.keys())


def get_all_strategies() -> list[Strategy]:
    return list(_strategies.values())


def clear_strategies() -> None:
    _strategies.clear()
