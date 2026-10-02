param([string]$Executable = (Join-Path $PSScriptRoot 'Codex Token Overlay.exe'))
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object Text.UTF8Encoding($false)
$json = $input | Out-String
$json | & $Executable --claude-statusline | Write-Output
exit $LASTEXITCODE
