param([switch]$SkipWebBuild, [string]$BuildPython = 'python')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$dist = Join-Path $PSScriptRoot 'dist'
$cache = Join-Path $PSScriptRoot 'build-cache'
$scratch = Join-Path $PSScriptRoot '.tmp'
$stage = Join-Path $scratch 'Bandstand'

function Check-Exit([string]$Message) {
    if ($LASTEXITCODE -ne 0) { throw $Message }
}

Push-Location $repo
try {
    $dirty = & git status --porcelain --untracked-files=normal
    Check-Exit 'Cannot inspect the source checkout.'
    if ($dirty) { throw 'Build from a clean committed checkout. The included source must match the app.' }
    $revision = (& git rev-parse HEAD).Trim()
    $version = (& $BuildPython -c "import tomllib; print(tomllib.load(open('server/pyproject.toml','rb'))['project']['version'])").Trim()
    Check-Exit 'Cannot read the Bandstand version.'
    if (-not $SkipWebBuild) {
        foreach ($part in @('client', 'charts')) {
            Push-Location (Join-Path $repo $part)
            try {
                & npm ci --no-audit --no-fund
                Check-Exit "$part dependency install failed."
                if ($part -eq 'charts') { & npm run build:bandstand } else { & npm run build }
                Check-Exit "$part build failed."
            } finally { Pop-Location }
        }
    }
    foreach ($bundle in @('app', 'guest', 'room', 'charts')) {
        $entry = if ($bundle -in @('guest','room')) { "$bundle.html" } else { 'index.html' }
        if (-not (Test-Path (Join-Path $repo "server\static\$bundle\$entry"))) {
            throw "Missing $bundle bundle. Build both client and charts from this checkout."
        }
    }

    New-Item -ItemType Directory -Force $dist, $cache | Out-Null
    $runtimeInfo = Get-Content (Join-Path $PSScriptRoot 'python-runtime.json') -Raw | ConvertFrom-Json
    $embed = Join-Path $cache "python-$($runtimeInfo.version)-embed-amd64.zip"
    if (-not (Test-Path $embed)) {
        Invoke-WebRequest -UseBasicParsing $runtimeInfo.url -OutFile $embed
    }
    if ((Get-FileHash -Algorithm SHA256 $embed).Hash.ToLowerInvariant() -ne $runtimeInfo.sha256) {
        throw 'Embedded Python checksum mismatch. Remove the cached download and try again.'
    }
    if (Test-Path $scratch) { Remove-Item -LiteralPath $scratch -Recurse -Force }
    New-Item -ItemType Directory -Force $stage | Out-Null
    Copy-Item (Join-Path $PSScriptRoot 'package\*') $stage -Recurse
    $runtime = Join-Path $stage 'runtime'
    Expand-Archive -LiteralPath $embed -DestinationPath $runtime
    $pth = Get-ChildItem $runtime -Filter 'python*._pth' | Select-Object -First 1
    $text = [IO.File]::ReadAllText($pth.FullName).Replace('#import site', "..\app`r`nLib\site-packages`r`nimport site")
    [IO.File]::WriteAllText($pth.FullName, $text, [Text.Encoding]::ASCII)
    $site = Join-Path $runtime 'Lib\site-packages'
    & $BuildPython -m pip install --disable-pip-version-check --require-hashes --no-compile `
        --only-binary=:all: --platform win_amd64 --implementation cp --python-version 3.13 --abi cp313 `
        --target $site -r (Join-Path $PSScriptRoot 'requirements-windows.lock')
    Check-Exit 'Pinned Windows dependency install failed.'

    # Copy only Git-tracked server source. No local data or private checkout is read.
    $tracked = & git ls-files server
    Check-Exit 'Cannot list server source.'
    foreach ($relative in $tracked) {
        if ($relative -notmatch '^server/(?:[^/]+\.py|(?:api|ingest)/[^/]+\.py|migrations/[^/]+\.sql|pyproject\.toml|requirements\.lock)$') { continue }
        $target = Join-Path $stage "app\$relative"
        New-Item -ItemType Directory -Force (Split-Path $target) | Out-Null
        Copy-Item -LiteralPath (Join-Path $repo $relative) -Destination $target
    }
    New-Item -ItemType Directory -Force (Join-Path $stage 'app\server\static') | Out-Null
    foreach ($bundle in @('app', 'guest', 'room', 'charts')) {
        Copy-Item -LiteralPath (Join-Path $repo "server\static\$bundle") `
            -Destination (Join-Path $stage "app\server\static\$bundle") -Recurse
    }
    foreach ($legal in @('LICENSE', 'NOTICE', 'TRADEMARKS.md', 'THIRD-PARTY-NOTICES.md', 'licenses')) {
        Copy-Item -LiteralPath (Join-Path $repo $legal) -Destination $stage -Recurse
    }
    New-Item -ItemType Directory -Force (Join-Path $stage 'source') | Out-Null
    & git archive --format=zip "--output=$(Join-Path $stage 'source\Bandstand-source.zip')" HEAD
    Check-Exit 'Cannot include the corresponding source.'
    @{ version=$version; revision=$revision; python=$runtimeInfo.version; platform='windows-x64' } |
        ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $stage 'VERSION.json')

    $python = Join-Path $runtime 'python.exe'
    & $python (Join-Path $PSScriptRoot 'make-demo-charts.py') (Join-Path $stage 'seed\library')
    Check-Exit 'Practice chart generation failed.'
    $previousData = $env:BANDSTAND_DATA_DIR
    try {
        $env:BANDSTAND_DATA_DIR = Join-Path $stage 'seed'
        & $python (Join-Path $PSScriptRoot 'seed-library.py')
        Check-Exit 'Practice book generation failed.'
    } finally { $env:BANDSTAND_DATA_DIR = $previousData }
    $seedKey = [IO.File]::ReadAllText((Join-Path $stage 'seed\.key')).Trim()
    Remove-Item -LiteralPath (Join-Path $stage 'seed\.key') -Force
    Get-ChildItem $stage -Directory -Recurse -Force |
        Where-Object { $_.Name -eq '__pycache__' } |
        Sort-Object FullName -Descending | Remove-Item -Recurse -Force
    # pip's unused console launchers embed the build interpreter's absolute path.
    foreach ($name in @('bin', 'Scripts')) {
        $path = Join-Path $site $name
        if (Test-Path $path) { Remove-Item -LiteralPath $path -Recurse -Force }
    }
    $previousAuditKey = $env:BANDSTAND_AUDIT_FORBIDDEN_KEY
    try {
        $env:BANDSTAND_AUDIT_FORBIDDEN_KEY = $seedKey
        & $BuildPython (Join-Path $PSScriptRoot 'audit-package.py') $stage
        Check-Exit 'Package audit failed.'
    } finally { $env:BANDSTAND_AUDIT_FORBIDDEN_KEY = $previousAuditKey }
    $zip = Join-Path $dist "Bandstand-$version-windows-x64.zip"
    Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal -Force
    $hash = (Get-FileHash -Algorithm SHA256 $zip).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText("$zip.sha256", "$hash  $([IO.Path]::GetFileName($zip))`n", [Text.Encoding]::ASCII)
    Write-Host "Built $([IO.Path]::GetFileName($zip)) ($([math]::Round((Get-Item $zip).Length / 1MB, 1)) MB)."
} finally { Pop-Location }
