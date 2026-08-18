<#
.SYNOPSIS
  Process-tracking helper for start-trade.bat / stop-trade.bat.

.DESCRIPTION
  Root cause of "port already in use" on repeated start/stop cycles:

  Each service is launched as `cmd.exe /k <wrapper>.cmd`, and the wrapper
  runs `npm run dev` / `uvicorn ... --reload`. Both of those spawn NESTED
  child processes with DIFFERENT command-line text at each hop (confirmed
  empirically: an `npm run dev` API process was observed two hops deep as
  `node.exe --require ... preflight.cjs ...`, parented by a second, distinct
  `node.exe ...tsx\dist\cli.mjs...` process; a `uvicorn --reload` process was
  observed as a worker `python.exe` two hops below the supervisor). Two
  failure modes follow from this:

    1. Killing only the tracked wrapper PID by command-line pattern match
       (the old stop-trade.bat approach in spirit) can miss the actual
       socket-owning grandchild, because its command line never contains
       the original launch string.
    2. Even a full process-TREE kill (taskkill /T) from the wrapper PID can
       miss it: intermediate hops (e.g. an `npm`/`tsx` CLI shim, or
       uvicorn's reload supervisor) can themselves exit while their child
       keeps running and keeps the port bound — this was reproduced live
       during development of this script. At that point the child's
       recorded parent PID points at a process that no longer exists, so a
       live downward walk from the wrapper never reaches it.

  Fix: the moment a service is confirmed listening (during startup), record
  the PID that actually owns the socket (`Get-NetTCPConnection`'s
  OwningProcess) — ground truth, independent of tree depth or later
  intermediate-process exits. At stop time, that recorded PID is the
  primary kill target. A live tree-walk from the tracked wrapper PID is
  kept only as a fallback (it correctly covers the "worker restarted with a
  new PID but the wrapper is still alive" case, e.g. a --reload restart
  triggered by a code edit).

  Safety: a PID is only ever killed if it is confidently identified as
  belonging to THIS project by one of:
    1. The exact PID this project itself observed binding that port
       (recorded in a `.workerpid` file moments after this launcher started
       it) - ground truth from a prior run of this launcher.
    2. A live descendant of a wrapper PID whose command line was verified to
       reference this project's own generated `<service>.cmd` launcher file
       (`.pid` file) - covers a --reload/watch worker restart that changed
       the worker PID but the wrapper window is still alive.
    3. The port-owning process itself, or one of its live ancestors, has a
       command line that contains this project's own root folder path
       (normalized - see Test-CommandLineReferencesProject below) - the
       actual root-cause fix. PID-file tracking (1 and 2) only ever covers
       processes THIS launcher itself started; any process started any other
       way (manually via `npm run dev`/`uvicorn` in a terminal, from an IDE,
       or left over from a launcher version predating PID tracking) has no
       PID file at all, so 1 and 2 always fail for it even though its own
       command line plainly shows it belongs to this project. Empirically
       confirmed against real dev processes: the API's tsx-loaded node.exe
       command line embeds the project's node_modules path both with
       backslashes AND, in its `--import file:///C:/Users/.../node_modules/
       tsx/dist/loader.mjs` argument, with forward slashes in the SAME
       command line - normalization must handle both forms, not just one.
  Path matching (3) is always a substring match against this project's own
  root folder path specifically (e.g. `c:\users\teetawad\desktop\trade`),
  never a bare executable-name or generic keyword match - a Node or Python
  process for a completely different project never contains this project's
  own folder path in its command line, so it can never match. If a port is
  occupied by a process that fails all three checks, it is reported (PID,
  process name, command line) and left completely untouched.

.PARAMETER Action
  PreStartCleanup - stop any stale, verified-ours process per service and
                    fail (exit 1) if any port is held by something that
                    cannot be verified. Called by start-trade.bat before
                    launching anything.
  StartAll        - launch all three service wrapper windows and wait for
                     each to start listening, recording the confirmed
                     worker PID for each.
  StopAll         - stop all three services (best-effort, always attempts
                     all three) and verify all three ports are released.
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('PreStartCleanup', 'StartAll', 'StopAll')]
    [string]$Action,

    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [Parameter(Mandatory = $true)]
    [string]$RuntimeDir
)

$ErrorActionPreference = 'Stop'

function Get-NormalizedProjectPath {
    # Case-insensitive, slash-style-insensitive normalization so a command
    # line can be reliably matched against this project's own root folder
    # regardless of quoting or how the path was spelled (backslashes,
    # forward slashes, or - as seen in real tsx/node `--import file:///...`
    # arguments - a mix of both within the SAME string).
    param([string]$Path)
    if (-not $Path) { return '' }
    $normalized = $Path.Trim().Trim('"').Trim("'").Replace('/', '\')
    while ($normalized.Contains('\\')) { $normalized = $normalized.Replace('\\', '\') }
    return $normalized.ToLowerInvariant().TrimEnd('\')
}

function Test-CommandLineReferencesProject {
    # Confidence check: does this single command line string plainly
    # reference this project's own root folder? Always a substring match
    # against the project's OWN full path (e.g.
    # `c:\users\teetawad\desktop\trade`) - never a bare executable name
    # (node.exe/python.exe) or generic keyword. A process for an unrelated
    # project can never contain this exact path, so this can't false-match
    # "any Node/Python process" the way a name-only check would.
    param([string]$CommandLine, [string]$NormalizedRoot)
    if (-not $CommandLine -or -not $NormalizedRoot) { return $false }
    # Guard against a degenerate/near-empty root (e.g. "C:\" or "C:")
    # matching almost anything - the project root is always a real,
    # specific, multi-segment folder path.
    if ($NormalizedRoot.Length -le 3) { return $false }
    $normalizedCmd = $CommandLine.Trim().Replace('/', '\')
    while ($normalizedCmd.Contains('\\')) { $normalizedCmd = $normalizedCmd.Replace('\\', '\') }
    return $normalizedCmd.ToLowerInvariant().Contains($NormalizedRoot)
}

function Test-TradeProjectOwnedProcess {
    # Root-cause fix for "processes could not be verified as belonging to
    # this project": PID-file tracking (see Stop-TradeServiceByName) only
    # ever recognizes processes THIS launcher itself started. A process
    # started any other way - manually via `npm run dev`/`uvicorn` in a
    # terminal, from an IDE, or left over from before PID tracking existed -
    # has no PID file, even though its own command line plainly shows it
    # belongs to this project. This checks the port-owning process itself,
    # then walks LIVE ancestors upward (bounded depth, cycle-safe), matching
    # each one's command line against the project root. Node/tsx/Nuxt and
    # Python/uvicorn wrapper layers are covered generically - by path
    # content, not by recognizing specific tool names - because the
    # intermediate `npm`/`tsx`/`uvicorn --reload` supervisor hops that sit
    # above the actual socket-owning worker are exactly the "different
    # command-line text at each hop" case documented at the top of this
    # file, and one of those hops (or the worker itself) reliably contains
    # the project path in every case observed against real dev processes.
    param([int]$ProcessId, [int]$MaxAncestorHops = 10)
    $normalizedRoot = Get-NormalizedProjectPath -Path $ProjectRoot
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    $currentId = $ProcessId
    $hops = 0
    while ($currentId -and $currentId -ne 0 -and -not $seen.Contains($currentId) -and $hops -le $MaxAncestorHops) {
        [void]$seen.Add($currentId)
        $hops++
        $info = Get-ProcessInfo -ProcessId $currentId
        if (-not $info) { return $false }
        if (Test-CommandLineReferencesProject -CommandLine $info.CommandLine -NormalizedRoot $normalizedRoot) {
            return $true
        }
        $currentId = [int]$info.ParentProcessId
    }
    return $false
}

function Get-TradeServices {
    param([string]$Root)
    return @(
        [PSCustomObject]@{ Name = 'TRADE_API';    Port = 4000; Dir = (Join-Path $Root 'apps\api');               Command = 'call npm run dev' },
        [PSCustomObject]@{ Name = 'TRADE_ENGINE'; Port = 8000; Dir = (Join-Path $Root 'services\trading-engine'); Command = '.venv\Scripts\uvicorn.exe main:app --reload' },
        [PSCustomObject]@{ Name = 'TRADE_WEB';    Port = 3000; Dir = (Join-Path $Root 'apps\web');                Command = 'call npm run dev' }
    )
}

function Get-TradePidFile { param($Service) Join-Path $RuntimeDir ($Service.Name + '.pid') }
function Get-TradeWorkerPidFile { param($Service) Join-Path $RuntimeDir ($Service.Name + '.workerpid') }
function Get-TradeLauncherFile { param($Service) Join-Path $RuntimeDir ($Service.Name + '.cmd') }

function Read-TradePidFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    $raw = Get-Content -LiteralPath $Path -TotalCount 1 -ErrorAction SilentlyContinue
    if (-not $raw) { return $null }
    $parsed = 0
    if ([int]::TryParse($raw.Trim(), [ref]$parsed)) { return $parsed }
    return $null
}

function Get-PortOwner {
    param([int]$Port)
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if (-not $conn) { return $null }
    return [int]$conn.OwningProcess
}

function Get-ProcessInfo {
    param([int]$ProcessId)
    Get-CimInstance Win32_Process -Filter "ProcessId = $ProcessId" -ErrorAction SilentlyContinue
}

function Invoke-TradeTaskKill {
    # taskkill writing to stderr (e.g. "process not found" for a PID that
    # already exited between our snapshot and this call — an expected,
    # harmless race, not a real failure) becomes a terminating
    # NativeCommandError under $ErrorActionPreference = 'Stop'. Always
    # swallow it here; the caller re-verifies the port afterward regardless.
    param([string[]]$ArgumentList)
    try {
        & taskkill @ArgumentList 2>$null 1>$null
    } catch {
    }
}

function Test-TradeWrapperSignature {
    # Verifies a PID is genuinely one of OUR generated wrapper windows.
    # Never a bare process-name/executable match.
    param([int]$ProcessId, [PSCustomObject]$Service)
    $info = Get-ProcessInfo -ProcessId $ProcessId
    if (-not $info) { return $false }
    if ($info.Name -ine 'cmd.exe') { return $false }
    if (-not $info.CommandLine) { return $false }
    $launcher = Get-TradeLauncherFile -Service $Service
    return $info.CommandLine.ToLowerInvariant().Contains($launcher.ToLowerInvariant())
}

function Get-ProcessDescendantIds {
    # Live BFS by ParentProcessId from a root PID. Only ever walks DOWNWARD
    # from an already-verified root, so it can never wander into an
    # unrelated sibling or ancestor process tree.
    param([int]$RootProcessId)
    $seen = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$seen.Add($RootProcessId)
    $all = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Select-Object ProcessId, ParentProcessId
    if (-not $all) { return $seen }
    $queue = New-Object 'System.Collections.Generic.Queue[int]'
    $queue.Enqueue($RootProcessId)
    while ($queue.Count -gt 0) {
        $current = $queue.Dequeue()
        foreach ($proc in $all) {
            if ([int]$proc.ParentProcessId -eq $current -and -not $seen.Contains([int]$proc.ProcessId)) {
                [void]$seen.Add([int]$proc.ProcessId)
                $queue.Enqueue([int]$proc.ProcessId)
            }
        }
    }
    return $seen
}

function Wait-TradePortFree {
    param([int]$Port, [int]$TimeoutSeconds = 15)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        if (-not (Get-PortOwner -Port $Port)) { return $true }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    return -not (Get-PortOwner -Port $Port)
}

function Stop-TradeServiceByName {
    param([PSCustomObject]$Service)

    $pidFile = Get-TradePidFile -Service $Service
    $workerPidFile = Get-TradeWorkerPidFile -Service $Service
    $recordedWrapper = Read-TradePidFile -Path $pidFile
    $recordedWorker = Read-TradePidFile -Path $workerPidFile

    $result = [PSCustomObject]@{
        Name         = $Service.Name
        Port         = $Service.Port
        Stopped      = $false
        Blocked      = $false
        BlockingPid  = $null
        BlockingName = $null
        BlockingCmd  = $null
    }

    $currentOwner = Get-PortOwner -Port $Service.Port

    if (-not $currentOwner) {
        # Port already free. Still close a lingering wrapper window if it is
        # genuinely ours (verified by command-line signature).
        if ($recordedWrapper -and (Test-TradeWrapperSignature -ProcessId $recordedWrapper -Service $Service)) {
            Write-Host ("  Closing lingering $($Service.Name) window (PID $recordedWrapper)...")
            Invoke-TradeTaskKill -ArgumentList @('/PID', $recordedWrapper, '/T', '/F')
        }
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue
        $result.Stopped = $true
        return $result
    }

    $verified = $false

    if ($recordedWorker -and $currentOwner -eq $recordedWorker) {
        # Ground truth: this is the exact PID we personally observed bind
        # this exact port, moments after we launched it.
        $verified = $true
    } elseif ($recordedWrapper -and (Test-TradeWrapperSignature -ProcessId $recordedWrapper -Service $Service)) {
        # Fallback: current owner is a live descendant of a verified wrapper
        # (covers a --reload worker restart that changed the worker PID).
        $descendants = Get-ProcessDescendantIds -RootProcessId $recordedWrapper
        if ($descendants.Contains($currentOwner)) { $verified = $true }
    } elseif (Test-TradeProjectOwnedProcess -ProcessId $currentOwner) {
        # Root-cause fallback: no PID file exists for this process at all
        # (it wasn't started by this launcher - e.g. a manual `npm run dev`/
        # `uvicorn` in a terminal, an IDE run, or a leftover from before PID
        # tracking existed), but its own command line - or a live ancestor's -
        # plainly references this project's own root folder path. Confidently
        # ours; safe to stop.
        $verified = $true
    }

    if (-not $verified) {
        $info = Get-ProcessInfo -ProcessId $currentOwner
        $result.Blocked = $true
        $result.BlockingPid = $currentOwner
        $result.BlockingName = if ($info) { $info.Name } else { '(unknown)' }
        $result.BlockingCmd = if ($info) { $info.CommandLine } else { '(unavailable)' }
        # Our own recorded PIDs didn't match, so that tracking data is stale
        # or wrong regardless — safe to discard. This never touches the
        # unrelated process itself.
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue
        return $result
    }

    # Snapshot the FULL descendant tree before killing anything. Killing the
    # verified owner first and only afterward tree-walking the wrapper (the
    # original approach) lost a real case: uvicorn's Windows --reload path
    # spawns the actual worker via Python's multiprocessing 'spawn', which
    # duplicates the listening socket handle into a grandchild process. If
    # the immediate parent (the multiprocessing supervisor) is killed before
    # that grandchild is captured, its ParentProcessId chain is already
    # broken by the time a second, separate tree-kill tries to reach it —
    # the grandchild survives, still holding the socket open. Capturing
    # every candidate PID up front, while everything is still alive, avoids
    # this race entirely.
    $attempt = 0
    $freed = $false
    while ($attempt -lt 3 -and -not $freed) {
        $attempt++
        $killSet = New-Object 'System.Collections.Generic.HashSet[int]'
        [void]$killSet.Add($currentOwner)
        foreach ($d in (Get-ProcessDescendantIds -RootProcessId $currentOwner)) { [void]$killSet.Add($d) }
        if ($recordedWrapper) {
            [void]$killSet.Add($recordedWrapper)
            foreach ($d in (Get-ProcessDescendantIds -RootProcessId $recordedWrapper)) { [void]$killSet.Add($d) }
        }
        Write-Host ("  Stopping $($Service.Name): killing $($killSet.Count) tracked process(es) on port $($Service.Port) (attempt $attempt)...")
        foreach ($killPid in $killSet) { Invoke-TradeTaskKill -ArgumentList @('/PID', $killPid, '/F') }

        $freed = Wait-TradePortFree -Port $Service.Port -TimeoutSeconds 10
        if (-not $freed) {
            $nextOwner = Get-PortOwner -Port $Service.Port
            if (-not $nextOwner) { $freed = $true; break }
            # A new process picked up the port between kill sweeps (e.g. a
            # further multiprocessing respawn) — only keep retrying if it is
            # still verifiably part of the same wrapper tree.
            $stillOurs = $false
            if ($recordedWrapper) {
                $liveDescendants = Get-ProcessDescendantIds -RootProcessId $recordedWrapper
                if ($liveDescendants.Contains($nextOwner)) { $stillOurs = $true }
            }
            if (-not $stillOurs) { break }
            $currentOwner = $nextOwner
        }
    }

    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue

    if ($freed) {
        Write-Host ("  $($Service.Name) stopped; port $($Service.Port) released.")
        $result.Stopped = $true
    } else {
        $stillOwner = Get-PortOwner -Port $Service.Port
        Write-Host ("  WARNING: $($Service.Name) was killed but port $($Service.Port) is still reported busy.")
        if ($stillOwner) {
            $info = Get-ProcessInfo -ProcessId $stillOwner
            $result.Blocked = $true
            $result.BlockingPid = $stillOwner
            $result.BlockingName = if ($info) { $info.Name } else { '(unknown)' }
            $result.BlockingCmd = if ($info) { $info.CommandLine } else { '(unavailable)' }
        }
    }
    return $result
}

function Start-TradeServiceProcess {
    param([PSCustomObject]$Service)

    if (-not (Test-Path -LiteralPath $Service.Dir -PathType Container)) {
        throw "$($Service.Name) directory not found: $($Service.Dir)"
    }

    $pidFile = Get-TradePidFile -Service $Service
    $workerPidFile = Get-TradeWorkerPidFile -Service $Service
    Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $workerPidFile -Force -ErrorAction SilentlyContinue

    $launcher = Get-TradeLauncherFile -Service $Service
    $rootForBatch = $ProjectRoot.TrimEnd('\')
    $lines = @(
        '@echo off',
        'setlocal EnableExtensions EnableDelayedExpansion',
        ('title ' + $Service.Name),
        'echo ============================================================',
        ('echo ' + $Service.Name),
        'echo ============================================================',
        ('set "TRADE_ROOT=' + $rootForBatch + '"'),
        'if exist "%TRADE_ROOT%\.env" (',
        '  for /f "usebackq tokens=1,* delims==" %%A in ("%TRADE_ROOT%\.env") do (',
        '    set "__env_key=%%A"',
        '    set "__env_value=%%B"',
        '    if not "!__env_key!"=="" if not "!__env_key:~0,1!"=="#" set "!__env_key!=!__env_value!"',
        '  )',
        ')',
        'echo Loaded root environment: %TRADE_ROOT%\.env',
        ('cd /d "' + $Service.Dir + '"'),
        'echo Working directory: %CD%',
        'echo Command:',
        ('echo   ' + $Service.Command),
        'echo.',
        $Service.Command,
        'echo.',
        ('echo ' + $Service.Name + ' exited with errorlevel %ERRORLEVEL%.'),
        'echo Review the error above.',
        'pause'
    )
    Set-Content -LiteralPath $launcher -Encoding ASCII -Value $lines

    Write-Host ("Starting $($Service.Name)...")
    $process = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/k', $launcher) -PassThru
    Set-Content -LiteralPath $pidFile -Encoding ASCII -Value $process.Id
    Write-Host ("  $($Service.Name) wrapper CMD PID: $($process.Id)")
    return $process.Id
}

function Wait-TradeServiceListening {
    param([PSCustomObject]$Service, [int]$TimeoutSeconds = 45)
    Write-Host ("Waiting for $($Service.Name) on port $($Service.Port)...")
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $owner = Get-PortOwner -Port $Service.Port
        if ($owner) {
            $workerPidFile = Get-TradeWorkerPidFile -Service $Service
            Set-Content -LiteralPath $workerPidFile -Encoding ASCII -Value $owner
            Write-Host ("  OK: $($Service.Name) is listening on port $($Service.Port) (PID $owner).")
            return $owner
        }
        Start-Sleep -Seconds 1
    } while ((Get-Date) -lt $deadline)
    Write-Host ("  ERROR: $($Service.Name) did not listen on port $($Service.Port) within $TimeoutSeconds seconds. Check the $($Service.Name) window for the error.")
    return $null
}

switch ($Action) {
    'PreStartCleanup' {
        Write-Host 'Checking for stale Trade Platform processes on ports 3000/4000/8000...'
        $services = Get-TradeServices -Root $ProjectRoot
        $blocked = @()
        $anyCleaned = $false
        foreach ($service in $services) {
            $before = Get-PortOwner -Port $service.Port
            $hasTracking = Test-Path -LiteralPath (Get-TradePidFile -Service $service) -PathType Leaf
            if (-not $before -and -not $hasTracking) {
                Write-Host ("  $($service.Name): port $($service.Port) is free.")
                continue
            }
            $r = Stop-TradeServiceByName -Service $service
            if ($r.Blocked) {
                $blocked += $r
            } elseif ($before) {
                Write-Host ("  $($service.Name): stale process on port $($service.Port) was stopped.")
                $anyCleaned = $true
            } else {
                Write-Host ("  $($service.Name): cleared stale tracking data (no process was running).")
            }
        }
        if ($blocked.Count -gt 0) {
            Write-Host ''
            Write-Host 'ERROR: The following ports are occupied by processes that could not be verified as belonging to this project:'
            foreach ($b in $blocked) {
                Write-Host ("  Port $($b.Port) ($($b.Name)): PID $($b.BlockingPid), process '$($b.BlockingName)'")
                Write-Host ("    Command line: $($b.BlockingCmd)")
            }
            Write-Host 'Close these processes manually (or confirm they are safe to keep) and re-run start-trade.bat.'
            exit 1
        }
        if ($anyCleaned) { Write-Host 'OK: Stale Trade Platform processes were stopped.' }
        else { Write-Host 'OK: No stale Trade Platform processes found.' }

        # Explicit final confirmation that cleanup actually freed every port,
        # independent of Stop-TradeServiceByName's own internal bookkeeping -
        # startup must never proceed against a port that looks free by
        # coincidence of timing but isn't.
        Write-Host 'Verifying ports 3000/4000/8000 are free before starting...'
        $stillOccupied = @()
        foreach ($service in $services) {
            if (Wait-TradePortFree -Port $service.Port -TimeoutSeconds 5) {
                Write-Host ("  OK: port $($service.Port) ($($service.Name)) is free.")
            } else {
                $stillOccupied += $service
            }
        }
        if ($stillOccupied.Count -gt 0) {
            Write-Host ''
            Write-Host 'ERROR: The following ports are still occupied after cleanup:'
            foreach ($service in $stillOccupied) {
                $owner = Get-PortOwner -Port $service.Port
                $info = if ($owner) { Get-ProcessInfo -ProcessId $owner } else { $null }
                $name = if ($info) { $info.Name } else { '(unknown)' }
                $cmd = if ($info) { $info.CommandLine } else { '(unavailable)' }
                Write-Host ("  Port $($service.Port) ($($service.Name)): PID $owner, process '$name'")
                Write-Host ("    Command line: $cmd")
            }
            exit 1
        }
        exit 0
    }

    'StartAll' {
        $services = Get-TradeServices -Root $ProjectRoot
        foreach ($service in $services) {
            Start-TradeServiceProcess -Service $service | Out-Null
        }
        $failed = $false
        foreach ($service in $services) {
            $owner = Wait-TradeServiceListening -Service $service
            if (-not $owner) { $failed = $true }
        }
        if ($failed) { exit 1 }
        exit 0
    }

    'StopAll' {
        $services = Get-TradeServices -Root $ProjectRoot
        $blocked = @()
        foreach ($service in $services) {
            Write-Host ("$($service.Name):")
            $r = Stop-TradeServiceByName -Service $service
            if ($r.Blocked) {
                $blocked += $r
                Write-Host ("  WARNING: port $($service.Port) is occupied by an unverified process (PID $($r.BlockingPid), '$($r.BlockingName)') and was left untouched.")
                Write-Host ("    Command line: $($r.BlockingCmd)")
            } elseif (-not $r.Stopped) {
                Write-Host ("  WARNING: could not confirm $($service.Name) stopped.")
            }
        }
        Write-Host ''
        Write-Host 'Verifying ports are released...'
        $stillBusy = $false
        foreach ($service in $services) {
            if (Wait-TradePortFree -Port $service.Port -TimeoutSeconds 5) {
                Write-Host ("  OK: port $($service.Port) ($($service.Name)) is free.")
            } else {
                Write-Host ("  WARNING: port $($service.Port) ($($service.Name)) is still occupied.")
                $stillBusy = $true
            }
        }
        if ($blocked.Count -gt 0 -or $stillBusy) { exit 1 }
        exit 0
    }
}
