param([string]$Listen = '127.0.0.1:7331', [switch]$AllowInsecureLan)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$serverDir = Join-Path $repo 'server'
$binary = Join-Path $serverDir 'mesho-server.exe'
$nextBinary = Join-Path $serverDir 'mesho-server-next.exe'
if (Test-Path -LiteralPath $nextBinary) { $binary = $nextBinary }
$currentBinary = Join-Path $serverDir 'mesho-server-0.6.exe'
if (Test-Path -LiteralPath $currentBinary) { $binary = $currentBinary }
if (-not (Test-Path -LiteralPath $binary)) {
    Push-Location $serverDir
    try { & go build -o $binary .; if ($LASTEXITCODE -ne 0) { throw 'Go build failed' } }
    finally { Pop-Location }
}
$configPath = Join-Path $serverDir 'server.local.json'
if (-not (Test-Path -LiteralPath $configPath)) {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    @{ invitation = [Convert]::ToBase64String($bytes) } | ConvertTo-Json | Set-Content -LiteralPath $configPath -Encoding UTF8
}
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$env:MESHO_INVITE = $config.invitation
Write-Host "Mesho server: $Listen"
Write-Host "Team invitation: $($config.invitation)"
$serverArgs = @('--listen', $Listen, '--db', (Join-Path $serverDir 'mesho.db'))
if ($AllowInsecureLan) { $serverArgs += '--allow-insecure-lan' }
& $binary @serverArgs
