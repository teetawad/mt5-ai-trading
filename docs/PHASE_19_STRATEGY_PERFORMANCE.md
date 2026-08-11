# Phase 19 PAPER Strategy Performance Evaluation

Phase 19 evaluates implemented US stock strategy families with walk-forward
out-of-sample backtests. It does not add live trading or real-money execution.

Compared strategy families:

- `moving_average_crossover`
- `us_stock_factor`

Metrics evaluated:

- Total return
- Annualized return
- Maximum drawdown
- Sharpe ratio
- Win rate
- Profit factor
- Average win and average loss
- Trade count
- Exposure
- Benchmark return
- Stability across out-of-sample folds

Selection policy:

- Strategies are not selected by highest historical profit alone.
- Walk-forward train windows select candidates using a risk-adjusted score.
- Recommendations are based on out-of-sample return, drawdown, trade count,
  stability, profit factor, and overfitting flags.

Current report:

- `docs/reports/PHASE_19_STRATEGY_PERFORMANCE.md`
- `docs/reports/phase19-strategy-performance.json`

Current recommendation: neither implemented strategy family is safe to continue
PAPER testing from this sample. Both were flagged for too few trades and poor
out-of-sample fold stability. Continue research with larger historical data
coverage before enabling either strategy in active PAPER testing.
