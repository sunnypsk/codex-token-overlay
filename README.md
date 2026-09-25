# Codex Token Overlay

## Native Windows version (0.2.0)

The native implementation uses C++20, Win32, Direct2D and DirectWrite. It retains
the English quota UI, history, forecasts and tray controls with a solid dark
background. The Electron implementation and its 0.1.15 installer remain the
fallback. Native code is in `native/`; the shipped program has no Electron,
Node.js or WebView runtime. Node is used only for development tests and packaging.

Build prerequisites: Visual Studio 2022 Build Tools with MSVC v143 x64, Windows
SDK 10.0.26100 and C++ CMake tools. The checked-in JSON header is pinned to 3.12.0
and its license and official checksum are documented in `native/third_party/`.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-native.ps1 -Test
$env:NATIVE_TEST_EXE = (Resolve-Path 'build/native/Release/overlay_tests.exe').Path
node node_modules/vitest/vitest.mjs run tests/unit/native-parity.test.ts
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/test-native-ui.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/package-native.ps1
```

The EXE and per-user NSIS installer are written to `release/native/`. Packaging
does not install the application. Close the older overlay before running the
native version against the normal profile. The product/App ID and startup entry
remain `com.local.codextokenoverlay`. Native startup refuses to share the normal
profile with a running older overlay. Both versions use the same exclusive
Windows `lockfile`, so starting the older version while native is running also
refuses a second writer. No unrelated Codex process is terminated.

State stays in `%APPDATA%/codex-token-overlay/quota-state.json`, using the existing
v1 schema. The first replacement creates `quota-state.json.pre-native.bak`;
writes use a flushed temporary file and atomic replacement. Invalid quota data
is reported instead of overwritten. Legacy usage state is read only for migration.
Window x/y remain Electron-compatible DIP coordinates. An optional native monitor
anchor avoids ambiguity when mixed-DPI monitors have overlapping DIP bounds;
v0.1.15 ignores that extra metadata and still reads the standard position fields.
To roll back, close the native version and reinstall the retained 0.1.15 installer;
the existing schema remains readable by that version.

The quota helper runs inside a Windows Job Object, with `TOKIO_WORKER_THREADS=2`
set only in its child environment. Authentication and Codex configuration remain
inherited. The helper is reused between polls and reclaimed on reconnect/exit.

Tests require both `CODEX_OVERLAY_E2E=1` and `CODEX_OVERLAY_E2E_USER_DATA` before
using an isolated profile or fixture. They never change the actual startup entry.
Native UI tests cover UI Automation InvokePattern and **synthetic** 96/144/192 DPI
messages; physical multi-monitor DPI transitions need separate device evidence.

Resource acceptance uses the packaged Release EXE with the real quota helper:
two-minute warmup, ten minutes each collapsed/expanded/hidden, five-second
sampling, combined Private Working Set <=50 MiB and mean machine CPU <=0.1%.
The separate fixture soak runs 30 minutes by default (`-SoakMinutes 60` for one hour) and 100 hide/show cycles, records handles
and GDI/USER resources, and checks for orphaned children. No working-set trimming
is used. Raw samples and binary hashes are saved under `test-results/`.

```powershell
$exe = (Resolve-Path 'release/native/win-unpacked/Codex Token Overlay.exe').Path
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-native.ps1 -Executable $exe -Mode performance
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/measure-native.ps1 -Executable $exe -Mode soak
```

A compact Windows overlay for Codex quota percentages. It shows the current Codex usage percentage, the reset countdown and time, a current-window percentage forecast, and percentages for other available limits. Expanding the overlay shows observed percentage history and a connected line of recorded forecasts of usage at reset, extended to the current reset estimate. The overlay can be collapsed, pinned above other windows, and controlled from the system tray.

The active service reads `account/rateLimits/read` from the local Codex App Server every minute and when Codex reports a limit change. Manual refresh and reconnect remain available. It does not request account token usage, scan local session files, or refresh pricing.

## Updating from 0.1.9

Version 0.1.11 stores only overlay settings, window position, and recent rate limits in `quota-state.json`. On first launch it reads the existing usage state to copy those values. The previous usage files are left untouched, so an older installation can still use them.

If Codex is offline, a still-active cached percentage is marked as last synced; its forecast is unavailable. Once the cached reset time has passed, the percentage and reset display become unavailable until Codex supplies a new window. A missing percentage is never shown as 0%.

Observed trend history begins with the first successful sync after the trend was introduced. Each successful sync now saves the forecast made at that timestamp for the end of the active reset window. Earlier observed readings remain visible, but their historical forecasts are shown as not recorded. One reading per minute is stored in `quota-state.json` for the active primary reset window. Solid lines break when readings are more than two minutes apart; missing forecasts also break the historical forecast line. The latest recorded forecast connects to the current reset estimate; this extension is a guide to the reset value, not an estimate of cumulative usage at intermediate times. An offline or stale overlay keeps both recorded histories visible but hides the extension until sync resumes.

The application ID and installer name remain `Codex Token Overlay` for upgrade compatibility.

## Development

```powershell
pnpm install
pnpm dev
```

Validation and packaging:

```powershell
pnpm typecheck
pnpm test
pnpm build
pnpm dist
pnpm test:e2e
```

The NSIS installer is written to `release/`. Local installers are unsigned.

The forecast extrapolates the current reset window's average percentage-consumption pace. It is an estimate and can change as usage changes.
