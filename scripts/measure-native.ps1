param([Parameter(Mandatory=$true)][string]$Executable,[ValidateSet('performance','soak')][string]$Mode='performance',[string]$RunLabel=(Get-Date -Format 'yyyyMMdd-HHmmss'),[ValidateRange(20,1440)][int]$SoakMinutes=30,[switch]$Smoke,[switch]$ClaudeUsage,[ValidateRange(15,600)][int]$SampleSeconds=600,[ValidateRange(2,120)][int]$WarmupSeconds=120)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
$profile=Join-Path $repo "test-results\native-$Mode-$RunLabel"
Write-NativeProfile $profile -Fixed:($Mode -eq 'soak')
if($ClaudeUsage){
  $received=[DateTimeOffset]::UtcNow
  $claude=[pscustomobject]@{schemaVersion=1;usedPercent=42;resetsAt=$received.AddHours(5).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');receivedAt=$received.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')}
  [IO.File]::WriteAllText((Join-Path $profile 'claude-usage.json'),($claude|ConvertTo-Json -Compress),(New-Object Text.UTF8Encoding($false)))
}
if($Mode -eq 'soak'){
  $statePath=Join-Path $profile 'quota-state.json'
  $state=Get-Content -LiteralPath $statePath -Raw|ConvertFrom-Json
  $state.window.x=450
  [IO.File]::WriteAllText($statePath,($state|ConvertTo-Json -Depth 20 -Compress),(New-Object Text.UTF8Encoding($false)))
}
$app=Start-NativeTest $Executable $profile -Fixture:($Mode -eq 'soak')
$rows=New-Object System.Collections.Generic.List[object]
$childIds=@()
$output=Join-Path $profile 'samples.csv'
Get-FileHash -LiteralPath $Executable -Algorithm SHA256 | ConvertTo-Json | Set-Content (Join-Path $profile 'executable.json')
try {
  $phases=if($Mode -eq 'performance'){@('collapsed','expanded','hidden')}else{@('soak')}
  foreach($phase in $phases){
    if($phase -eq 'collapsed'){Send-OverlayCommand $app.Window 102}
    if($phase -eq 'expanded'){Send-OverlayCommand $app.Window 101}
    if($phase -eq 'hidden'){Send-OverlayCommand $app.Window 104}
    if($phase -eq 'soak'){Send-OverlayCommand $app.Window 104;Send-OverlayCommand $app.Window 201}
    Write-Output "Warmup: $phase"
    Start-Sleep -Seconds $(if($Smoke){2}else{$WarmupSeconds})
    $processTree=@(Get-CimInstance Win32_Process)
    $children=@($processTree | Where-Object ParentProcessId -eq $app.Process.Id)
    $childIds=@($children|ForEach-Object{[int]$_.ProcessId})
    do {
      $added=@($processTree|Where-Object {$childIds -contains $_.ParentProcessId -and $childIds -notcontains $_.ProcessId}|ForEach-Object{[int]$_.ProcessId})
      $childIds+=$added
    } while($added.Count)
    $ids=@($app.Process.Id)+$childIds
    if($Mode -eq 'performance' -and $children.Count -ne 1){throw "Expected one App Server; found $($children.Count)"}
    $elapsed=[Diagnostics.Stopwatch]::StartNew()
    $duration=if($Smoke){15}elseif($Mode -eq 'performance'){$SampleSeconds}else{60*$SoakMinutes}
    $startCpu=0.0
    foreach($id in $ids){$startCpu+=(Get-Process -Id $id).CPU}
    $startGui=[OverlayNativeTest]::GetGuiResources($app.Process.Handle,0)
    $startUser=[OverlayNativeTest]::GetGuiResources($app.Process.Handle,1)
    $sampleIndex=0
    while($elapsed.Elapsed.TotalSeconds -lt $duration){
      $foreground=Get-Process -Id ([OverlayNativeTest]::ForegroundProcess()) -ErrorAction SilentlyContinue
      if(-not $Smoke -and $foreground.ProcessName -eq 'LockApp'){throw 'Desktop locked during acceptance; this run is not valid'}
      if($Mode -eq 'soak' -and $sampleIndex -lt 100){Send-OverlayCommand $app.Window 104;Send-OverlayCommand $app.Window 201}
      $counters=Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $ids -contains $_.IDProcess }
      if(@($counters).Count -ne $ids.Count){throw 'A measured process disappeared'}
      $cpu=0.0;foreach($id in $ids){$cpu+=(Get-Process -Id $id).CPU}
      $current=Get-Process -Id $app.Process.Id
      $row=[pscustomobject]@{Phase=$phase;At=[DateTimeOffset]::UtcNow.ToString('o');Seconds=[math]::Round($elapsed.Elapsed.TotalSeconds,2);PrivateWorkingSetMiB=[math]::Round(($counters|Measure-Object WorkingSetPrivate -Sum).Sum/1MB,3);NativePrivateWorkingSetMiB=[math]::Round(($counters|Where-Object IDProcess -eq $app.Process.Id|Measure-Object WorkingSetPrivate -Sum).Sum/1MB,3);ServerPrivateWorkingSetMiB=[math]::Round(($counters|Where-Object IDProcess -ne $app.Process.Id|Measure-Object WorkingSetPrivate -Sum).Sum/1MB,3);PrivateBytesMiB=[math]::Round(($counters|Measure-Object PrivateBytes -Sum).Sum/1MB,3);CPUSeconds=[math]::Round($cpu-$startCpu,4);ProcessCount=$ids.Count;Handles=$current.HandleCount;GDI=[OverlayNativeTest]::GetGuiResources($app.Process.Handle,0);USER=[OverlayNativeTest]::GetGuiResources($app.Process.Handle,1)}
      $rows.Add($row)
      $row|Export-Csv -LiteralPath $output -NoTypeInformation -Append
      $sampleIndex++
      $delay=5000*$sampleIndex-$elapsed.Elapsed.TotalMilliseconds
      if($delay -gt 0){Start-Sleep -Milliseconds ([int]$delay)}
    }
    $phaseRows=@($rows|Where-Object Phase -eq $phase)
    $summary=[pscustomobject]@{Phase=$phase;AcceptanceRun=(-not $Smoke -and $SampleSeconds -eq 600 -and $WarmupSeconds -eq 120);ClaudeUsage=$ClaudeUsage.IsPresent;DurationSeconds=$duration;Samples=$phaseRows.Count;PeakPrivateWorkingSetMiB=($phaseRows|Measure-Object PrivateWorkingSetMiB -Maximum).Maximum;AverageCPUPercent=100*$phaseRows[-1].CPUSeconds/$phaseRows[-1].Seconds/[Environment]::ProcessorCount;GDIStart=$startGui;GDIEnd=$phaseRows[-1].GDI;USERStart=$startUser;USEREnd=$phaseRows[-1].USER}
    $summary|ConvertTo-Json|Set-Content (Join-Path $profile "$phase-summary.json")
    $summary|ConvertTo-Json -Compress|Write-Output
    if(-not $Smoke -and $Mode -eq 'performance'){
      $saved=Get-Content (Join-Path $profile 'quota-state.json') -Raw|ConvertFrom-Json
      if(-not $saved.rateLimitsSyncedAt -or ([DateTimeOffset]::UtcNow-[DateTimeOffset]$saved.rateLimitsSyncedAt).TotalSeconds -gt 90){throw "Quota sync stopped in $phase"}
    }
    if(-not $Smoke -and $summary.PeakPrivateWorkingSetMiB -gt 50){throw "Memory budget exceeded in $phase"}
    if(-not $Smoke -and $Mode -eq 'performance' -and $summary.AverageCPUPercent -gt 0.1){throw "CPU budget exceeded in $phase"}
    if(-not $Smoke -and $Mode -eq 'soak'){
      $early=($phaseRows|Where-Object Seconds -lt 600|Measure-Object PrivateWorkingSetMiB -Average).Average
      $late=($phaseRows|Where-Object Seconds -ge ($duration-600)|Measure-Object PrivateWorkingSetMiB -Average).Average
      if($late-$early -gt 5 -or $summary.GDIEnd-$summary.GDIStart -gt 2 -or $summary.USEREnd-$summary.USERStart -gt 2){throw 'Soak resource growth requires investigation'}
    }
  }
}finally{
  Send-OverlayCommand $app.Window 205
  if(-not $app.Process.WaitForExit(10000)){throw 'Measured overlay failed to exit'}
  Start-Sleep -Seconds 1
  $remaining=@($childIds|Where-Object{Get-Process -Id $_ -ErrorAction SilentlyContinue})
  if($remaining.Count){throw 'App Server remained after overlay quit'}
}
