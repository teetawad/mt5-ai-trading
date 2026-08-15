# Architecture

MT5 AI DEMO Trading Lab has one active broker architecture: MetaTrader 5 DEMO.

Flow:

Market Scanner -> BASELINE H1 Strategy -> Risk Engine -> Assisted Proposal or AUTO-DEMO -> DemoExecutionGateway -> MT5 `order_send()`.

The Python trading engine owns MT5 terminal access. The Node API owns auth, audit logging, PostgreSQL persistence, settings, risk, scheduler, and UI-facing APIs. The frontend is read/control surface only and never authorizes execution.

`services/trading-engine/mt5/adapter.py` is the only file allowed to call `order_send()`, and only through `DemoExecutionGateway`.
