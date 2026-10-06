param([switch]$NoBrowser, [switch]$ShareOnWifi, [string]$DataDir)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $DataDir) { $DataDir = Join-Path $env:LOCALAPPDATA 'Bandstand' }
$data = [IO.Path]::GetFullPath($DataDir)
$newBook = -not (Test-Path -LiteralPath $data) -or @(Get-ChildItem -LiteralPath $data -Force).Count -eq 0
New-Item -ItemType Directory -Force $data | Out-Null
if ($newBook) {
    Get-ChildItem -LiteralPath (Join-Path $root 'seed') -Force | ForEach-Object {
        Copy-Item -LiteralPath $_.FullName -Destination $data -Recurse
    }
}
New-Item -ItemType Directory -Force (Join-Path $data 'library') | Out-Null
$keyPath = Join-Path $data '.key'
if (-not (Test-Path -LiteralPath $keyPath)) {
    $bytes = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    [IO.File]::WriteAllText($keyPath, (-join ($bytes | ForEach-Object { $_.ToString('x2') })), [Text.Encoding]::ASCII)
}

function Find-FreePort([int[]]$Candidates) {
    foreach ($candidate in $Candidates) {
        $free = $true
        # Inspect wildcard listeners without briefly opening a public PowerShell
        # socket, which can cause an unexpected Windows Firewall prompt.
        if (Get-NetTCPConnection -State Listen -LocalPort $candidate -ErrorAction SilentlyContinue) { continue }
        $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, $candidate)
        try { $listener.Start() } catch { $free = $false } finally { $listener.Stop() }
        if ($free) { return $candidate }
    }
    throw 'Bandstand could not find a free port. Close an older Bandstand window and try again.'
}
$port = Find-FreePort (7800..7809)
$publicPort = Find-FreePort (7810..7819)
$bind = '127.0.0.1'
$address = '127.0.0.1'
if ($ShareOnWifi) {
    $route = Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
        Sort-Object RouteMetric, InterfaceMetric | Select-Object -First 1
    if ($route) {
        $lan = Get-NetIPAddress -InterfaceIndex $route.ifIndex -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notmatch '^169[.]254[.]' } |
            Select-Object -First 1 -ExpandProperty IPAddress
    }
    if (-not $lan) { throw 'No Wi-Fi or Ethernet address found. Use Start Bandstand for this computer.' }
    $bind = '0.0.0.0'
    $address = $lan
}
$env:BANDSTAND_DATA_DIR = $data
$env:BANDSTAND_PORT = [string]$port
$env:BANDSTAND_PUBLIC_BASE = "http://${address}:$publicPort"
$env:BANDSTAND_SHARE_PAGES = '1'
$env:BANDSTAND_NAME = 'My gig book'
$env:BANDSTAND_EVENTS_KEY_IN_URL = 'false'
# A key never goes into the console, a log, or a PowerShell command argument.
$env:BANDSTAND_LAUNCH_BASE = "http://${address}:$port"
@{ port=$port; publicPort=$publicPort; base=$env:BANDSTAND_LAUNCH_BASE } |
    ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $data '.launch.json')
Write-Host ''
Write-Host 'Bandstand is starting...'
Write-Host "  http://127.0.0.1:$port/app/"
Write-Host "Your charts and backups: $data"
if ($ShareOnWifi) { Write-Host "Tablet address: $($env:BANDSTAND_LAUNCH_BASE)/app/" }
Write-Host 'Close this window to stop Bandstand.'
$readyArgs = @('-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$(Join-Path $PSScriptRoot 'ready.ps1')`"")
if (-not $NoBrowser) { $readyArgs += '-OpenBrowser' }
$poll = $null
$guest = $null
$serverExit = 1
try {
    $poll = Start-Process -PassThru -NoNewWindow powershell.exe -ArgumentList $readyArgs
    $guest = Start-Process -PassThru -NoNewWindow (Join-Path $root 'runtime\python.exe') `
        -ArgumentList '-m','uvicorn','server.public:app','--host',$bind,'--port',"$publicPort",'--log-level','warning','--no-access-log' `
        -WorkingDirectory ([Management.Automation.WildcardPattern]::Escape($root))
    Push-Location -LiteralPath $root
    try {
        & (Join-Path $root 'runtime\python.exe') -m uvicorn server.main:app --host $bind --port $port --log-level warning --no-access-log
        $serverExit = $LASTEXITCODE
    }
    finally { Pop-Location }
} finally {
    foreach ($proc in @($poll, $guest)) {
        if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    }
}
exit $serverExit
