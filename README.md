# Paper Trading Platform

**PAPER TRADING ONLY — No real-money execution.**

A human-in-the-loop paper trading simulator.
Every simulated trade requires owner approval.
No live broker integration exists or is permitted.

## Quick Start

See `docs/DEVELOPMENT.md` for full setup instructions.

```bash
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD and other values

docker compose up -d postgres
cd apps/api && npm install && npm run dev
cd apps/web && npm install && npm run dev
cd services/trading-engine && python -m venv .venv && source .venv/Scripts/activate && pip install -r requirements-dev.txt && uvicorn main:app --reload
```

## Services

| Service | URL | Notes |
|---|---|---|
| Frontend | http://localhost:3000 | Public |
| API | http://localhost:4000 | Public |
| Trading Engine | http://localhost:8000 | Internal only |
| PostgreSQL | localhost:5432 | Dev container |

## Architecture

See `docs/ARCHITECTURE.md`.

## Safety

This system is paper-trading only. See `CLAUDE.md` for safety rules.
