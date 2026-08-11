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
echo Close the API, Trading Engine, and Frontend CMD windows manually:
echo - Press Ctrl+C in each service window.
echo - Then close each CMD window.
echo.
pause
