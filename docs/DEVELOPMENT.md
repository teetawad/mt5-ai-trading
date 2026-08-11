# DEVELOPMENT.md

## Prerequisites

- Node.js 20 LTS or later (tested on v24)
- Python 3.12 or later (tested on 3.14)
- Docker Desktop (for PostgreSQL)
- Git

## Initial Setup

```bash
# Clone repo
git clone <repo-url>
cd trade

# Copy environment file
cp .env.example .env
# Edit .env — set POSTGRES_PASSWORD and other required values

# Start PostgreSQL
docker compose up -d postgres

# Install ALL Node dependencies (root workspace — installs both apps/api and apps/web)
npm install

# Generate Nuxt TypeScript types (run once after install)
npm run nuxt:prepare --workspace=apps/web

# Install Python dependencies for trading engine
cd services/trading-engine
python -m venv .venv
source .venv/Scripts/activate      # Windows (Git Bash)
# source .venv/bin/activate         # macOS / Linux
pip install -r requirements-dev.txt
cd ../..
```

## Running Services

Start each service in a separate terminal:

```bash
# Terminal 1: API (http://localhost:4000)
npm run dev:api

# Terminal 2: Trading engine (http://localhost:8000 — internal only)
cd services/trading-engine
source .venv/Scripts/activate
uvicorn main:app --reload

# Terminal 3: Frontend (http://localhost:3000)
npm run dev:web
```

## Service URLs (Development)

| Service | URL | Notes |
|---|---|---|
| Frontend | http://localhost:3000 | Public UI |
| API | http://localhost:4000 | Public REST API |
| Trading Engine | http://localhost:8000 | Internal only — do not expose |
| PostgreSQL | localhost:5432 | Dev Docker container |

## Health Checks

```bash
curl http://localhost:4000/health        # API
curl http://localhost:8000/health        # Trading engine
curl http://localhost:3000/api/health    # Nuxt server route
```

## Running Tests

```bash
# All Node tests
npm run test

# API tests only
npm run test:api

# Python tests
cd services/trading-engine && source .venv/Scripts/activate && pytest -v
```

## Lint & Typecheck

```bash
# Lint all Node services
npm run lint

# Typecheck all Node services
npm run typecheck

# Python lint
cd services/trading-engine && source .venv/Scripts/activate && ruff check .

# Python typecheck
cd services/trading-engine && source .venv/Scripts/activate && mypy .
```

## Environment Variables

See `.env.example` for all required variables and descriptions.
Never commit `.env` to version control.

## Database

```bash
# Start the DB container
docker compose up -d postgres

# View logs
docker compose logs -f postgres

# Stop the DB container
docker compose stop postgres
```

Migration tooling and seed scripts will be added in Phase 2.

## Updating PHASES.md

After completing work in a phase:
1. Mark completed items with `[x]`.
2. Mark blocked items with `[!]` and add a note.
3. Commit the updated PHASES.md with the phase work.

## Generating Nuxt Types (if .nuxt/ is missing)

```bash
npm run nuxt:prepare --workspace=apps/web
```

Run this after install or after changing `nuxt.config.ts`.

## Safety Reminders

- This system is PAPER TRADING ONLY.
- Never add live broker integrations.
- Never expose `services/trading-engine` to the public internet.
- Always run tests before declaring a phase complete.
