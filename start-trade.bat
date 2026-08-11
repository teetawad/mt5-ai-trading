@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

echo Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Docker does not appear to be running.
    echo Start Docker Desktop, wait for it to finish starting, then run this file again.
    echo.
    pause
    exit /b 1
)

echo Starting PostgreSQL...
docker compose up -d postgres
if errorlevel 1 (
    echo.
    echo ERROR: Failed to start PostgreSQL with Docker Compose.
    echo.
    pause
    exit /b 1
)

echo Opening API window...
start "TRADE_API" cmd /k "title TRADE_API && cd /d ""%PROJECT_ROOT%apps\api"" && npm run dev"

echo Opening Trading Engine window...
start "TRADE_ENGINE" cmd /k "title TRADE_ENGINE && cd /d ""%PROJECT_ROOT%services\trading-engine"" && call .venv\Scripts\activate && uvicorn main:app --reload"

echo Opening Frontend window...
start "TRADE_WEB" cmd /k "title TRADE_WEB && cd /d ""%PROJECT_ROOT%apps\web"" && npm run dev"

echo Waiting a few seconds for services to start...
timeout /t 5 /nobreak >nul

echo Opening http://localhost:3000 in the default browser...
start "" "http://localhost:3000"

echo.
echo Startup commands have been launched.
echo Service windows are titled TRADE_API, TRADE_ENGINE, and TRADE_WEB.
echo Run stop-trade.bat to stop PostgreSQL and close those service windows.
echo.
pause
