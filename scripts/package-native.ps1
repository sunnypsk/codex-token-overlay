param([switch]$SkipBuild)
$ErrorActionPreference='Stop'
$repo=Split-Path $PSScriptRoot -Parent
if(-not $SkipBuild){& (Join-Path $PSScriptRoot 'build-native.ps1') -Test}
$unpacked=Join-Path $repo 'release\native\win-unpacked'
New-Item -ItemType Directory -Force -Path $unpacked | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $unpacked 'resources') | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'build\native\Release\Codex Token Overlay.exe') -Destination $unpacked
Copy-Item -LiteralPath (Join-Path $repo 'native\third_party\nlohmann\LICENSE.MIT') -Destination (Join-Path $unpacked 'LICENSE-json.txt')
& node (Join-Path $repo 'node_modules\electron-builder\out\cli\cli.js') --win nsis --x64 --prepackaged $unpacked --config (Join-Path $repo 'electron-builder.native.json')
if($LASTEXITCODE){throw 'Native packaging failed'}
Get-ChildItem -LiteralPath (Join-Path $repo 'release\native') -Filter '*.exe' | Get-FileHash -Algorithm SHA256
