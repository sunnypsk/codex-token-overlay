param([string]$Executable)
. (Join-Path $PSScriptRoot 'native-test-support.ps1')
$repo=Split-Path $PSScriptRoot -Parent
if(-not $Executable){$Executable=Join-Path $repo 'release\native\win-unpacked\Codex Token Overlay.exe'}
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class NativeMenuProbe {
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 public delegate bool EnumProc(IntPtr h,IntPtr p);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int size);
 [DllImport("user32.dll")] public static extern int GetMenuItemCount(IntPtr menu);
 [DllImport("user32.dll")] public static extern uint GetMenuItemID(IntPtr menu,int index);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetMenuString(IntPtr menu,uint item,StringBuilder text,int size,uint flags);
 public static string Item(IntPtr menu,uint index) {var text=new StringBuilder(256);GetMenuString(menu,index,text,256,0x400);return text.ToString();}
 public static IntPtr Menu(uint id) {IntPtr result=IntPtr.Zero;EnumWindows((h,p)=>{uint candidate;GetWindowThreadProcessId(h,out candidate);var name=new StringBuilder(128);GetClassName(h,name,128);if(candidate==id && name.ToString()=="#32768"){result=h;return false;}return true;},IntPtr.Zero);return result;}
}
'@
$profile=Join-Path $repo ('test-results\native-tray-'+(Get-Date -Format 'yyyyMMdd-HHmmss'))
Write-NativeProfile $profile -Fixed
$state=Get-Content (Join-Path $profile 'quota-state.json') -Raw|ConvertFrom-Json
$state.window.x=900;$state.window.y=90
[IO.File]::WriteAllText((Join-Path $profile 'quota-state.json'),($state|ConvertTo-Json -Depth 20 -Compress),(New-Object Text.UTF8Encoding($false)))
$cursor=New-Object OverlayNativeTest+Point
[void][OverlayNativeTest]::GetCursorPos([ref]$cursor)
$app=Start-NativeTest $Executable $profile -Fixture
try {
  Start-Sleep -Milliseconds 400
  [void][OverlayNativeTest]::SetCursorPos(1000,300)
  [void][NativeMenuProbe]::PostMessage($app.Window,0x8002,[IntPtr]1,[IntPtr]0x0205)
  Start-Sleep -Milliseconds 350
  $menu=[NativeMenuProbe]::Menu($app.Process.Id)
  if($menu -eq [IntPtr]::Zero){throw 'Native tray menu window did not open'}
  Save-OverlayScreenshot $app.Window (Join-Path $profile 'tray-menu.png')
  [pscustomobject]@{MenuVisible=[OverlayNativeTest]::IsWindowVisible($menu);Foreground=[OverlayNativeTest]::ForegroundProcess();ExpectedProcess=$app.Process.Id}|ConvertTo-Json|Set-Content (Join-Path $profile 'menu-window.json')
  $menuHandle=[OverlayNativeTest]::SendMessage($menu,0x01e1,[IntPtr]::Zero,[IntPtr]::Zero)
  $names=@(0..([NativeMenuProbe]::GetMenuItemCount($menuHandle)-1)|ForEach-Object{[NativeMenuProbe]::Item($menuHandle,$_)}|Where-Object{$_})
  foreach($expected in @('Hide','Always on top','Start with Windows','Refresh now','Quit')){if($names -notcontains $expected){throw "Missing tray menu item $expected; found $names"}}
  $hideCommand=[NativeMenuProbe]::GetMenuItemID($menuHandle,0)
  if($hideCommand -ne 201){throw 'Tray Hide has the wrong command ID'}
  [void][OverlayNativeTest]::SendMessage($app.Window,0x001f,[IntPtr]::Zero,[IntPtr]::Zero)
  Send-OverlayCommand $app.Window $hideCommand
  Start-Sleep -Milliseconds 200
  if([OverlayNativeTest]::IsWindowVisible($app.Window)){throw 'Tray menu Hide did not hide overlay'}
  [void][NativeMenuProbe]::PostMessage($app.Window,0x8002,[IntPtr]1,[IntPtr]0x0202)
  Start-Sleep -Milliseconds 200
  if(-not [OverlayNativeTest]::IsWindowVisible($app.Window)){throw 'Tray left click did not restore overlay'}
  $names|ConvertTo-Json|Set-Content (Join-Path $profile 'menu-items.json')
  Write-Output 'Native tray popup labels and command IDs passed; Hide command and left-click callback restore behavior passed.'
} finally {
  [void][NativeMenuProbe]::PostMessage($app.Window,0x001f,[IntPtr]::Zero,[IntPtr]::Zero)
  [void][OverlayNativeTest]::SetCursorPos($cursor.X,$cursor.Y)
  Send-OverlayCommand $app.Window 205
  if(-not $app.Process.WaitForExit(10000)){throw 'Tray test did not exit'}
}
