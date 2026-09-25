param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'build\native\Release\Codex Token Overlay.exe'}
$electron=Join-Path $repo 'node_modules\electron\dist\electron.exe'
$harness=Join-Path $repo 'tests\fixtures\native-singleton.cjs'
$profile=Join-Path $repo ('test-results\native-singleton-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-NativeProfile $profile -Fixed
function Start-LegacyLock([string]$Report){
  $process=Start-Process -FilePath $electron -ArgumentList @(('"'+$harness+'"'),('"'+$profile+'"'),('"'+$Report+'"')) -WindowStyle Hidden -PassThru
  for($i=0;$i -lt 100 -and -not (Test-Path -LiteralPath $Report);$i++){Start-Sleep -Milliseconds 100}
  if(-not (Test-Path -LiteralPath $Report)){throw 'Electron singleton probe did not report'}
  return $process
}
$app=Start-NativeTest $Executable $profile -Fixture
try {
  Start-Sleep -Seconds 1
  $before=(Get-FileHash (Join-Path $profile 'quota-state.json')).Hash
  $report=Join-Path $profile 'native-first.json'
  $legacy=Start-LegacyLock $report
  if((Get-Content $report -Raw|ConvertFrom-Json).acquired){throw 'Electron acquired native-owned profile'}
  if(-not $legacy.WaitForExit(10000)){throw 'Rejected Electron process did not exit'}
  if((Get-FileHash (Join-Path $profile 'quota-state.json')).Hash -ne $before){throw 'Rejected Electron changed quota state'}
} finally {Send-OverlayCommand $app.Window 205;[void]$app.Process.WaitForExit(10000)}
$report=Join-Path $profile 'electron-first.json'
$legacy=Start-LegacyLock $report
try {
  if(-not (Get-Content $report -Raw|ConvertFrom-Json).acquired){throw 'Electron could not acquire released profile'}
  $before=(Get-FileHash (Join-Path $profile 'quota-state.json')).Hash
  $rejected=Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  if(-not $rejected.WaitForExit(10000) -or $rejected.ExitCode -ne 1){throw 'Native failed to reject Electron-owned profile'}
  if((Get-FileHash (Join-Path $profile 'quota-state.json')).Hash -ne $before){throw 'Rejected native process changed quota state'}
} finally {
  [IO.File]::WriteAllText("$report.quit",'quit')
  if(-not $legacy.WaitForExit(10000)){throw 'Electron singleton probe failed to quit'}
}
Write-Output 'Both launch orders protected; rejected writers left quota state unchanged.'
