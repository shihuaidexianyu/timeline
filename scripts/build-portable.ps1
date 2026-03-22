param(
    [ValidateSet('release')]
    [string]$Profile = 'release',
    [switch]$SkipBuild
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

$repoRoot = Get-RepoRoot
$webUiDir = Join-Path $repoRoot 'apps\web-ui'
$extensionDir = Join-Path $repoRoot 'apps\browser-extension'
$outputRoot = Join-Path $repoRoot 'target\portable\output'
$portableRoot = Join-Path $repoRoot 'target\portable\stage'

$cargoMetadataJson = & cargo metadata --no-deps --format-version 1 --manifest-path (Join-Path $repoRoot 'Cargo.toml')
$cargoMetadata = $cargoMetadataJson | ConvertFrom-Json
$packageVersion = ($cargoMetadata.packages | Where-Object { $_.name -eq 'timeline-agent' } | Select-Object -First 1).version

if ([string]::IsNullOrWhiteSpace($packageVersion)) {
    throw 'Failed to resolve timeline-agent version from cargo metadata.'
}

if (-not $SkipBuild) {
    Require-Command -Name 'cargo' | Out-Null
    Require-Command -Name 'npm' | Out-Null

    Write-Host 'Building web-ui...' -ForegroundColor Cyan
    Push-Location $webUiDir
    try {
        & npm run build
    }
    finally {
        Pop-Location
    }

    Write-Host 'Building timeline-agent...' -ForegroundColor Cyan
    Push-Location $repoRoot
    try {
        & cargo build --profile $Profile -p timeline-agent
    }
    finally {
        Pop-Location
    }
}

$agentBinary = Join-Path $repoRoot "target\$Profile\timeline-agent.exe"
$webUiDist = Join-Path $webUiDir 'dist'

if (-not (Test-Path $agentBinary)) {
    throw "Expected agent binary was not found: $agentBinary"
}

if (-not (Test-Path (Join-Path $webUiDist 'index.html'))) {
    throw "Expected web-ui build output was not found: $webUiDist"
}

Remove-Item -Path $portableRoot -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $outputRoot -Force | Out-Null
New-Item -ItemType Directory -Path $portableRoot -Force | Out-Null

$portableStage = Join-Path $portableRoot "timeline-portable-$packageVersion"
$portableWebUiStage = Join-Path $portableStage 'web-ui\dist'
$portableExtensionStage = Join-Path $portableStage 'browser-extension'
$portableConfigDir = Join-Path $portableStage 'config'
$portableDataDir = Join-Path $portableStage 'data'

New-Item -ItemType Directory -Path $portableStage, $portableWebUiStage, $portableExtensionStage, $portableConfigDir, $portableDataDir -Force | Out-Null

Copy-Item -Path $agentBinary -Destination (Join-Path $portableStage 'timeline-agent.exe') -Force
Copy-DirectoryContents -Source $webUiDist -Destination $portableWebUiStage
Copy-DirectoryContents -Source $extensionDir -Destination $portableExtensionStage
Copy-Item -Path (Join-Path $repoRoot 'config\timeline-agent.example.toml') -Destination (Join-Path $portableConfigDir 'timeline-agent.example.toml') -Force

$portableReadme = @'
Timeline 便携包内容
==================

解压后会包含：

1. timeline-agent.exe
2. 内置的 web-ui/dist 前端静态文件
3. browser-extension 浏览器扩展目录

便携版默认把用户数据写到：
.\data

浏览器扩展安装方法
------------------

1. 打开 edge://extensions 或 chrome://extensions
2. 开启开发者模式
3. 选择“加载已解压的扩展程序”
4. 指向便携包目录下的 browser-extension 文件夹
'@

Set-Content -Path (Join-Path $portableStage 'README-portable.txt') -Value $portableReadme -Encoding UTF8

$portableConfig = @'
database_path = "../data/timeline.sqlite"
lockfile_path = "../data/timeline-agent.lock"
listen_addr = "127.0.0.1:46215"
web_ui_url = "http://127.0.0.1:46215/#/stats"
idle_threshold_secs = 300
poll_interval_millis = 1000
debug = false
tray_enabled = true
record_window_titles = true
record_page_titles = true
ignored_apps = []
ignored_domains = []
'@

Set-Content -Path (Join-Path $portableConfigDir 'timeline-agent.toml') -Value $portableConfig -Encoding UTF8

$portableZip = Join-Path $outputRoot "timeline-portable-$packageVersion.zip"
Remove-Item -Path $portableZip -Force -ErrorAction SilentlyContinue
Compress-Archive -Path (Join-Path $portableStage '*') -DestinationPath $portableZip

Write-Host "Portable package ready: $portableZip" -ForegroundColor Green
