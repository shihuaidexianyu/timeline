param(
    [string]$Version,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

function Get-RepoRoot {
    return (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
}

function Get-WorkspaceVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$CargoTomlPath
    )

    $content = Get-Content -LiteralPath $CargoTomlPath -Raw
    if ($content -match '(?ms)^\[workspace\.package\]\s+.*?^version\s*=\s*"([^"]+)"') {
        return $Matches[1]
    }

    throw "Failed to read [workspace.package].version from $CargoTomlPath"
}

function Ensure-SemVerCore {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Value
    )

    if ($Value -notmatch '^\d+\.\d+\.\d+$') {
        throw "Version '$Value' is not a plain MAJOR.MINOR.PATCH value."
    }
}

function Update-JsonVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Value,
        [string]$JsonPath = '$.version'
    )

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable

    switch ($JsonPath) {
        '$.version' {
            $json['version'] = $Value
        }
        '$.packages.root.version' {
            if ($null -ne $json['packages'] -and $null -ne $json['packages']['']) {
                $json['packages']['']['version'] = $Value
            }
        }
        default {
            throw "Unsupported JsonPath: $JsonPath"
        }
    }

    $serialized = $json | ConvertTo-Json -Depth 100
    Set-Content -LiteralPath $Path -Value $serialized -Encoding UTF8
}

function Assert-JsonVersion {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,
        [Parameter(Mandatory = $true)]
        [string]$Expected,
        [string]$JsonPath = '$.version'
    )

    $json = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -AsHashtable
    $actual = switch ($JsonPath) {
        '$.version' { $json['version'] }
        '$.packages.root.version' {
            if ($null -eq $json['packages'] -or $null -eq $json['packages']['']) { $null } else { $json['packages']['']['version'] }
        }
        default { throw "Unsupported JsonPath: $JsonPath" }
    }

    if ($actual -ne $Expected) {
        throw "Version mismatch in $Path at $JsonPath. expected=$Expected actual=$actual"
    }
}

$repoRoot = Get-RepoRoot
$cargoTomlPath = Join-Path $repoRoot 'Cargo.toml'

if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = Get-WorkspaceVersion -CargoTomlPath $cargoTomlPath
}

Ensure-SemVerCore -Value $Version

$targets = @(
    @{ Path = (Join-Path $repoRoot 'apps\web-ui\package.json'); JsonPath = '$.version' },
    @{ Path = (Join-Path $repoRoot 'apps\web-ui\package-lock.json'); JsonPath = '$.version' },
    @{ Path = (Join-Path $repoRoot 'apps\web-ui\package-lock.json'); JsonPath = '$.packages.root.version' },
    @{ Path = (Join-Path $repoRoot 'apps\browser-extension\manifest.json'); JsonPath = '$.version' }
)

if ($CheckOnly) {
    foreach ($target in $targets) {
        Assert-JsonVersion -Path $target.Path -Expected $Version -JsonPath $target.JsonPath
    }
    Write-Host "Version check passed: $Version" -ForegroundColor Green
    exit 0
}

foreach ($target in $targets) {
    Update-JsonVersion -Path $target.Path -Value $Version -JsonPath $target.JsonPath
}

Write-Host "Synchronized project version to $Version" -ForegroundColor Green
