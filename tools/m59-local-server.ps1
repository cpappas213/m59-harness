param(
    [ValidateSet('start', 'stop', 'status')]
    [string]$Action = 'status',
    [string]$SourceRoot = 'C:\code\Meridian59',
    [string]$LabRoot = 'C:\tmp\m59-control-server',
    [int]$GamePort = 15959,
    [int]$AdminPort = 19998
)

$ErrorActionPreference = 'Stop'

function Full-Path([string]$Path) {
    return [IO.Path]::GetFullPath($Path).TrimEnd('\')
}

$source = Full-Path $SourceRoot
$lab = Full-Path $LabRoot
$tmpRoot = (Full-Path 'C:\tmp') + '\'
if (-not ($lab + '\').StartsWith($tmpRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'LabRoot must remain beneath C:\tmp so production server data cannot be selected accidentally'
}
if ($GamePort -lt 1024 -or $GamePort -gt 65535 -or
    $AdminPort -lt 1024 -or $AdminPort -gt 65535 -or $GamePort -eq $AdminPort) {
    throw 'GamePort and AdminPort must be distinct ports between 1024 and 65535'
}

$serverDir = Join-Path $lab 'run\server'
$serverExe = Join-Path $serverDir 'blakserv.exe'
$statePath = Join-Path $lab 'server-state.json'

function Test-Port([int]$Port) {
    $client = New-Object Net.Sockets.TcpClient
    try {
        $pending = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $pending.AsyncWaitHandle.WaitOne(400)) { return $false }
        $client.EndConnect($pending)
        return $true
    } catch {
        return $false
    } finally {
        $client.Dispose()
    }
}

function Read-State {
    if (-not (Test-Path -LiteralPath $statePath)) { return $null }
    try { return Get-Content -LiteralPath $statePath -Raw | ConvertFrom-Json }
    catch { throw "Invalid local server state file: $statePath" }
}

function Get-OwnedProcess($State) {
    if (-not $State -or -not $State.pid) { return $null }
    $process = Get-Process -Id ([int]$State.pid) -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    $actual = Full-Path $process.Path
    if (-not $actual.Equals((Full-Path $serverExe), [StringComparison]::OrdinalIgnoreCase)) {
        throw "PID $($State.pid) is not this lab's blakserv.exe; refusing to signal it"
    }
    return $process
}

function Write-State([hashtable]$State) {
    $State | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

function Prepare-Runtime {
    $sourceServer = Join-Path $source 'run\server'
    foreach ($required in @(
        (Join-Path $sourceServer 'blakserv.exe'),
        (Join-Path $sourceServer 'packages.txt'),
        (Join-Path $sourceServer 'rsc'),
        (Join-Path $source 'resource\rooms'),
        (Join-Path $source 'kod\include\blakston.khd')
    )) {
        if (-not (Test-Path -LiteralPath $required)) { throw "Missing Meridian server input: $required" }
    }

    foreach ($directory in @($serverDir, (Join-Path $serverDir 'loadkod'),
        (Join-Path $serverDir 'rsc'), (Join-Path $serverDir 'memmap'),
        (Join-Path $serverDir 'channel'), (Join-Path $serverDir 'savegame'),
        (Join-Path $serverDir 'checkpoints'))) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $sourceServer 'blakserv.exe') -Destination $serverExe -Force
    Copy-Item -LiteralPath (Join-Path $sourceServer 'packages.txt') -Destination $serverDir -Force
    Copy-Item -Path (Join-Path $sourceServer 'rsc\*') -Destination (Join-Path $serverDir 'rsc') -Force

    # The source tree keeps compiled BOFs beside their KOD files. A normal nmake
    # install flattens these into run/server/loadkod; reproduce that install step
    # without rebuilding or writing into the shared Meridian checkout.
    $bofs = Get-ChildItem -LiteralPath (Join-Path $source 'kod') -Filter '*.bof' -File -Recurse
    if (-not $bofs.Count) { throw 'No compiled Blakod (.bof) files were found in the Meridian source tree' }
    $duplicates = $bofs | Group-Object Name | Where-Object Count -gt 1
    if ($duplicates) { throw "Duplicate BOF basename would make the isolated install ambiguous: $($duplicates[0].Name)" }
    foreach ($bof in $bofs) {
        Copy-Item -LiteralPath $bof.FullName -Destination (Join-Path $serverDir 'loadkod') -Force
    }

    $rooms = (Full-Path (Join-Path $source 'resource\rooms')) + '\'
    $kod = Full-Path (Join-Path $source 'kod')
    $constants = Full-Path (Join-Path $kod 'include\blakston.khd')
    $config = @"
[Path]
Bof                  loadkod\
Memmap               memmap\
Rsc                  rsc\
Rooms                $rooms
Motd                 .\
Channel              channel\
LoadSave             savegame\
Forms                .\
Kodbase              $kod
PackageFile          .\

[Socket]
Port                 $GamePort
MaintenancePort      $AdminPort
MaintenanceMask      127.0.0.1

[Channel]
DebugDisk            Yes
ErrorDisk            Yes
LogDisk              Yes
Flush                Yes

[Auto]
SavePeriod           15

[Constants]
Enabled              Yes
Filename             $constants
"@
    Set-Content -LiteralPath (Join-Path $serverDir 'blakserv.cfg') -Value $config -Encoding ASCII
}

function Send-Admin([string]$Command, [int]$TimeoutMs = 120000) {
    $client = New-Object Net.Sockets.TcpClient
    $client.ReceiveTimeout = $TimeoutMs
    $client.SendTimeout = 5000
    try {
        $client.Connect('127.0.0.1', $AdminPort)
        $stream = $client.GetStream()
        $bytes = [Text.Encoding]::ASCII.GetBytes($Command + "`r`n")
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush()
        $buffer = New-Object byte[] 4096
        $reply = New-Object Text.StringBuilder
        try {
            while (($count = $stream.Read($buffer, 0, $buffer.Length)) -gt 0) {
                [void]$reply.Append([Text.Encoding]::ASCII.GetString($buffer, 0, $count))
                if ($reply.Length -gt 65536) { break }
            }
        } catch [IO.IOException] {
            # A graceful terminate closes the maintenance socket while the save is
            # completing. Process exit below is the authoritative completion signal.
        }
        return $reply.ToString()
    } finally {
        $client.Dispose()
    }
}

switch ($Action) {
    'start' {
        $existing = Read-State
        $owned = Get-OwnedProcess $existing
        if ($owned) {
            Write-Host "Local Meridian server already running (pid $($owned.Id), game $GamePort, admin $AdminPort)"
            break
        }
        if (Test-Port $GamePort) { throw "Game port $GamePort is already in use" }
        if (Test-Port $AdminPort) { throw "Admin port $AdminPort is already in use" }
        Prepare-Runtime
        $stdout = Join-Path $lab 'blakserv.stdout.log'
        $stderr = Join-Path $lab 'blakserv.stderr.log'
        $process = Start-Process -FilePath $serverExe -WorkingDirectory $serverDir -PassThru `
            -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Write-State ([ordered]@{
            schema = 'm59-local-server/v1'; pid = $process.Id; executable = $serverExe
            source = $source; lab = $lab; game_port = $GamePort; admin_port = $AdminPort
            started_at = (Get-Date).ToString('o'); production_data_used = $false
        })
        for ($attempt = 0; $attempt -lt 120; $attempt++) {
            if ($process.HasExited) {
                throw "Local blakserv exited with code $($process.ExitCode); inspect $serverDir\channel\error*.txt"
            }
            if ((Test-Port $GamePort) -and (Test-Port $AdminPort)) {
                Write-Host "Local Meridian server ready: 127.0.0.1:$GamePort (admin $AdminPort), pid $($process.Id)"
                break
            }
            Start-Sleep -Milliseconds 500
        }
        if (-not ((Test-Port $GamePort) -and (Test-Port $AdminPort))) {
            throw 'Local blakserv did not open both ports within 60 seconds'
        }
    }
    'stop' {
        $state = Read-State
        $owned = Get-OwnedProcess $state
        if (-not $owned) {
            Write-Host 'Local Meridian server is not running'
            break
        }
        if (-not (Test-Port $AdminPort)) {
            throw "Owned server pid $($owned.Id) is running but admin port $AdminPort is unavailable; refusing an abrupt stop"
        }
        [void](Send-Admin 'terminate save')
        if (-not $owned.WaitForExit(120000)) {
            throw "Server pid $($owned.Id) did not exit after 'terminate save'; it was not killed"
        }
        Write-State ([ordered]@{
            schema = 'm59-local-server/v1'; pid = $owned.Id; executable = $serverExe
            source = $source; lab = $lab; game_port = $GamePort; admin_port = $AdminPort
            stopped_at = (Get-Date).ToString('o'); exit_code = $owned.ExitCode
            production_data_used = $false
        })
        Write-Host "Local Meridian server checkpointed and stopped (pid $($owned.Id))"
    }
    'status' {
        $state = Read-State
        $owned = Get-OwnedProcess $state
        [pscustomobject]@{
            running = [bool]$owned
            pid = if ($owned) { $owned.Id } elseif ($state) { $state.pid } else { $null }
            game = "127.0.0.1:$GamePort"
            game_listening = Test-Port $GamePort
            admin = "127.0.0.1:$AdminPort"
            admin_listening = Test-Port $AdminPort
            lab = $lab
            production_data_used = $false
        } | Format-List
    }
}
