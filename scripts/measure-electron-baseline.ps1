param([string]$RunLabel=(Get-Date -Format 'yyyyMMdd-HHmmss'))
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
$output=Join-Path $repo "test-results\electron-baseline-$RunLabel"
New-Item -ItemType Directory -Force $output|Out-Null
$installed=Join-Path $env:LOCALAPPDATA 'Programs\Codex Token Overlay\Codex Token Overlay.exe'
$processes=@(Get-CimInstance Win32_Process)
$electron=@($processes|Where-Object ExecutablePath -eq $installed)
if(-not $electron.Count){throw 'Installed Electron overlay is not running'}
$ids=@($electron|ForEach-Object{[int]$_.ProcessId})
do {
  $added=@($processes|Where-Object {$ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId}|ForEach-Object{[int]$_.ProcessId})
  $ids+= $added
} while($added.Count)
$processes|Where-Object {$ids -contains $_.ProcessId}|Select-Object ProcessId,ParentProcessId,Name,ExecutablePath|ConvertTo-Json|Set-Content (Join-Path $output 'processes.json')
Copy-Item -LiteralPath (Join-Path $env:APPDATA 'codex-token-overlay\quota-state.json') -Destination (Join-Path $output 'state-before.json')
Write-Output "Existing Electron overlay baseline: $($ids.Count) processes, read-only, warmup two minutes"
Start-Sleep -Seconds 120
$startCpu=0.0
foreach($id in $ids){$startCpu+=(Get-Process -Id $id).CPU}
$watch=[Diagnostics.Stopwatch]::StartNew()
$index=0
while($watch.Elapsed.TotalSeconds -lt 600){
  $counters=@(Get-CimInstance Win32_PerfFormattedData_PerfProc_Process|Where-Object {$ids -contains $_.IDProcess})
  if($counters.Count -ne $ids.Count){throw 'A baseline process exited; baseline invalid'}
  $cpu=0.0;foreach($id in $ids){$cpu+=(Get-Process -Id $id).CPU}
  [pscustomobject]@{At=[DateTimeOffset]::UtcNow.ToString('o');Seconds=[math]::Round($watch.Elapsed.TotalSeconds,3);PrivateWorkingSetMiB=($counters|Measure-Object WorkingSetPrivate -Sum).Sum/1MB;PrivateBytesMiB=($counters|Measure-Object PrivateBytes -Sum).Sum/1MB;CPUSeconds=$cpu-$startCpu;ProcessCount=$ids.Count}|Export-Csv (Join-Path $output 'samples.csv') -NoTypeInformation -Append
  $index++
  $delay=5000*$index-$watch.Elapsed.TotalMilliseconds
  if($delay -gt 0){Start-Sleep -Milliseconds ([int]$delay)}
}
$rows=@(Import-Csv (Join-Path $output 'samples.csv'))
$summary=[pscustomobject]@{Samples=$rows.Count;ProcessCount=$ids.Count;MinimumPrivateWorkingSetMiB=($rows|Measure-Object PrivateWorkingSetMiB -Minimum).Minimum;AveragePrivateWorkingSetMiB=($rows|Measure-Object PrivateWorkingSetMiB -Average).Average;PeakPrivateWorkingSetMiB=($rows|Measure-Object PrivateWorkingSetMiB -Maximum).Maximum;AverageCPUPercent=100*[double]$rows[-1].CPUSeconds/[double]$rows[-1].Seconds/[Environment]::ProcessorCount;Note='Existing installed overlay left in its current state; no lifecycle or UI changes'}
$summary|ConvertTo-Json|Tee-Object -FilePath (Join-Path $output 'summary.json')
