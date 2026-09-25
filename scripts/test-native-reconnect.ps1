param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'build\native\Release\Codex Token Overlay.exe'}
$profile=Join-Path $repo ('test-results\native-reconnect-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-NativeProfile $profile
$env:CODEX_EXECUTABLE=Join-Path $repo 'build\native\Release\overlay_tests.exe'
$app=Start-NativeTest $Executable $profile
$owned=@()
try {
  Start-Sleep -Seconds 2
  $children=@(Get-CimInstance Win32_Process|Where-Object ParentProcessId -eq $app.Process.Id)
  if($children.Count -ne 1 -or $children[0].Name -ne 'overlay_tests.exe'){throw 'Expected one owned mock App Server'}
  $first=[int]$children[0].ProcessId
  $owned+= $first
  Stop-Process -Id $first -Force
  $watch=[Diagnostics.Stopwatch]::StartNew()
  $replacement=@()
  do {
    Start-Sleep -Milliseconds 200
    $replacement=@(Get-CimInstance Win32_Process|Where-Object {$_.ParentProcessId -eq $app.Process.Id -and $_.ProcessId -ne $first})
  } while($replacement.Count -eq 0 -and $watch.Elapsed.TotalSeconds -lt 8)
  if($replacement.Count -ne 1){throw 'Idle child exit did not trigger immediate reconnect'}
  $owned+= [int]$replacement[0].ProcessId
  Start-Sleep -Seconds 1
  $state=Get-Content (Join-Path $profile 'quota-state.json') -Raw|ConvertFrom-Json
  if(([DateTimeOffset]::UtcNow-[DateTimeOffset]::Parse($state.rateLimitsSyncedAt)).TotalSeconds -gt 3){throw 'Replacement server did not refresh quota'}
  [pscustomobject]@{OldChild=$first;NewChild=$replacement[0].ProcessId;ReconnectSeconds=$watch.Elapsed.TotalSeconds;QuotaRefreshed=$true}|ConvertTo-Json|Tee-Object -FilePath (Join-Path $profile 'result.json')
} finally {
  Send-OverlayCommand $app.Window 205
  if(-not $app.Process.WaitForExit(10000)){throw 'Reconnect test overlay failed to exit'}
  Start-Sleep -Milliseconds 300
  if(@($owned|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue}).Count){throw 'Mock App Server remained after quit'}
}
