# AUTO-DEMO

AUTO-DEMO defaults off via `mt5_auto_demo_enabled=false`.

Before every automatic order, the server reloads MT5 account/terminal state, verifies DEMO trade mode, validates allowed login/server, checks the kill switch, validates SL/TP, runs Risk Engine, runs `order_check()`, and only then calls `DemoExecutionGateway.execute_market_order()`.

No AUTO-LIVE mode exists.
