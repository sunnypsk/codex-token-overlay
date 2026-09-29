param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'build\native\Release\Codex Token Overlay.exe'}
$root=Join-Path $repo ('test-results\early-forecast-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
$cursor=New-Object OverlayNativeTest+Point
[void][OverlayNativeTest]::GetCursorPos([ref]$cursor)
try {
  foreach($case in @('early','mature')) {
    $profile=Join-Path $root $case
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    $time=[DateTimeOffset]::UtcNow
    $start=if($case -eq 'early'){$time.AddMilliseconds(-2863766)}else{$time.AddHours(-63)}
    $reset=$start.AddDays(7).ToUnixTimeSeconds()
    $used=if($case -eq 'early'){2}else{44}
    $points=@([ordered]@{at=$start.AddMilliseconds(2863766).ToString('o');usedPercent=2;projectedUsedPercent=422.4})
    if($case -eq 'mature') {
      $points+= [ordered]@{at=$time.AddHours(-1).ToString('o');usedPercent=43;projectedUsedPercent=118.5}
      $points+= [ordered]@{at=$time.AddMinutes(-1).ToString('o');usedPercent=44;projectedUsedPercent=117.4}
    }
    $state=[ordered]@{version=1;settings=@{alwaysOnTop=$true;startAtLogin=$false;expanded=$true};window=@{x=400;y=100};
      rateLimits=@(@{limitId='codex';limitName='Codex';planType=$null;rateLimitReachedType=$null;
        primary=@{usedPercent=$used;windowDurationMins=10080;resetsAt=$reset};secondary=$null});
      rateLimitsSyncedAt=$time.ToString('o');quotaHistory=@{limitId='codex';resetsAt=$reset;windowDurationMins=10080;observations=$points}}
    [IO.File]::WriteAllText((Join-Path $profile 'quota-state.json'),($state|ConvertTo-Json -Depth 20),(New-Object Text.UTF8Encoding($false)))
    $app=Start-NativeTest $Executable $profile -Fixture
    try {
      Start-Sleep -Seconds 1
      foreach($dpi in @(96,144)) {
        [OverlayNativeTest]::Dpi($app.Window,$dpi)
        Save-OverlayScreenshot $app.Window (Join-Path $profile "expanded-$dpi.png")
        Send-OverlayCommand $app.Window 102
        Save-OverlayScreenshot $app.Window (Join-Path $profile "collapsed-$dpi.png")
        Send-OverlayCommand $app.Window 101
      }
      [OverlayNativeTest]::Dpi($app.Window,96)
      $bounds=New-Object OverlayNativeTest+Rect
      [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
      [void][OverlayNativeTest]::SetCursorPos(($bounds.Left+50),($bounds.Top+381))
      [void][OverlayNativeTest]::SendMessage($app.Window,0x0200,[IntPtr]::Zero,[IntPtr](50 -bor (381 -shl 16)))
      Start-Sleep -Milliseconds 200
      $tooltip=[OverlayNativeTest]::Tooltip($app.Process.Id)
      if(-not [OverlayNativeTest]::IsWindowVisible($tooltip)){throw "$case early-point tooltip missing"}
      $label=[System.Windows.Automation.AutomationElement]::FromHandle($tooltip).Current.Name
      if($label -notmatch 'Observed 2%[\s\S]*Early estimate at reset 422'){throw "Unexpected tooltip: $label"}
      Save-OverlayScreenshot $app.Window (Join-Path $profile 'early-tooltip.png')
      Write-Output "$case tooltip passed: $label"
    } finally {
      Send-OverlayCommand $app.Window 205
      if(-not $app.Process.WaitForExit(10000)){throw 'Early forecast test shutdown timed out'}
    }
  }
} finally {
  [void][OverlayNativeTest]::SetCursorPos($cursor.X,$cursor.Y)
}
Write-Output $root
