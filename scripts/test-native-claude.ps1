param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo = Split-Path $PSScriptRoot -Parent
if (-not $Executable) { $Executable = Join-Path $repo 'build\native\Release\Codex Token Overlay.exe' }
$profile = Join-Path $repo ('test-results\native-claude ' + [guid]::NewGuid().ToString('N'))
$config = Join-Path $profile 'fake claude config'
$checks = New-Object 'System.Collections.Generic.List[string]'
$cursor=New-Object OverlayNativeTest+Point
[void][OverlayNativeTest]::GetCursorPos([ref]$cursor)
function Assert-Claude([bool]$Value, [string]$Message) {
  if (-not $Value) { throw $Message }
  $checks.Add($Message)
}
function Start-Bridge([string]$Json) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $Executable; $info.Arguments = '--claude-statusline'
  $info.UseShellExecute = $false; $info.CreateNoWindow = $true
  $info.RedirectStandardInput = $true; $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($info)
  $process.StandardInput.Write($Json); $process.StandardInput.Close()
  return $process
}
function Finish-Bridge($Process) {
  if (-not $Process.WaitForExit(10000)) { $Process.Kill(); throw 'Claude bridge timed out' }
  $result = [pscustomobject]@{Code=$Process.ExitCode; Text=$Process.StandardOutput.ReadToEnd(); Error=$Process.StandardError.ReadToEnd()}
  $Process.Dispose()
  Assert-Claude ($result.Code -eq 0) 'Bridge exits successfully without opening an overlay'
  return $result.Text
}
function Sample([double]$Percent, [int]$ResetSeconds=18000) {
  return @{rate_limits=@{five_hour=@{used_percentage=$Percent;resets_at=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()+$ResetSeconds}}} | ConvertTo-Json -Depth 5 -Compress
}
function Cache { return Get-Content -LiteralPath (Join-Path $profile 'claude-usage.json') -Raw | ConvertFrom-Json }
function Replace-Cache($Value) {
  $temporary=Join-Path $profile 'claude-test.tmp'
  [IO.File]::WriteAllText($temporary,($Value|ConvertTo-Json -Depth 10),(New-Object Text.UTF8Encoding($false)))
  [IO.File]::Replace($temporary,(Join-Path $profile 'claude-usage.json'),[NullString]::Value)
}
function Claude-Tip {
  $rectangle=New-Object OverlayNativeTest+Rect
  [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$rectangle)
  [void][OverlayNativeTest]::SetCursorPos(($rectangle.Left+110),($rectangle.Top+46))
  [void][OverlayNativeTest]::SendMessage($app.Window,0x0200,[IntPtr]::Zero,[IntPtr](110 -bor (46 -shl 16)))
  Start-Sleep -Milliseconds 80
  $tip=[OverlayNativeTest]::Tooltip($app.Process.Id)
  return [System.Windows.Automation.AutomationElement]::FromHandle($tip).Current.Name
}
Write-NativeProfile $profile -Fixed
$env:CODEX_OVERLAY_E2E='1'; $env:CODEX_OVERLAY_E2E_USER_DATA=$profile
[IO.Directory]::CreateDirectory($config)|Out-Null
$settingsPath=Join-Path $config 'settings.json'
$original=[pscustomobject]@{theme='dark';hooks=[pscustomobject]@{Stop=@([pscustomobject]@{hooks=@([pscustomobject]@{type='command';command='echo existing-hook'})})}}
[IO.File]::WriteAllText($settingsPath,($original|ConvertTo-Json -Depth 10))
& (Join-Path $PSScriptRoot 'setup-claude-statusline.ps1') -Executable $Executable -ClaudeConfigDirectory $config -Profile $profile
$connected=Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json
Assert-Claude (($connected.hooks|ConvertTo-Json -Depth 10 -Compress) -ceq ($original.hooks|ConvertTo-Json -Depth 10 -Compress)) 'Setup preserves Claude hooks'
Assert-Claude ($connected.theme -eq 'dark' -and $connected.statusLine.command -match 'claude-statusline.ps1') 'Setup adds only statusLine'
$stateHash=(Get-FileHash -LiteralPath (Join-Path $profile 'quota-state.json')).Hash
$text=Finish-Bridge (Start-Bridge (Sample 0))
Assert-Claude ($text -match 'Claude 5h: 0%' -and (Cache).usedPercent -eq 0) 'A real zero is displayed and stored'
$cacheHash=(Get-FileHash -LiteralPath (Join-Path $profile 'claude-usage.json')).Hash
foreach($bad in @('{}','not json','{"rate_limits":{"five_hour":{"used_percentage":null}}}','{"rate_limits":{"five_hour":{"used_percentage":101}}}')) {
  $text=Finish-Bridge (Start-Bridge $bad)
  Assert-Claude ((Get-FileHash -LiteralPath (Join-Path $profile 'claude-usage.json')).Hash -eq $cacheHash) 'Missing or invalid input preserves cache bytes'
}
$children=@(1..8|ForEach-Object {Start-Bridge (Sample ($_*10))})
foreach($child in $children){$null=Finish-Bridge $child}
Assert-Claude ((Cache).usedPercent -ge 10 -and (Cache).usedPercent -le 80) 'Concurrent sessions store one complete percentage without summing'
Assert-Claude ((Get-FileHash -LiteralPath (Join-Path $profile 'quota-state.json')).Hash -eq $stateHash) 'Bridge leaves Codex quota state untouched'
$payload=Sample 100
$launcher=Join-Path (Split-Path $Executable -Parent) 'claude-statusline.ps1'
$text=$payload | & $launcher | Out-String
Assert-Claude ($LASTEXITCODE -eq 0 -and $text -match '100%') 'Packaged PowerShell launcher preserves piped stdin and stdout'
$commandText=$payload | & powershell -NoProfile -Command $connected.statusLine.command | Out-String
Assert-Claude ($LASTEXITCODE -eq 0 -and $commandText -match '100%') 'Configured command works with paths containing spaces'
$env:CODEX_EXECUTABLE=Join-Path $profile 'missing-codex.exe'
[IO.File]::WriteAllText($env:CODEX_EXECUTABLE,'isolated invalid executable')
$app=$null
try {
  $app=Start-NativeTest $Executable $profile
  [OverlayNativeTest]::Dpi($app.Window,96)
  Start-Sleep -Seconds 2
  $text=Finish-Bridge (Start-Bridge (Sample 42))
  Start-Sleep -Milliseconds 1300
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'offline-update.png')
  $tipText=Claude-Tip
  Assert-Claude ($tipText -match '42%[\s\S]*HKT[\s\S]*Last received') "Claude updates while Codex is offline and the overlay lock is held: $tipText (artifacts: $profile)"
  foreach($dpi in @(96,144,192)) {
    [OverlayNativeTest]::Dpi($app.Window,$dpi)
    Start-Sleep -Milliseconds 100
    Save-OverlayScreenshot $app.Window (Join-Path $profile "expanded-$dpi.png")
    $root=[System.Windows.Automation.AutomationElement]::FromHandle($app.Window)
    $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Collapse')
    $toggle=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition).Current.BoundingRectangle
    Send-OverlayCommand $app.Window 102
    $bounds=New-Object OverlayNativeTest+Rect
    [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
    Assert-Claude (($bounds.Right-$bounds.Left) -eq 340*$dpi/96 -and ($bounds.Bottom-$bounds.Top) -eq 124*$dpi/96) "Connected compact geometry at DPI $dpi"
    $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Expand overlay')
    $compactToggle=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition).Current.BoundingRectangle
    Assert-Claude ($toggle -eq $compactToggle) "Expand/collapse button stays at DPI $dpi"
    Save-OverlayScreenshot $app.Window (Join-Path $profile "collapsed-$dpi.png")
    Send-OverlayCommand $app.Window 101
  }
  [OverlayNativeTest]::Dpi($app.Window,96)
  $stale=Cache; $stale.receivedAt=[DateTimeOffset]::UtcNow.AddMinutes(-6).ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
  Replace-Cache $stale
  Start-Sleep -Milliseconds 1300
  Assert-Claude ((Claude-Tip) -match '42%[\s\S]*Last synced') 'Idle Claude retains percentage and shows Last synced'
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'last-synced.png')
  $text=Finish-Bridge (Start-Bridge (Sample 0 3))
  Start-Sleep -Seconds 4
  Assert-Claude ((Claude-Tip) -match 'N/A[\s\S]*Window ended') 'Reset timer expires without a new sample or false zero'
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'expired.png')
  & (Join-Path $PSScriptRoot 'setup-claude-statusline.ps1') -Undo -ClaudeConfigDirectory $config -Profile $profile
  Start-Sleep -Milliseconds 1300
  Send-OverlayCommand $app.Window 102
  [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
  Assert-Claude (($bounds.Bottom-$bounds.Top) -eq 88) 'Undo restores original compact height'
  $restored=Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json
  Assert-Claude (($restored|ConvertTo-Json -Depth 10 -Compress) -ceq ($original|ConvertTo-Json -Depth 10 -Compress)) 'Undo restores only managed settings'
  $custom=[pscustomobject]@{type='command';command='echo user-custom'}
  $restored|Add-Member -NotePropertyName statusLine -NotePropertyValue $custom
  [IO.File]::WriteAllText($settingsPath,($restored|ConvertTo-Json -Depth 10))
  $blocked=$false
  try { & (Join-Path $PSScriptRoot 'setup-claude-statusline.ps1') -Executable $Executable -ClaudeConfigDirectory $config -Profile $profile } catch {$blocked=$true}
  Assert-Claude ($blocked -and (Get-Content -LiteralPath $settingsPath -Raw|ConvertFrom-Json).statusLine.command -eq 'echo user-custom') 'Setup refuses to replace an unrelated status line'
  $checks|ConvertTo-Json|Set-Content (Join-Path $profile 'checks.json')
  $checks
  Write-Output "Claude test artifacts: $profile"
} finally {
  [void][OverlayNativeTest]::SetCursorPos($cursor.X,$cursor.Y)
  if($app) {Send-OverlayCommand $app.Window 205; if(-not $app.Process.WaitForExit(10000)){throw 'Claude UI test shutdown timed out'}}
}
