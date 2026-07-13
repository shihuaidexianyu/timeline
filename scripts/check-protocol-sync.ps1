param()

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$rust = Get-Content -LiteralPath (Join-Path $repoRoot 'crates\common\src\lib.rs') -Raw
$typescript = Get-Content -LiteralPath (Join-Path $repoRoot 'apps\web-ui\src\shared\api\types.ts') -Raw

function Get-RustStructFields {
    param([Parameter(Mandatory = $true)][string]$Name)
    $match = [regex]::Match($rust, "(?ms)^pub struct $Name\s*\{(?<body>.*?)^\}")
    if (-not $match.Success) { throw "Rust protocol struct not found: $Name" }
    return @([regex]::Matches($match.Groups['body'].Value, '(?m)^\s*pub\s+([A-Za-z_][A-Za-z0-9_]*)\s*:') | ForEach-Object { $_.Groups[1].Value })
}

function Get-TypeScriptFields {
    param([Parameter(Mandatory = $true)][string]$Name)
    $match = [regex]::Match($typescript, "(?ms)^export type $Name\s*=\s*\{(?<body>.*?)^\}")
    if (-not $match.Success) { throw "TypeScript protocol type not found: $Name" }
    return @([regex]::Matches($match.Groups['body'].Value, '(?m)^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:') | ForEach-Object { $_.Groups[1].Value })
}

function Convert-ToSnakeCase {
    param([Parameter(Mandatory = $true)][string]$Value)
    return ([regex]::Replace($Value, '([a-z0-9])([A-Z])', '$1_$2')).ToLowerInvariant()
}

function Assert-StructFieldsMatch {
    param([Parameter(Mandatory = $true)][string]$Name)
    $rustFields = Get-RustStructFields -Name $Name
    $typescriptFields = Get-TypeScriptFields -Name $Name
    if (($rustFields -join ',') -ne ($typescriptFields -join ',')) {
        throw "Protocol fields differ for ${Name}: Rust=[$($rustFields -join ', ')] TypeScript=[$($typescriptFields -join ', ')]"
    }
}

function Assert-EnumValuesMatch {
    param([Parameter(Mandatory = $true)][string]$Name)
    $rustMatch = [regex]::Match($rust, "(?ms)^pub enum $Name\s*\{(?<body>.*?)^\}")
    if (-not $rustMatch.Success) { throw "Rust protocol enum not found: $Name" }
    $rustValues = @([regex]::Matches($rustMatch.Groups['body'].Value, '(?m)^\s*([A-Z][A-Za-z0-9_]*)\s*,?\s*$') | ForEach-Object { Convert-ToSnakeCase $_.Groups[1].Value })
    $typescriptMatch = [regex]::Match($typescript, "(?m)^export type $Name\s*=\s*(?<body>[^\r\n]+)")
    if (-not $typescriptMatch.Success) { throw "TypeScript protocol enum not found: $Name" }
    $typescriptValues = @([regex]::Matches($typescriptMatch.Groups['body'].Value, "'([^']+)'") | ForEach-Object { $_.Groups[1].Value })
    if (($rustValues -join ',') -ne ($typescriptValues -join ',')) {
        throw "Protocol enum values differ for ${Name}: Rust=[$($rustValues -join ', ')] TypeScript=[$($typescriptValues -join ', ')]"
    }
}

$structs = @(
    'AppInfo',
    'FocusSegment',
    'BrowserSegment',
    'PresenceSegment',
    'TimelineDayResponse',
    'DurationStat',
    'FocusStats',
    'ActiveRollupStatus',
    'HealthResponse',
    'AgentMonitorStatus',
    'RecentTrackedItem',
    'AgentSettingsResponse',
    'PauseTrackingRequest',
    'TrackingStateResponse',
    'UpdateRetentionRequest',
    'DeleteDataRequest',
    'UpdateAutostartRequest',
    'UpdateAutostartResponse',
    'UpdateAgentConfigRequest',
    'UpdateAgentConfigResponse',
    'DebugEvent',
    'BrowserEventPayload',
    'BrowserEventAck',
    'KeyedDurationEntry',
    'DaySummary',
    'MonthCalendarResponse',
    'PeriodStat',
    'PeriodSummaryResponse',
    'AppUsageTrendSeries',
    'AppUsageTrendResponse'
)

foreach ($name in $structs) { Assert-StructFieldsMatch -Name $name }
Assert-EnumValuesMatch -Name 'PresenceState'
Assert-EnumValuesMatch -Name 'TrendPeriod'

Write-Host "Rust/TypeScript protocol mirrors are consistent ($($structs.Count) structs, 2 enums)." -ForegroundColor Green
