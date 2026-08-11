@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
set "RUNTIME_DIR=%PROJECT_ROOT%.trade-runtime"
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
echo Closing development service windows started by start-trade.bat...
echo.

call :stop_service TRADE_API
call :stop_service TRADE_ENGINE
call :stop_service TRADE_WEB

echo.
echo Stop complete. Only saved service PIDs and TRADE_* titled windows were targeted.
echo.
call :maybe_pause %1

exit /b 0

:maybe_pause
if /i "%~1"=="--no-pause" exit /b 0
pause
exit /b 0

:stop_service
set "SERVICE_NAME=%~1"
set "PID_FILE=%RUNTIME_DIR%\%SERVICE_NAME%.pid"
set "STOPPED="

echo %SERVICE_NAME%:

if exist "%PID_FILE%" (
    set "SERVICE_PID="
    set /p SERVICE_PID=<"%PID_FILE%"
    if defined SERVICE_PID (
        powershell -NoProfile -Command "$p = Get-CimInstance Win32_Process -Filter 'ProcessId = !SERVICE_PID!' -ErrorAction SilentlyContinue; if ($p -and $p.Name -ieq 'cmd.exe' -and $p.CommandLine -like '*\.trade-runtime\%SERVICE_NAME%.cmd*') { exit 0 } else { exit 1 }" >nul 2>&1
        if errorlevel 1 (
            echo   Saved PID !SERVICE_PID! is not the expected %SERVICE_NAME% wrapper, or it is already stopped.
        ) else (
            echo   Stopping PID !SERVICE_PID! and its child processes...
            taskkill /PID !SERVICE_PID! /T >nul 2>&1
            timeout /t 2 /nobreak >nul
            powershell -NoProfile -Command "if (Get-Process -Id !SERVICE_PID! -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1
            if not errorlevel 1 (
                echo   Graceful stop timed out; forcing PID !SERVICE_PID! tree...
                taskkill /PID !SERVICE_PID! /T /F >nul 2>&1
            )
            echo   %SERVICE_NAME% stopped.
            set "STOPPED=1"
        )
    ) else (
        echo   PID file is empty.
    )
    del "%PID_FILE%" >nul 2>&1
)

if not defined STOPPED (
    echo   No saved PID found; trying unique window title fallback...
    taskkill /FI "WINDOWTITLE eq %SERVICE_NAME%*" /T >nul 2>&1
    if errorlevel 1 (
        echo   No %SERVICE_NAME% window found.
    ) else (
        echo   %SERVICE_NAME% window closed by title fallback.
    )
)

exit /b 0
