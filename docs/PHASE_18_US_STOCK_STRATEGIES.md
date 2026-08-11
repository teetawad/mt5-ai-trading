# Phase 18 US Stock Strategy Layer

Phase 18 improves the research and paper-trading strategy layer for US stocks.
It does not add live trading or real-money execution.

Added strategy capability:

- Trend filter
- Momentum filter
- Volatility filter
- Volume confirmation
- Moving-average confirmation
- Configurable entry and exit thresholds

Backtesting changes:

- `StrategyKind.US_STOCK_FACTOR` adds factor-based historical evaluation.
- Signals are generated only after a bar closes.
- Trades execute on the next bar open to prevent look-ahead bias.
- Walk-forward validation still uses train/test time splits with no overlap.
- Candidate selection uses a risk-adjusted score, not historical return alone.
- Benchmark comparison remains part of every backtest result.

The strategy layer remains read-only. It consumes market data and emits signals;
all order execution remains PAPER ONLY through the existing approval and broker
flow.
