# MT5 AI DEMO Trading Lab

DEMO ONLY. The system blocks REAL/LIVE MT5 accounts server-side before any order.

## Windows Setup

1. Install MetaTrader 5 and log in to a DEMO account in the terminal.
2. Copy `.env.example` to `.env`.
3. Set `MT5_TERMINAL_PATH`, `MT5_ALLOWED_DEMO_LOGIN`, and `MT5_ALLOWED_DEMO_SERVER`.
4. Do not put the MT5 password in `.env`.
5. Start services:

```powershell
docker compose up -d postgres
npm install
npm run db:migrate --workspace=apps/api
pip install -r services/trading-engine/requirements-dev.txt
.\start-trade.bat
```

Frontend: http://localhost:3000  
API: http://localhost:4000  
Trading engine: http://localhost:8000

## Architecture

Python trading engine owns MT5 terminal access. Node API owns auth, audit logs,
PostgreSQL persistence, risk controls, scanner scheduling, assisted proposals,
and AUTO-DEMO gating. All MT5 order sends are centralized behind
`DemoExecutionGateway`.
