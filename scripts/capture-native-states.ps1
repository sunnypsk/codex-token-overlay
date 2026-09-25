param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'release\native\win-unpacked\Codex Token Overlay.exe'}
$root=Join-Path $repo ('test-results\native-states-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
New-Item -ItemType Directory -Force $root|Out-Null
$offlineHelper=Join-Path $root 'offline-helper.exe'
Add-Type -TypeDefinition 'public class OfflineQuotaProbe { public static int Main(string[] args) { return 1; } }' -Language CSharp -OutputType ConsoleApplication -OutputAssembly $offlineHelper
foreach($case in @('extras','unknown','reset-deadline','offline')){
  $profile=Join-Path $root $case
  Write-NativeProfile $profile -Fixed
  $path=Join-Path $profile 'quota-state.json'
  $state=Get-Content $path -Raw|ConvertFrom-Json
  $state.window.x=900;$state.window.y=90
  if($case -eq 'unknown'){$state.rateLimits=@();$state.quotaHistory=$null}
  if($case -eq 'extras'){
    foreach($entry in @(@('Extra A',12),@('Extra B',48),@('Extra C',73))){
      $state.rateLimits+= [pscustomobject]@{limitId=$entry[0];limitName=$entry[0];planType=$null;rateLimitReachedType=$null;primary=[pscustomobject]@{usedPercent=$entry[1];windowDurationMins=10080;resetsAt=$state.rateLimits[0].primary.resetsAt};secondary=$null}
    }
  }
  if($case -eq 'reset-deadline'){
    $state.rateLimits[0].primary.resetsAt=[DateTimeOffset]::UtcNow.AddSeconds(5).ToUnixTimeSeconds()
    $state.quotaHistory=$null
  }
  [IO.File]::WriteAllText($path,($state|ConvertTo-Json -Depth 20 -Compress),(New-Object Text.UTF8Encoding($false)))
  if($case -eq 'offline'){$env:CODEX_EXECUTABLE=$offlineHelper}
  $app=Start-NativeTest $Executable $profile -Fixture:($case -ne 'offline')
  try {
    Start-Sleep -Seconds 1
    Save-OverlayScreenshot $app.Window (Join-Path $profile 'before.png')
    if($case -eq 'extras'){
      [void][OverlayNativeTest]::SendMessage($app.Window,0x020a,[IntPtr](-120 -shl 16),[IntPtr]::Zero)
      Save-OverlayScreenshot $app.Window (Join-Path $profile 'scrolled.png')
    }
    if($case -eq 'reset-deadline'){
      Start-Sleep -Seconds 6
      Save-OverlayScreenshot $app.Window (Join-Path $profile 'after-reset.png')
    }
  } finally {
    Send-OverlayCommand $app.Window 205
    if(-not $app.Process.WaitForExit(10000)){throw 'State capture overlay failed to exit'}
  }
}
Write-Output $root
