[CmdletBinding()]
param(
    [switch]$Archive,
    [switch]$Verify,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

function Get-Sha256([string]$Path) {
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-Git([string]$Directory, [string[]]$Arguments) {
    $result = & git -C $Directory @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "git -C $Directory $($Arguments -join ' ') failed"
    }
    return @($result)
}

if ($Archive -and $Verify) {
    throw 'Use either -Archive or -Verify, not both.'
}

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceDir = Join-Path $root 'azahar'
$webDir = Join-Path $root 'web'
$lockPath = Join-Path $root 'artifacts/azahar-web.lock.json'
$artifacts = @(
    @{ Name = 'azahar.js'; Path = Join-Path $webDir 'azahar.js' },
    @{ Name = 'azahar.wasm'; Path = Join-Path $webDir 'azahar.wasm' }
)

foreach ($path in @($sourceDir, $webDir) + $artifacts.Path) {
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Required checkpoint input is missing: $path"
    }
}

$dirty = Get-Git $sourceDir @('status', '--porcelain=v1', '--untracked-files=normal')
if ($dirty.Count -gt 0) {
    throw "azahar/ has uncommitted or untracked changes. Commit them before capturing or verifying a checkpoint.`n$($dirty -join "`n")"
}

$sourceCommit = (@(Get-Git $sourceDir @('rev-parse', 'HEAD')))[0].Trim()
$sourceRemote = (@(Get-Git $sourceDir @('config', '--get', 'remote.origin.url')))[0].Trim()
$sourceUpstream = (@(Get-Git $sourceDir @('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}')))[0].Trim()
$mergeBase = (@(Get-Git $sourceDir @('merge-base', $sourceUpstream, $sourceCommit)))[0].Trim()
& git -C $sourceDir merge-base --is-ancestor $sourceCommit $sourceUpstream
$sourceIsPublished = $LASTEXITCODE -eq 0
$submodules = @(
    Get-Git $sourceDir @('submodule', 'status', '--recursive') | ForEach-Object {
        $line = $_.TrimEnd()
        if ($line -match '^(.)([0-9a-f]+)\s+([^\s]+)(?:\s+\((.*)\))?$') {
            [ordered]@{
                state = $Matches[1]
                commit = $Matches[2]
                path = $Matches[3]
                description = $Matches[4]
            }
        } else {
            [ordered]@{ raw = $line }
        }
    }
)

$artifactInfo = [ordered]@{}
foreach ($artifact in $artifacts) {
    $item = Get-Item -LiteralPath $artifact.Path
    $artifactInfo[$artifact.Name] = [ordered]@{
        path = "web/$($artifact.Name)"
        bytes = $item.Length
        sha256 = Get-Sha256 $artifact.Path
    }
}

$recoveryPatch = $null
if (-not $sourceIsPublished) {
    $patchDir = Join-Path $root 'artifacts/source-patches'
    New-Item -ItemType Directory -Force -Path $patchDir | Out-Null
    $patchName = "azahar-$($sourceCommit.Substring(0, 12)).patch"
    $patchPath = Join-Path $patchDir $patchName
    & git -C $sourceDir format-patch --stdout "$mergeBase..$sourceCommit" | Set-Content -LiteralPath $patchPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to write source recovery patch: $patchPath"
    }
    $recoveryPatch = [ordered]@{
        path = "artifacts/source-patches/$patchName"
        baseCommit = $mergeBase
        sha256 = Get-Sha256 $patchPath
    }
}

if ($Verify) {
    if (-not (Test-Path -LiteralPath $lockPath)) {
        throw "No committed checkpoint lock found at $lockPath"
    }
    $saved = Get-Content -LiteralPath $lockPath -Raw | ConvertFrom-Json
    $problems = [System.Collections.Generic.List[string]]::new()
    if ($saved.source.commit -ne $sourceCommit) { $problems.Add('azahar source commit differs') }
    if ($saved.source.remote -ne $sourceRemote) { $problems.Add('azahar origin differs') }
    if ($saved.source.upstream -ne $sourceUpstream) { $problems.Add('azahar upstream branch differs') }
    foreach ($artifact in $artifacts) {
        $actual = $artifactInfo[$artifact.Name]
        $expected = $saved.artifacts.$($artifact.Name)
        if ($null -eq $expected -or $expected.sha256 -ne $actual.sha256 -or [Int64]$expected.bytes -ne [Int64]$actual.bytes) {
            $problems.Add("$($artifact.Name) differs from checkpoint")
        }
    }
    $savedSubmodules = @($saved.source.submodules | ConvertTo-Json -Depth 8)
    $currentSubmodules = @($submodules | ConvertTo-Json -Depth 8)
    if (($savedSubmodules -join "`n") -ne ($currentSubmodules -join "`n")) {
        $problems.Add('recursive submodule state differs')
    }
    if ($null -ne $saved.source.recoveryPatch) {
        $savedPatch = Join-Path $root $saved.source.recoveryPatch.path
        if (-not (Test-Path -LiteralPath $savedPatch) -or (Get-Sha256 $savedPatch) -ne $saved.source.recoveryPatch.sha256) {
            $problems.Add('source recovery patch differs or is missing')
        }
    }
    if ($problems.Count -gt 0) {
        throw "Checkpoint verification failed: $($problems -join '; ')"
    }
    Write-Output "Checkpoint verified: $sourceCommit"
    exit 0
}

$lock = [ordered]@{
    schemaVersion = 1
    source = [ordered]@{
        repository = 'azahar/'
        remote = $sourceRemote
        upstream = $sourceUpstream
        commit = $sourceCommit
        publishedToUpstream = $sourceIsPublished
        recoveryPatch = $recoveryPatch
        submodules = $submodules
    }
    artifacts = $artifactInfo
}

$lockDir = Split-Path -Parent $lockPath
New-Item -ItemType Directory -Force -Path $lockDir | Out-Null
$lock | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $lockPath -Encoding utf8
Write-Output "Checkpoint lock written: $lockPath"

if ($Archive) {
    $releaseDir = Join-Path $lockDir 'releases'
    New-Item -ItemType Directory -Force -Path $releaseDir | Out-Null
    $archiveName = "azahar-web-$($sourceCommit.Substring(0, 12))-$($artifactInfo['azahar.wasm'].sha256.Substring(0, 12)).zip"
    $archivePath = Join-Path $releaseDir $archiveName
    if ((Test-Path -LiteralPath $archivePath) -and -not $Force) {
        throw "Archive already exists: $archivePath (use -Force to replace it)"
    }
    if (Test-Path -LiteralPath $archivePath) {
        Remove-Item -LiteralPath $archivePath -Force
    }
    # Windows PowerShell 5.1 does not load the enum assembly transitively.
    # Load both assemblies so checkpoint capture works on the project host as
    # well as PowerShell 7.
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::Open($archivePath, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($artifact in $artifacts) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $artifact.Path, $artifact.Name, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
        [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $lockPath, 'azahar-web.lock.json', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        if ($null -ne $recoveryPatch) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $root $recoveryPatch.path), 'source-recovery.patch', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally {
        $zip.Dispose()
    }
    Write-Output "Checkpoint archive written: $archivePath"
}
