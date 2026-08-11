@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
set "RUNTIME_DIR=%PROJECT_ROOT%.trade-runtime"
set "TRADE_PROJECT_ROOT=%PROJECT_ROOT%"
set "TRADE_RUNTIME_DIR=%RUNTIME_DIR%"
cd /d "%PROJECT_ROOT%"

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>&1

echo Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo.
    echo ERROR: Docker does not appear to be running.
    echo Start Docker Desktop, wait for it to finish starting, then run this file again.
    echo.
    call :maybe_pause %1
    exit /b 1
)

echo Starting PostgreSQL...
docker compose up -d postgres
if errorlevel 1 (
    echo.
    echo ERROR: Failed to start PostgreSQL with Docker Compose.
    echo.
    call :maybe_pause %1
    exit /b 1
)

echo Applying database migrations...
npm run db:migrate --workspace=apps/api
if errorlevel 1 (
    echo.
    echo ERROR: Failed to apply database migrations.
    echo.
    call :maybe_pause %1
    exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$runtime = $env:TRADE_RUNTIME_DIR;" ^
  "$root = $env:TRADE_PROJECT_ROOT;" ^
  "function Start-TradeService([string] $name, [string] $dir, [string] $cmd) {" ^
  "  $pidFile = Join-Path $runtime ($name + '.pid');" ^
  "  $launcher = Join-Path $runtime ($name + '.cmd');" ^
  "  if (Test-Path -LiteralPath $pidFile) {" ^
  "    $existing = Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue;" ^
  "    if ($existing -and (Get-Process -Id ([int] $existing) -ErrorAction SilentlyContinue)) {" ^
  "      Write-Host ($name + ' already appears to be running as PID ' + $existing + '.');" ^
  "      return;" ^
  "    }" ^
  "    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue;" ^
  "  }" ^
  "  Write-Host ('Opening ' + $name + ' window...');" ^
  "  Set-Content -LiteralPath $launcher -Encoding ASCII -Value @('@echo off', ('title ' + $name), ('cd /d ' + [char]34 + $dir + [char]34), $cmd, 'echo.', ('echo ' + $name + ' exited with errorlevel %%ERRORLEVEL%%.'), 'pause');" ^
  "  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $launcher) -PassThru;" ^
  "  Set-Content -LiteralPath $pidFile -Encoding ASCII -Value $process.Id;" ^
  "  Write-Host ($name + ' started as wrapper CMD PID ' + $process.Id + '.');" ^
  "}" ^
  "Start-TradeService 'TRADE_API' (Join-Path $root 'apps\api') 'npm run dev';" ^
  "Start-TradeService 'TRADE_ENGINE' (Join-Path $root 'services\trading-engine') '.venv\Scripts\uvicorn.exe main:app --reload';" ^
  "Start-TradeService 'TRADE_WEB' (Join-Path $root 'apps\web') 'npm run dev';"
if errorlevel 1 exit /b 1

echo Waiting a few seconds for services to start...
timeout /t 5 /nobreak >nul

echo Opening http://localhost:3000 in the default browser...
start "" "http://localhost:3000"

echo.
echo Startup commands have been launched.
echo Service windows are titled TRADE_API, TRADE_ENGINE, and TRADE_WEB.
echo Run stop-trade.bat to stop PostgreSQL and close those service windows.
echo.
call :maybe_pause %1

exit /b 0

:maybe_pause
if /i "%~1"=="--no-pause" exit /b 0
pause
exit /b 0
