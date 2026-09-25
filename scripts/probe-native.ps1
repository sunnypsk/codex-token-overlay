param([string]$Executable,[int]$WarmupSeconds=15)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'build\native\Release\Codex Token Overlay.exe'}
$profile=Join-Path $repo 'test-results\native-probe'
Write-NativeProfile $profile
$app=Start-NativeTest $Executable $profile
try {
  Start-Sleep -Seconds $WarmupSeconds
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'expanded.png')
  $children=Get-CimInstance Win32_Process | Where-Object ParentProcessId -eq $app.Process.Id
  $ids=@($app.Process.Id)+@($children.ProcessId)
  Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess } | Select-Object Name,IDProcess,@{n='PrivateWorkingSetMB';e={[math]::Round($_.WorkingSetPrivate/1MB,2)}},@{n='PrivateBytesMB';e={[math]::Round($_.PrivateBytes/1MB,2)}} | ConvertTo-Json
  Send-OverlayCommand $app.Window 102
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'collapsed.png')
} finally {
  Send-OverlayCommand $app.Window 205
  if(-not $app.Process.WaitForExit(10000)){throw 'Native shutdown timed out'}
}
