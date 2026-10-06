param([switch]$OpenBrowser)
$ErrorActionPreference = 'Stop'
$key = [IO.File]::ReadAllText((Join-Path $env:BANDSTAND_DATA_DIR '.key')).Trim()
$url = "http://127.0.0.1:$($env:BANDSTAND_PORT)"
for ($i = 0; $i -lt 360; $i++) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing "$url/api/manifest" -Headers @{'X-Bandstand-Key'=$key} -TimeoutSec 2
        if ($response.StatusCode -eq 200) {
            Write-Host 'Bandstand is ready.'
            if ($OpenBrowser) {
                # On this computer, localhost enables installation and offline storage.
                $pair = "$url/app/#url=$([Uri]::EscapeDataString($url))&key=$([Uri]::EscapeDataString($key))"
                Start-Process $pair
            }
            exit 0
        }
    } catch {}
    Start-Sleep -Milliseconds 250
}
Write-Host 'Bandstand did not become ready. Close this window and try again.'
exit 1
