# Phase 15 Backtesting and Strategy Evaluation

Phase 15 adds research-only backtesting for US stock strategies. It does not
submit orders, does not import broker/router execution code, and does not add
live trading.

## Backtest Model

- Input data is a single-symbol, timestamp-ordered list of historical bars.
- Strategy signals are generated from completed bar closes only.
- A signal generated at bar `N` can only execute at bar `N + 1` open.
- A signal on the final bar is intentionally not executed because no future bar
  is available.
- Transaction fees and slippage are applied to simulated fills.
- Benchmark performance is buy-and-hold from the first bar open to the final
  bar close.

## Supported Strategy Configuration

The initial evaluator supports `moving_average_crossover` with explicit
parameters:

- `symbol`
- `short_window`
- `long_window`
- `quantity`

Invalid windows and mismatched symbols are rejected before evaluation.

## Metrics

- Total return
- Benchmark return
- Max drawdown
- Sharpe ratio
- Win rate
- Profit factor
- Trade count

## Validation

`train_test_split` preserves time order and creates non-overlapping train and
test ranges.

`walk_forward_validate` ranks candidate parameter sets on each train window and
evaluates only the immediately following test window. Test-window data is not
available during candidate selection, which prevents look-ahead bias and data
leakage.

## Safety Boundary

Backtesting lives under `services/trading-engine/backtesting`. Tests statically
verify that this package does not import `broker` or `routers`.
