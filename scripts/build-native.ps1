param([switch]$Test)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
$vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $installation) { throw 'Install MSVC v143, Windows SDK 26100 and C++ CMake tools with Visual Studio 2022 Build Tools.' }
$cmake = Join-Path $installation 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'
$build = Join-Path $repo 'build\native'
& $cmake -S (Join-Path $repo 'native') -B $build -G 'Visual Studio 17 2022' -A x64
if ($LASTEXITCODE) { throw 'Native configure failed' }
& $cmake --build $build --config Release --parallel
if ($LASTEXITCODE) { throw 'Native build failed' }
foreach ($helper in @('claude-statusline.ps1','setup-claude-statusline.ps1')) {
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot $helper) -Destination (Join-Path $build 'Release')
}
if ($Test) {
  & (Join-Path $installation 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\ctest.exe') --test-dir $build -C Release --output-on-failure
  if ($LASTEXITCODE) { throw 'Native tests failed' }
}
