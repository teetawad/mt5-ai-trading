# CLAUDE.md - Permanent Project Rules

## Project Identity

MT5 AI DEMO Trading Lab for short-term/hourly strategy research on MetaTrader 5 DEMO accounts.

## Critical Safety Rules

1. DEMO ONLY. Never allow REAL/LIVE MT5 order execution.
2. Every MT5 order must pass server-side demo verification immediately before execution.
3. Verify MT5 connected, `account_info()` succeeds, trade mode is DEMO, login/server match `.env`, terminal trading is allowed, app mode is demo, kill switch is off, and Risk Engine passes.
4. `DemoExecutionGateway` / `MT5DemoExecutionAdapter` is the only permitted `order_send()` caller.
5. AI, strategy, frontend, routes, and schedulers must never call `order_send()` directly.
6. AUTO-DEMO defaults off and works only for verified DEMO accounts.
7. Never implement AUTO-LIVE.
8. Frontend flags never authorize trading.
9. Every AUTO-DEMO entry must include valid SL and TP.
10. Store AI decisions, feature snapshots, risk evaluations, and trade outcomes for learning.
11. Do not implement online self-modifying AI. Use offline challenger training, backtesting, validation, walk-forward, and promotion gates.
12. Never log credentials, tokens, MT5 passwords, or session secrets.

## Stack

Frontend: Nuxt 3 / Vue / TypeScript / Tailwind.  
API: Node / Express / TypeScript.  
Trading engine: Python / FastAPI / official MetaTrader5 package.  
Database: PostgreSQL.
