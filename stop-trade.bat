@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
set "RUNTIME_DIR=%PROJECT_ROOT%.trade-runtime"
set "STOP_EXIT_CODE=0"
rem See start-trade.bat: strip the trailing backslash before passing this as
rem a quoted CLI argument (CommandLineToArgvW parses \" as an escaped quote).
set "PROJECT_ROOT_ARG=%PROJECT_ROOT:~0,-1%"
cd /d "%PROJECT_ROOT%"

echo Stopping PostgreSQL container...
docker compose stop postgres
if errorlevel 1 (
    echo.
    echo WARNING: Failed to stop PostgreSQL with Docker Compose.
    echo Docker may not be running, or the postgres service may not exist.
    echo Continuing with local service shutdown.
    echo.
 ) else (
    echo PostgreSQL stopped or was already stopped. Volumes were not deleted.
)

echo.
echo Stopping development services started by start-trade.bat...
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%PROJECT_ROOT%trade-launcher.ps1" -Action StopAll -ProjectRoot "%PROJECT_ROOT_ARG%" -RuntimeDir "%RUNTIME_DIR%"
if errorlevel 1 (
    set "STOP_EXIT_CODE=1"
    echo.
    echo WARNING: Not everything could be stopped or verified free. See warnings above.
    echo Any port shown as occupied by an unverified process was left untouched by design.
) else (
    echo.
    echo Stop complete. All three ports are released.
)

call :maybe_pause %1
exit /b %STOP_EXIT_CODE%

:maybe_pause
if /i "%~1"=="--no-pause" exit /b 0
pause
exit /b 0
