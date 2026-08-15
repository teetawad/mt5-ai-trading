# MT5 Setup

1. Install MetaTrader 5 on Windows.
2. Log in to a DEMO account in the terminal.
3. Copy `.env.example` to `.env`.
4. Set `MT5_TERMINAL_PATH`, `MT5_ALLOWED_DEMO_LOGIN`, and `MT5_ALLOWED_DEMO_SERVER`.
5. Do not store the MT5 password in `.env`.
6. Start the trading engine and call `GET /mt5/status` through the API.

REAL/LIVE accounts are blocked even if the terminal is connected.
