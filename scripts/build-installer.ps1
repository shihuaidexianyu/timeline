param(
    [ValidateSet('release')]
    [string]$Profile = 'release',
    [switch]$SkipBuild,
    [string]$InnoSetupCompiler
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Require-Command {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $command) {
        throw "Required command '$Name' was not found in PATH."
    }

    return $command.Source
}

function Copy-DirectoryContents {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Source,
        [Parameter(Mandatory = $true)]
        [string]$Destination
    )

    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Copy-Item -Path (Join-Path $Source '*') -Destination $Destination -Recurse -Force
}

function Remove-PathIfExists {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$AllowedRoot
    )

    if (Test-Path -LiteralPath $Path) {
        $resolvedPath = (Resolve-Path -LiteralPath $Path).Path.TrimEnd('\')
        $resolvedRoot = (Resolve-Path -LiteralPath $AllowedRoot).Path.TrimEnd('\')
        if ($resolvedPath -ne $resolvedRoot -and -not $resolvedPath.StartsWith("$resolvedRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to remove path outside workspace: $resolvedPath"
        }

        Remove-Item -LiteralPath $resolvedPath -Recurse -Force
    }
}

function Resolve-InnoSetupCompiler {
    param(
        [string]$ExplicitPath
    )

    if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
        if (Test-Path -LiteralPath $ExplicitPath -PathType Leaf) {
            return (Resolve-Path -LiteralPath $ExplicitPath).Path
        }

        throw "Inno Setup compiler was not found at '$ExplicitPath'."
    }

    $command = Get-Command 'ISCC.exe' -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        return $command.Source
    }

    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace(${env:ProgramFiles(x86)})) {
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 7\ISCC.exe'
        $candidates += Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'
    }
    if (-not [string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        $candidates += Join-Path $env:ProgramFiles 'Inno Setup 7\ISCC.exe'
        $candidates += Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'
    }

    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw "Inno Setup compiler was not found. Install Inno Setup 6/7 or pass -InnoSetupCompiler C:\Path\ISCC.exe."
}

$repoRoot = Get-RepoRoot
$webUiDir = Join-Path $repoRoot 'apps\web-ui'
$extensionDir = Join-Path $repoRoot 'apps\browser-extension'
$stageRoot = Join-Path $repoRoot 'target\installer\stage'
$installSourceDir = Join-Path $stageRoot 'app'
$installerScript = Join-Path $repoRoot 'installer\timeline.iss'
$outputRoot = Join-Path $repoRoot 'target\installer\output'
$setupPath = Join-Path $outputRoot 'timeline-setup.exe'

if (-not $SkipBuild) {
    Require-Command -Name 'cargo' | Out-Null
    Require-Command -Name 'npm' | Out-Null

    Write-Host 'Cleaning previous build outputs...' -ForegroundColor Cyan
    Remove-PathIfExists -Path (Join-Path $webUiDir 'dist') -AllowedRoot $repoRoot
    Remove-PathIfExists -Path (Join-Path $webUiDir 'node_modules\.vite') -AllowedRoot $repoRoot
    Remove-PathIfExists -Path (Join-Path $webUiDir 'node_modules\.vite-temp') -AllowedRoot $repoRoot
    Remove-PathIfExists -Path (Join-Path $webUiDir 'node_modules\.tmp') -AllowedRoot $repoRoot

    Push-Location $repoRoot
    try {
        & cargo clean
    }
    finally {
        Pop-Location
    }

    Write-Host 'Building web-ui...' -ForegroundColor Cyan
    Push-Location $webUiDir
    try {
        & npm run build
    }
    finally {
        Pop-Location
    }

    Write-Host 'Building timeline...' -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        & cargo build --profile $Profile -p timeline
    }
    finally {
        Pop-Location
    }
}

$agentBinary = Join-Path $repoRoot "target\$Profile\timeline.exe"
$webUiDist = Join-Path $webUiDir 'dist'

if (-not (Test-Path -LiteralPath $agentBinary -PathType Leaf)) {
    throw "Expected agent binary was not found: $agentBinary"
}
if (-not (Test-Path -LiteralPath (Join-Path $webUiDist 'index.html') -PathType Leaf)) {
    throw "Expected web-ui build output was not found: $webUiDist"
}

Remove-PathIfExists -Path $stageRoot -AllowedRoot $repoRoot
New-Item -ItemType Directory -Path $installSourceDir -Force | Out-Null

$webUiStage = Join-Path $installSourceDir 'web-ui\dist'
$extensionStage = Join-Path $installSourceDir 'browser-extension'
$configStage = Join-Path $installSourceDir 'config'
$dataStage = Join-Path $installSourceDir 'data'

New-Item -ItemType Directory -Path $webUiStage, $extensionStage, $configStage, $dataStage -Force | Out-Null

Copy-Item -LiteralPath $agentBinary -Destination (Join-Path $installSourceDir 'timeline.exe') -Force
Copy-DirectoryContents -Source $webUiDist -Destination $webUiStage
Copy-DirectoryContents -Source $extensionDir -Destination $extensionStage
Copy-Item -LiteralPath (Join-Path $repoRoot 'config\timeline.example.toml') -Destination (Join-Path $configStage 'timeline.example.toml') -Force

$defaultConfig = @'
database_path = "../data/timeline.sqlite"
lockfile_path = "../data/timeline.lock"
log_dir = "../data/logs"
listen_addr = "127.0.0.1:46215"
web_ui_url = "http://127.0.0.1:46215/#/stats"
idle_threshold_secs = 300
poll_interval_millis = 1000
health_reminder_enabled = true
health_reminder_threshold_secs = 3000
debug = false
tray_enabled = true
record_window_titles = true
record_page_titles = true
log_to_file = true
log_retention_days = 7
debug_events_enabled = false
data_retention_days = 365
ignored_apps = []
ignored_domains = []
'@

Set-Content -Path (Join-Path $configStage 'timeline.toml') -Value $defaultConfig -Encoding UTF8

if (-not (Test-Path -LiteralPath (Join-Path $installSourceDir 'timeline.exe') -PathType Leaf)) {
    throw "Installer stage is missing timeline.exe under $installSourceDir"
}
if (-not (Test-Path -LiteralPath (Join-Path $installSourceDir 'web-ui\dist\index.html') -PathType Leaf)) {
    throw "Installer stage is missing built web-ui under $installSourceDir"
}

$iscc = Resolve-InnoSetupCompiler -ExplicitPath $InnoSetupCompiler
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
Remove-Item -LiteralPath $setupPath -Force -ErrorAction SilentlyContinue

Write-Host "Building installer with Inno Setup: $setupPath" -ForegroundColor Cyan
& $iscc `
    "/DSourceDir=$installSourceDir" `
    "/DOutputDir=$outputRoot" `
    $installerScript

if ($LASTEXITCODE -ne 0) {
    throw "Inno Setup compiler failed with exit code $LASTEXITCODE."
}

if (-not (Test-Path -LiteralPath $setupPath -PathType Leaf)) {
    throw "Expected installer was not created: $setupPath"
}

Write-Host "Installer ready: $setupPath" -ForegroundColor Green
