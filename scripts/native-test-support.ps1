$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (-not ('OverlayNativeTest' -as [type])) {
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OverlayNativeTest {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int X,Y; }
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out Point point);
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr param);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint id);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr h,StringBuilder name,int size);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h,out Rect rect);
 [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("user32.dll")] public static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder text,int size);
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern uint GetGuiResources(IntPtr process,uint flag);
 public static IntPtr Find(uint id) { IntPtr result=IntPtr.Zero; EnumWindows((h,p)=>{uint candidate;GetWindowThreadProcessId(h,out candidate);var name=new StringBuilder(128);GetClassName(h,name,128);if(candidate==id && name.ToString()=="CodexTokenOverlayNative"){result=h;return false;}return true;},IntPtr.Zero);return result; }
 public static IntPtr Tooltip(uint id) { IntPtr result=IntPtr.Zero; EnumWindows((h,p)=>{uint candidate;GetWindowThreadProcessId(h,out candidate);var name=new StringBuilder(128);GetClassName(h,name,128);if(candidate==id && name.ToString()=="tooltips_class32"){result=h;return false;}return true;},IntPtr.Zero);return result; }
 public static string Text(IntPtr h) {var text=new StringBuilder(1024);GetWindowText(h,text,1024);return text.ToString();}
 public static uint ForegroundProcess() {uint id;GetWindowThreadProcessId(GetForegroundWindow(),out id);return id;}
 public static void Dpi(IntPtr h,int dpi) { Rect r;GetWindowRect(h,out r);IntPtr p=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(Rect)));try{Marshal.StructureToPtr(r,p,false);SendMessage(h,0x02e0,new IntPtr(dpi|(dpi<<16)),p);}finally{Marshal.FreeHGlobal(p);} }
}
'@
}
[void][OverlayNativeTest]::SetThreadDpiAwarenessContext([IntPtr](-4))
function Send-OverlayCommand([IntPtr]$Window,[int]$Command) {
  [void][OverlayNativeTest]::SendMessage($Window,0x0111,[IntPtr]$Command,[IntPtr]::Zero)
}
function Save-OverlayScreenshot([IntPtr]$Window,[string]$Path) {
  [void][OverlayNativeTest]::SetForegroundWindow($Window)
  Start-Sleep -Milliseconds 200
  $bounds = New-Object OverlayNativeTest+Rect
  [void][OverlayNativeTest]::GetWindowRect($Window,[ref]$bounds)
  $bitmap = New-Object System.Drawing.Bitmap(($bounds.Right-$bounds.Left),($bounds.Bottom-$bounds.Top))
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try { $graphics.CopyFromScreen($bounds.Left,$bounds.Top,0,0,$bitmap.Size); $bitmap.Save($Path,[System.Drawing.Imaging.ImageFormat]::Png) }
  finally { $graphics.Dispose(); $bitmap.Dispose() }
}
function Start-NativeTest([string]$Executable,[string]$Profile,[switch]$Fixture) {
  New-Item -ItemType Directory -Force -Path $Profile | Out-Null
  $env:CODEX_OVERLAY_E2E='1'
  $env:CODEX_OVERLAY_E2E_USER_DATA=$Profile
  $env:CODEX_OVERLAY_E2E_FIXTURE= if ($Fixture) { '1' } else { '0' }
  $process = Start-Process -FilePath $Executable -WindowStyle Hidden -PassThru
  $window = [IntPtr]::Zero
  for ($attempt=0;$attempt -lt 100;$attempt++) {
    Start-Sleep -Milliseconds 100
    if ($process.HasExited) { throw "Native overlay exited with $($process.ExitCode)" }
    $window=[OverlayNativeTest]::Find($process.Id)
    if ($window -ne [IntPtr]::Zero) { break }
  }
  if ($window -eq [IntPtr]::Zero) { throw 'Native window was not created' }
  if (-not [OverlayNativeTest]::IsWindowVisible($window)) { Send-OverlayCommand $window 201 }
  return [pscustomobject]@{Process=$process;Window=$window}
}
function Write-NativeProfile([string]$Profile,[switch]$Fixed) {
  New-Item -ItemType Directory -Force -Path $Profile | Out-Null
  $source=Join-Path $env:APPDATA 'codex-token-overlay\quota-state.json'
  $state=Get-Content -LiteralPath $source -Raw | ConvertFrom-Json
  $state.settings.startAtLogin=$false
  $state.settings.expanded=$true
  $state.window.x=40; $state.window.y=90
  if ($Fixed) {
    $time=[DateTimeOffset]::UtcNow
    $reset=$time.AddDays(3).ToUnixTimeSeconds()
    $state.rateLimits=@([pscustomobject]@{limitId='codex';limitName='Codex';planType=$null;rateLimitReachedType=$null;primary=[pscustomobject]@{usedPercent=37;windowDurationMins=10080;resetsAt=$reset};secondary=$null})
    $state.rateLimitsSyncedAt=$time.ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
    $state.quotaHistory=[pscustomobject]@{limitId='codex';resetsAt=$reset;windowDurationMins=10080;observations=@(
      [pscustomobject]@{at=$time.AddHours(-20).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usedPercent=15},
      [pscustomobject]@{at=$time.AddMinutes(-2).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usedPercent=36;projectedUsedPercent=63},
      [pscustomobject]@{at=$time.AddMinutes(-1).ToString('yyyy-MM-ddTHH:mm:ss.fffZ');usedPercent=37;projectedUsedPercent=64}
    )}
  }
  [IO.File]::WriteAllText((Join-Path $Profile 'quota-state.json'),($state|ConvertTo-Json -Depth 20 -Compress),(New-Object Text.UTF8Encoding($false)))
}
