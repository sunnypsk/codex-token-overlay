param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'build\native\Release\Codex Token Overlay.exe'}
$profile=Join-Path $repo 'test-results\native-ui'
Write-NativeProfile $profile -Fixed
$app=Start-NativeTest $Executable $profile -Fixture
$cursor=New-Object OverlayNativeTest+Point
[void][OverlayNativeTest]::GetCursorPos([ref]$cursor)
$checks=New-Object System.Collections.Generic.List[string]
function Assert-Native([bool]$Value,[string]$Message){if(-not $Value){throw $Message};$checks.Add($Message)}
function Get-ToggleBounds([string]$Name){
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($app.Window)
  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$Name)
  return $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition).Current.BoundingRectangle
}
function Invoke-NativeButton([string]$Name){
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($app.Window)
  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$Name)
  $button=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  Assert-Native ($null -ne $button) "UI Automation found $Name"
  $pattern=$button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
  $pattern.Invoke();Start-Sleep -Milliseconds 150
}
try {
  Start-Sleep -Seconds 2
  foreach($dpi in @(96,144,192)){
    [OverlayNativeTest]::Dpi($app.Window,$dpi)
    Start-Sleep -Milliseconds 150
    $bounds=New-Object OverlayNativeTest+Rect
    [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
    Assert-Native (($bounds.Right-$bounds.Left) -eq (380*$dpi/96)) "Expanded width at synthetic DPI $dpi"
    Assert-Native (($bounds.Bottom-$bounds.Top) -eq (460*$dpi/96)) "Expanded height without unused quota rows at synthetic DPI $dpi"
    Save-OverlayScreenshot $app.Window (Join-Path $profile "expanded-$dpi.png")
    $toggle=Get-ToggleBounds 'Collapse'
    Invoke-NativeButton 'Collapse'
    [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
    Assert-Native (($bounds.Right-$bounds.Left) -eq (340*$dpi/96)) "Collapsed width at synthetic DPI $dpi"
    $collapsedToggle=Get-ToggleBounds 'Expand overlay'
    Assert-Native ($toggle -eq $collapsedToggle) "Toggle stays at same screen bounds when collapsed at DPI $dpi"
    Save-OverlayScreenshot $app.Window (Join-Path $profile "collapsed-$dpi.png")
    Invoke-NativeButton 'Expand overlay'
    Assert-Native ($toggle -eq (Get-ToggleBounds 'Collapse')) "Toggle stays at same screen bounds when expanded at DPI $dpi"
  }
  [OverlayNativeTest]::Dpi($app.Window,96)
  Start-Sleep -Milliseconds 200
  [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
  [void][OverlayNativeTest]::SetCursorPos(($bounds.Left+218),($bounds.Top+345))
  [void][OverlayNativeTest]::SendMessage($app.Window,0x0200,[IntPtr]::Zero,[IntPtr](218 -bor (345 -shl 16)))
  Start-Sleep -Milliseconds 200
  $tooltip=[OverlayNativeTest]::Tooltip($app.Process.Id)
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'tooltip-attempt.png')
  Assert-Native ([OverlayNativeTest]::IsWindowVisible($tooltip)) 'Historical point tooltip appears'
  $tooltipText=[System.Windows.Automation.AutomationElement]::FromHandle($tooltip).Current.Name
  Assert-Native ($tooltipText -match 'HKT[\s\S]*Observed[\s\S]*Projected at reset') 'Tooltip includes HKT, observation and recorded forecast'
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'tooltip.png')
  [void][OverlayNativeTest]::SendMessage($app.Window,0x02a3,[IntPtr]::Zero,[IntPtr]::Zero)
  Invoke-NativeButton 'Refresh'
  Invoke-NativeButton 'Hide'
  Assert-Native (-not [OverlayNativeTest]::IsWindowVisible($app.Window)) 'Hide releases visible window'
  Send-OverlayCommand $app.Window 201
  Assert-Native ([OverlayNativeTest]::IsWindowVisible($app.Window)) 'Tray show restores window'
  Send-OverlayCommand $app.Window 202
  Assert-Native (([OverlayNativeTest]::GetWindowLongPtr($app.Window,-20).ToInt64() -band 8) -eq 0) 'Pin command removes actual topmost window flag'
  Send-OverlayCommand $app.Window 203
  Start-Sleep -Milliseconds 600
  $saved=Get-Content (Join-Path $profile 'quota-state.json') -Raw | ConvertFrom-Json
  Assert-Native (-not $saved.settings.alwaysOnTop) 'Pin setting persisted'
  Assert-Native ($saved.settings.startAtLogin) 'Login setting persisted in isolated profile'
  $second=Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  Assert-Native ($second.WaitForExit(5000)) 'Second instance exits'
  Assert-Native ($second.ExitCode -eq 0) 'Second instance focuses existing instance'
  $root=[System.Windows.Automation.AutomationElement]::FromHandle($app.Window)
  $condition=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,'Collapse')
  $button=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition)
  $button.SetFocus()
  [void][OverlayNativeTest]::SendMessage([IntPtr]$button.Current.NativeWindowHandle,0x0100,[IntPtr]32,[IntPtr]::Zero)
  [void][OverlayNativeTest]::SendMessage([IntPtr]$button.Current.NativeWindowHandle,0x0101,[IntPtr]32,[IntPtr]::Zero)
  [void][OverlayNativeTest]::GetWindowRect($app.Window,[ref]$bounds)
  Assert-Native (($bounds.Bottom-$bounds.Top) -eq 88) 'Space key activates focused Collapse button'
  Invoke-NativeButton 'Expand overlay'
  [void][OverlayNativeTest]::SetWindowPos($app.Window,[IntPtr]::Zero,650,130,0,0,0x0015)
  [void][OverlayNativeTest]::SendMessage($app.Window,0x0232,[IntPtr]::Zero,[IntPtr]::Zero)
  $hit=[OverlayNativeTest]::SendMessage($app.Window,0x0084,[IntPtr]::Zero,[IntPtr](660 -bor (140 -shl 16)))
  Assert-Native ($hit.ToInt32() -eq 2) 'Header exposes native window dragging'
  for($i=0;$i -lt 100;$i++){Send-OverlayCommand $app.Window 104;Send-OverlayCommand $app.Window 201}
  Assert-Native ([OverlayNativeTest]::IsWindowVisible($app.Window)) '100 hide and show cycles completed'
  [void][OverlayNativeTest]::SendMessage($app.Window,0x0218,[IntPtr]0x12,[IntPtr]::Zero)
  [void][OverlayNativeTest]::SendMessage($app.Window,0x001e,[IntPtr]::Zero,[IntPtr]::Zero)
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'restored.png')
  $checks | ConvertTo-Json | Set-Content (Join-Path $profile 'checks.json')
  $checks
} finally {
  [void][OverlayNativeTest]::SetCursorPos($cursor.X,$cursor.Y)
  Send-OverlayCommand $app.Window 205
  if(-not $app.Process.WaitForExit(10000)){throw 'Native UI test shutdown timed out'}
}
