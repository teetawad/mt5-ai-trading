@echo off
setlocal EnableExtensions EnableDelayedExpansion

set "PROJECT_ROOT=%~dp0"
set "RUNTIME_DIR=%PROJECT_ROOT%.trade-runtime"
set "TRADE_PROJECT_ROOT=%PROJECT_ROOT%"
set "TRADE_RUNTIME_DIR=%RUNTIME_DIR%"
set "NO_PAUSE=0"
set "STARTUP_EXIT_CODE=0"
if /i "%~1"=="--no-pause" set "NO_PAUSE=1"

cd /d "%PROJECT_ROOT%" || (
    echo ERROR: Failed to change directory to "%PROJECT_ROOT%".
    goto fail
)

echo.
echo ============================================================
echo Trade Platform Startup
echo Project: %PROJECT_ROOT%
echo ============================================================
echo.

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to create runtime directory:
    echo   %RUNTIME_DIR%
    goto fail
)

echo Checking required folders and files...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$root = $env:TRADE_PROJECT_ROOT;" ^
  "$items = @(" ^
  "  @{ Label = 'Root package file'; Path = Join-Path $root 'package.json'; Kind = 'Leaf' }," ^
  "  @{ Label = 'Docker Compose file'; Path = Join-Path $root 'docker-compose.yml'; Kind = 'Leaf' }," ^
  "  @{ Label = 'Environment file'; Path = Join-Path $root '.env'; Kind = 'Leaf' }," ^
  "  @{ Label = 'API folder'; Path = Join-Path $root 'apps\api'; Kind = 'Container' }," ^
  "  @{ Label = 'API package file'; Path = Join-Path $root 'apps\api\package.json'; Kind = 'Leaf' }," ^
  "  @{ Label = 'Web folder'; Path = Join-Path $root 'apps\web'; Kind = 'Container' }," ^
  "  @{ Label = 'Web package file'; Path = Join-Path $root 'apps\web\package.json'; Kind = 'Leaf' }," ^
  "  @{ Label = 'Trading Engine folder'; Path = Join-Path $root 'services\trading-engine'; Kind = 'Container' }," ^
  "  @{ Label = 'Trading Engine main.py'; Path = Join-Path $root 'services\trading-engine\main.py'; Kind = 'Leaf' }," ^
  "  @{ Label = 'Trading Engine .venv'; Path = Join-Path $root 'services\trading-engine\.venv'; Kind = 'Container' }," ^
  "  @{ Label = 'Trading Engine uvicorn'; Path = Join-Path $root 'services\trading-engine\.venv\Scripts\uvicorn.exe'; Kind = 'Leaf' }" ^
  ");" ^
  "foreach ($item in $items) {" ^
  "  if (-not (Test-Path -LiteralPath $item.Path -PathType $item.Kind)) { Write-Host ('ERROR: Missing ' + $item.Label + ':'); Write-Host ('  ' + $item.Path); exit 1 }" ^
  "  Write-Host ('OK: ' + $item.Label);" ^
  "}"
if errorlevel 1 goto fail

echo.
echo Checking service ports...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$checks = @(" ^
  "  @{ Name = 'Web'; Port = 3000 }," ^
  "  @{ Name = 'API'; Port = 4000 }," ^
  "  @{ Name = 'Trading Engine'; Port = 8000 }" ^
  ");" ^
  "foreach ($check in $checks) {" ^
  "  $connection = Get-NetTCPConnection -LocalPort $check.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "  if ($connection) { Write-Host ('ERROR: ' + $check.Name + ' cannot start because port ' + $check.Port + ' is already listening. Owning PID: ' + $connection.OwningProcess); exit 1 }" ^
  "  Write-Host ('OK: Port ' + $check.Port + ' is free for ' + $check.Name + '.');" ^
  "}"
if errorlevel 1 goto fail

echo.
echo Checking Docker...
docker info >nul 2>&1
if errorlevel 1 (
    echo ERROR: Docker does not appear to be running.
    echo Start Docker Desktop, wait for it to finish starting, then run this file again.
    goto fail
)
echo OK: Docker is running.

echo.
echo Starting PostgreSQL with Docker Compose...
docker compose up -d postgres
if errorlevel 1 (
    echo ERROR: Failed to start PostgreSQL with Docker Compose.
    goto fail
)
echo OK: PostgreSQL start command completed.

echo.
echo Applying database migrations...
call npm run db:migrate --workspace=apps/api
if errorlevel 1 (
    echo ERROR: Failed to apply database migrations.
    goto fail
)
echo OK: Database migrations completed.

echo.
echo Opening service windows...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ErrorActionPreference = 'Stop';" ^
  "$runtime = $env:TRADE_RUNTIME_DIR;" ^
  "$root = $env:TRADE_PROJECT_ROOT;" ^
  "function Start-TradeService([string] $name, [string] $dir, [string] $cmd) {" ^
  "  if (-not (Test-Path -LiteralPath $dir -PathType Container)) { throw ($name + ' directory not found: ' + $dir); }" ^
  "  $pidFile = Join-Path $runtime ($name + '.pid');" ^
  "  $launcher = Join-Path $runtime ($name + '.cmd');" ^
  "  if (Test-Path -LiteralPath $pidFile) {" ^
  "    $existing = Get-Content -LiteralPath $pidFile -TotalCount 1 -ErrorAction SilentlyContinue;" ^
  "    if ($existing -and (Get-Process -Id ([int] $existing) -ErrorAction SilentlyContinue)) {" ^
  "      throw ($name + ' already appears to be running as PID ' + $existing + '. Run stop-trade.bat first.');" ^
  "    }" ^
  "    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue;" ^
  "  }" ^
  "  Write-Host ('Starting ' + $name + '...');" ^
  "  Set-Content -LiteralPath $launcher -Encoding ASCII -Value @('@echo off', ('title ' + $name), 'echo ============================================================', ('echo ' + $name), 'echo ============================================================', ('cd /d ' + [char]34 + $dir + [char]34), 'echo Working directory: %CD%', 'echo Command:', ('echo   ' + $cmd), 'echo.', $cmd, 'echo.', ('echo ' + $name + ' exited with errorlevel %%ERRORLEVEL%%.'), 'echo Review the error above.', 'pause');" ^
  "  $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $launcher) -PassThru;" ^
  "  Set-Content -LiteralPath $pidFile -Encoding ASCII -Value $process.Id;" ^
  "  Write-Host ($name + ' wrapper CMD PID: ' + $process.Id);" ^
  "}" ^
  "Start-TradeService 'TRADE_API' (Join-Path $root 'apps\api') 'call npm run dev';" ^
  "Start-TradeService 'TRADE_ENGINE' (Join-Path $root 'services\trading-engine') '.venv\Scripts\uvicorn.exe main:app --reload';" ^
  "Start-TradeService 'TRADE_WEB' (Join-Path $root 'apps\web') 'call npm run dev';"
if errorlevel 1 (
    echo ERROR: Failed to open one or more service windows.
    goto fail
)
echo OK: Service windows opened: TRADE_API, TRADE_ENGINE, TRADE_WEB.

echo.
echo Waiting for services to listen...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$checks = @(" ^
  "  @{ Name = 'API'; Port = 4000 }," ^
  "  @{ Name = 'Trading Engine'; Port = 8000 }," ^
  "  @{ Name = 'Web'; Port = 3000 }" ^
  ");" ^
  "foreach ($check in $checks) {" ^
  "  Write-Host ('Waiting for ' + $check.Name + ' on port ' + $check.Port + '...');" ^
  "  $deadline = (Get-Date).AddSeconds(45);" ^
  "  do {" ^
  "    $connection = Get-NetTCPConnection -LocalPort $check.Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1;" ^
  "    if ($connection) { Write-Host ('OK: ' + $check.Name + ' is listening on port ' + $check.Port + ' with PID ' + $connection.OwningProcess + '.'); $ready = $true; break }" ^
  "    Start-Sleep -Seconds 1;" ^
  "  } while ((Get-Date) -lt $deadline);" ^
  "  if (-not $ready) { Write-Host ('ERROR: ' + $check.Name + ' did not listen on port ' + $check.Port + ' within 45 seconds. Check the TRADE_* window for the service error.'); exit 1 }" ^
  "  $ready = $false;" ^
  "}"
if errorlevel 1 goto fail

echo.
echo Opening http://localhost:3000 in the default browser...
start "" "http://localhost:3000"

echo.
echo ============================================================
echo Startup complete.
echo PostgreSQL: Docker container trade_postgres
echo API: TRADE_API window on port 4000
echo Trading Engine: TRADE_ENGINE window on port 8000
echo Web: TRADE_WEB window on port 3000
echo Run stop-trade.bat to stop PostgreSQL and close those windows.
echo ============================================================
echo.
goto done

:fail
set "STARTUP_EXIT_CODE=1"
echo.
echo ============================================================
echo STARTUP FAILED
echo Review the error above. No live trading was started.
echo ============================================================
echo.
goto done

:done
if "%NO_PAUSE%"=="0" pause
exit /b %STARTUP_EXIT_CODE%
