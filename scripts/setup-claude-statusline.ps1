param(
  [string]$Executable = (Join-Path $PSScriptRoot 'Codex Token Overlay.exe'),
  [string]$ClaudeConfigDirectory = $(if ($env:CLAUDE_CONFIG_DIR) { $env:CLAUDE_CONFIG_DIR } else { Join-Path $env:USERPROFILE '.claude' }),
  [string]$Profile = (Join-Path $env:APPDATA 'codex-token-overlay'),
  [switch]$Undo
)
$ErrorActionPreference = 'Stop'
$settingsPath = Join-Path ([IO.Path]::GetFullPath($ClaudeConfigDirectory)) 'settings.json'
$recordPath = Join-Path ([IO.Path]::GetFullPath($Profile)) 'claude-statusline-setup.json'
$cachePath = Join-Path ([IO.Path]::GetFullPath($Profile)) 'claude-usage.json'
function Write-AtomicJson([string]$Path, $Value) {
  $directory = Split-Path $Path -Parent
  [IO.Directory]::CreateDirectory($directory) | Out-Null
  $temporary = Join-Path $directory ([IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
  $stream = New-Object IO.FileStream($temporary, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
  try {
    $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes(($Value | ConvertTo-Json -Depth 100) + [Environment]::NewLine)
    $stream.Write($bytes, 0, $bytes.Length)
    $stream.Flush($true)
  } finally { $stream.Dispose() }
  try {
    if (Test-Path -LiteralPath $Path) { [IO.File]::Replace($temporary, $Path, [NullString]::Value) }
    else { [IO.File]::Move($temporary, $Path) }
  } finally { if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary } }
}
function Same-Json($Left, $Right) {
  return ($Left | ConvertTo-Json -Depth 100 -Compress) -ceq ($Right | ConvertTo-Json -Depth 100 -Compress)
}
function Backup-Settings {
  if (Test-Path -LiteralPath $settingsPath) {
    $backup = $settingsPath + '.codex-overlay-' + [guid]::NewGuid().ToString('N') + '.bak'
    Copy-Item -LiteralPath $settingsPath -Destination $backup
    Write-Output "Settings backup: $backup"
  }
}
$settings = if (Test-Path -LiteralPath $settingsPath) { Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if ($settings -isnot [pscustomobject]) { throw 'Claude settings must be a JSON object; settings were preserved.' }
$record = if (Test-Path -LiteralPath $recordPath) { Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json } else { $null }
if ($record -and $record.settingsPath -cne $settingsPath) { throw 'The setup record belongs to another Claude config directory; settings were preserved.' }
$current = $settings.PSObject.Properties['statusLine']
if ($Undo) {
  if (-not $record) { Write-Output 'No managed Claude status line to undo.'; return }
  if (-not $current -or -not (Same-Json $current.Value $record.managedStatusLine)) {
    throw 'Claude statusLine has changed since setup. It was preserved; no settings were removed.'
  }
  Backup-Settings
  if ($record.hadStatusLine) { $settings.statusLine = $record.previousStatusLine }
  else { $settings.PSObject.Properties.Remove('statusLine') }
  Write-AtomicJson $settingsPath $settings
  Remove-Item -LiteralPath $recordPath
  if (Test-Path -LiteralPath $cachePath) { Remove-Item -LiteralPath $cachePath }
  Write-Output 'Claude status line disconnected. Other Claude settings were preserved.'
  return
}
$Executable = (Resolve-Path -LiteralPath $Executable).Path
$launcher = Join-Path (Split-Path $Executable -Parent) 'claude-statusline.ps1'
if (-not (Test-Path -LiteralPath $launcher)) { throw 'claude-statusline.ps1 must be beside the overlay executable. Run build-native.ps1 or use the packaged build.' }
$managed = [pscustomobject]@{type='command'; command=('powershell -NoProfile -ExecutionPolicy Bypass -File "' + $launcher.Replace('\','/') + '"')}
if ($current -and (-not $record -or -not (Same-Json $current.Value $record.managedStatusLine))) {
  throw 'An existing Claude statusLine was preserved. Remove or integrate it explicitly before connecting the overlay.'
}
if ($record -and $current -and (Same-Json $current.Value $managed)) { Write-Output 'Claude status line is already connected.'; return }
Backup-Settings
$newRecord = [pscustomobject]@{
  version=1; settingsPath=$settingsPath; managedStatusLine=$managed
  hadStatusLine=$(if ($record) { $record.hadStatusLine } else { $null -ne $current })
  previousStatusLine=$(if ($record) { $record.previousStatusLine } elseif ($current) { $current.Value } else { $null })
}
Write-AtomicJson $recordPath $newRecord
if (-not (Test-Path -LiteralPath $cachePath)) {
  Write-AtomicJson $cachePath ([pscustomobject]@{schemaVersion=1; usedPercent=$null; resetsAt=$null; receivedAt=$null})
}
$settings | Add-Member -MemberType NoteProperty -Name statusLine -Value $managed -Force
Write-AtomicJson $settingsPath $settings
Write-Output 'Claude status line connected. Usage appears after the next Claude Code API response.'
