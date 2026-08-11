@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
cd /d "%PROJECT_ROOT%"

echo Stopping PostgreSQL container...
docker compose stop postgres
if errorlevel 1 (
    echo.
    echo ERROR: Failed to stop PostgreSQL with Docker Compose.
    echo Docker may not be running, or the postgres service may not exist.
    echo.
    pause
    exit /b 1
)

echo.
echo PostgreSQL has been stopped. Volumes were not deleted.
echo.
echo Closing development service windows started by start-trade.bat...
echo.

for %%T in (TRADE_API TRADE_ENGINE TRADE_WEB) do (
    echo Closing %%T...
    taskkill /FI "WINDOWTITLE eq %%T" /T /F >nul 2>&1
    if errorlevel 1 (
        echo No %%T window found, or it was already closed.
    ) else (
        echo %%T closed.
    )
)

echo.
echo Stop complete. Only windows titled TRADE_API, TRADE_ENGINE, and TRADE_WEB were targeted.
echo.
pause
