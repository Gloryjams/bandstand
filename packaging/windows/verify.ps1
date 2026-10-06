param([string]$Zip, [switch]$KeepForBrowser)
$ErrorActionPreference = 'Stop'
if (-not $Zip) { $Zip = (Get-ChildItem (Join-Path $PSScriptRoot 'dist') -Filter '*.zip' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName }
if (-not $Zip) { throw 'Build the Windows ZIP first.' }
$work = Join-Path $env:TEMP ("Bandstand verify " + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
Expand-Archive -LiteralPath $Zip -DestinationPath (Join-Path $work 'first app [test]')
$root = Join-Path $work 'first app [test]\Bandstand'
$data = Join-Path $work 'user profile [test]\Bandstand'
$stdout = Join-Path $work 'launch.out.txt'
$stderr = Join-Path $work 'launch.err.txt'
$proc = $null
$busy = $null
$keep = $false
$lastPorts = @()

function Check([bool]$OK, [string]$Label) {
    if (-not $OK) { throw "FAIL: $Label" }
    Write-Host "[pass] $Label"
}
function Stop-Owned {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ExecutablePath -eq (Join-Path $root 'runtime\python.exe') -or
            ($_.Name -eq 'powershell.exe' -and $_.CommandLine -and
             ($_.CommandLine.Contains((Join-Path $root 'app\ready.ps1')) -or
              $_.CommandLine.Contains((Join-Path $root 'app\launcher.ps1')))) } |
        ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    if ($proc) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
    for ($i = 0; $i -lt 40; $i++) {
        $listening = if ($lastPorts.Count) { @(Get-NetTCPConnection -State Listen -LocalPort $lastPorts -ErrorAction SilentlyContinue) } else { @() }
        if ($listening.Count -eq 0) { return }
        Start-Sleep -Milliseconds 250
    }
    throw 'An owned test instance did not release its ports.'
}
function Start-Owned([switch]$DefaultFolder, [switch]$Wifi) {
    $entry = if ($Wifi) { 'Share Bandstand on Wi-Fi.bat' } else { 'Start Bandstand.bat' }
    $options = '-NoBrowser'
    if (-not $DefaultFolder) { $options += " -DataDir `"$data`"" }
    $previousAppData = $env:LOCALAPPDATA
    Remove-Item -LiteralPath (Join-Path $data '.launch.json') -Force -ErrorAction SilentlyContinue
    try {
        if ($DefaultFolder) { $env:LOCALAPPDATA = Split-Path $data }
        $script:proc = Start-Process -PassThru cmd.exe `
            -ArgumentList '/d','/s','/c',"`"`"$(Join-Path $root $entry)`" $options`"" `
            -WorkingDirectory ([Management.Automation.WildcardPattern]::Escape($root)) -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    } finally { $env:LOCALAPPDATA = $previousAppData }
    for ($i = 0; $i -lt 200; $i++) {
        if (Test-Path -LiteralPath (Join-Path $data '.launch.json')) {
            try {
                $launch = Get-Content -LiteralPath (Join-Path $data '.launch.json') -Raw | ConvertFrom-Json
                $script:lastPorts = @($launch.port, $launch.publicPort)
                if (Test-Path -LiteralPath (Join-Path $data '.key')) {
                    $key = [IO.File]::ReadAllText((Join-Path $data '.key')).Trim()
                    $manifest = Invoke-RestMethod "http://127.0.0.1:$($launch.port)/api/manifest" -Headers @{'X-Bandstand-Key'=$key} -TimeoutSec 1
                    return @{ launch=$launch; key=$key; manifest=$manifest }
                }
            } catch {}
        }
        if ($proc.HasExited) { throw 'The packaged launcher exited before the server was ready.' }
        Start-Sleep -Milliseconds 250
    }
    throw 'The packaged server did not become ready.'
}
try {
    try { $busy = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Any, 7800); $busy.Start() } catch { $busy = $null }
    $first = Start-Owned -DefaultFolder
    Check (Test-Path -LiteralPath (Join-Path $data 'library.db')) 'double-click entrypoint uses the default data folder'
    $port = $first.launch.port
    $base = "http://127.0.0.1:$port"
    $headers = @{'X-Bandstand-Key'=$first.key}
    Check ($port -ne 7800) 'busy port is skipped'
    Check ($first.manifest.pieces.Count -eq 4 -and $first.manifest.setlists.name -contains 'Demo Gig') 'fresh book contains four practice charts and Demo Gig'
    foreach ($path in @('/app/', '/charts/', '/app/manifest.json', '/app/sw.js')) {
        $page = Invoke-WebRequest -UseBasicParsing "$base$path"
        Check ($page.StatusCode -eq 200) "$path is included and served"
    }
    $health = Invoke-RestMethod "$base/api/health"
    Check ($health.chart_editor -eq $true) 'the included chart editor is reported available'
    $identity = Invoke-RestMethod "$base/api/whoami" -Headers $headers
    Check ($identity.role -eq 'director') 'the fresh key signs into the director app'
    $unauthorized = $false
    try { Invoke-RestMethod "$base/api/manifest" -ErrorAction Stop | Out-Null } catch { $unauthorized = [int]$_.Exception.Response.StatusCode -eq 401 }
    Check $unauthorized 'library access without a key is refused'
    $piece = $first.manifest.pieces | Where-Object title -eq 'Demo Blues in F' | Select-Object -First 1
    $file = $first.manifest.files | Where-Object piece_id -eq $piece.id | Select-Object -First 1
    $pdf = Invoke-WebRequest -UseBasicParsing "$base/api/file/$($piece.id)/$($file.id)" -Headers $headers
    Check ($pdf.StatusCode -eq 200 -and $pdf.RawContentLength -gt 100) 'a practice PDF opens from the packaged library'
    $share = Invoke-RestMethod "$base/api/shares" -Method Post -ContentType 'application/json' -Headers $headers `
        -Body (@{target_kind='piece'; target_id=$piece.id; ttl_hours=24} | ConvertTo-Json)
    Check (([Uri]$share.url).Port -eq $first.launch.publicPort) 'share links use the selected guest port'
    $guest = Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$($first.launch.publicPort)/s/$($share.token)"
    Check ($guest.StatusCode -eq 200) 'the packaged guest reader opens a share'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port, $first.launch.publicPort)
    Check ($listeners.Count -eq 2 -and @($listeners | Where-Object LocalAddress -ne '127.0.0.1').Count -eq 0) 'ordinary start listens only on this computer'
    Invoke-RestMethod "$base/api/sync" -Method Post -ContentType 'application/json' -Headers $headers `
        -Body (@{ops=@(@{op='upsert'; entity='setlists'; payload=@{id='01KUSERTESTSETLIST0000000';name='My saved set'}})} | ConvertTo-Json -Depth 8) | Out-Null
    Start-Sleep -Milliseconds 500
    $stream = [IO.File]::Open($stdout, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    try { $reader = [IO.StreamReader]::new($stream); $output = $reader.ReadToEnd() }
    finally { if ($reader) { $reader.Dispose() }; $stream.Dispose() }
    Check (-not $output.Contains($first.key) -and $output -notmatch '#.*key=') 'the launcher never prints a sign-in key'
    Stop-Owned
    Expand-Archive -LiteralPath $Zip -DestinationPath (Join-Path $work 'updated app [test]')
    $root = Join-Path $work 'updated app [test]\Bandstand'
    $updated = Start-Owned
    Check ($updated.key -eq $first.key -and $updated.manifest.setlists.name -contains 'My saved set') 'a replacement app preserves the sign-in and user book'
    Stop-Owned
    $data = Join-Path $work 'second user book'
    $second = Start-Owned
    Check ($second.key -ne $first.key -and $second.manifest.setlists.name -notcontains 'My saved set') 'a new book gets a different key and isolated data'
    Stop-Owned
    $wifi = Start-Owned -Wifi
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $wifi.launch.port, $wifi.launch.publicPort)
    Check ($listeners.Count -eq 2 -and @($listeners | Where-Object LocalAddress -ne '0.0.0.0').Count -eq 0) 'Wi-Fi entrypoint listens on the network only when requested'
    Check ($wifi.key -eq $second.key) 'Wi-Fi sharing keeps the same book and sign-in'
    Stop-Owned
    $failureData = Join-Path $work 'newer schema book'
    New-Item -ItemType Directory $failureData | Out-Null
    & (Join-Path $root 'runtime\python.exe') -c "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.executescript('CREATE TABLE schema_version(version INTEGER); INSERT INTO schema_version VALUES(999);'); c.close()" (Join-Path $failureData 'library.db')
    Check ($LASTEXITCODE -eq 0) 'the newer-schema startup fixture is isolated'
    $failed = Start-Process -PassThru powershell.exe `
        -ArgumentList '-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$(Join-Path $root 'app\launcher.ps1')`"",'-NoBrowser','-DataDir',"`"$failureData`"" `
        -WorkingDirectory $work -RedirectStandardOutput (Join-Path $work 'failure.out.txt') -RedirectStandardError (Join-Path $work 'failure.err.txt')
    if (-not $failed.WaitForExit(15000)) { Stop-Process -Id $failed.Id -Force; throw 'The failed startup did not exit.' }
    Check ($failed.ExitCode -ne 0) 'startup failure returns an error code to the double-click launcher'
    $failureLaunch = Get-Content -LiteralPath (Join-Path $failureData '.launch.json') -Raw | ConvertFrom-Json
    $failedListeners = @(Get-NetTCPConnection -State Listen -LocalPort $failureLaunch.port, $failureLaunch.publicPort -ErrorAction SilentlyContinue)
    Check ($failedListeners.Count -eq 0) 'startup failure cleans up its guest server'
    $second = Start-Owned
    if ($KeepForBrowser) {
        $keep = $true
        @{root=$root; data=$data; port=$second.launch.port; publicPort=$second.launch.publicPort; work=$work; launcherPid=$proc.Id} |
            ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $work 'browser-check.json')
        Write-Host "Browser verification workspace: $work"
    }
} finally {
    if ($busy) { $busy.Stop() }
    if (-not $keep) {
        Stop-Owned
        Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
    }
}
