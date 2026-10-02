# Native validation record

## v0.2.1: Claude Code integration, 2026-10-02

Local, uncommitted implementation based on `26766babc44d06094b3e502624aed9941bc75237`. Installation/upgrade, commit and push were not performed. Generated binaries, account caches, fake settings, screenshots and raw measurements remain outside the published source tree.

- Packaged EXE SHA256: `DC105C23646FFB65AB267F8E69C176AA9675B30A9065FF5D29C542E11D0EED03`; byte-identical to the tested Release build, product version 0.2.1.
- Installer SHA256: `B675E2A5A11084E76836DD751D38E4F233D801CBCF7AEDF456F43C4F5A058EAF`; unsigned. Both bundled PowerShell helpers match their source hashes.
- Native core: 106 assertions passed. TypeScript suite with the native parity executable: 169 tests in 22 files passed. Existing typechecks passed; their TypeScript inputs did not change.
- Claude cases cover 0%, 100%, missing/malformed input, reset expiry, stale readings, out-of-order samples and a cache replacement retaining the previous file timestamp. Eight concurrent bridge processes preserved one valid account reading without summing percentages or touching Codex quota state.
- Fake-config checks cover byte-preserving idempotence, paths containing spaces, moving the managed executable, preserving hooks and subsequent unrelated edits, and refusing to replace or undo a user-changed status line. Real connection preserved existing hooks and kept a byte-for-byte settings backup.
- A real Claude Code 2.1.287 status-line payload matched the user's `/usage` percentage. The official integer-second reset differed from Claude's more precise cached timestamp by less than one second, crossing a displayed minute boundary. An isolated copy of a subsequent real payload naturally passed five minutes without further input and retained its percentage and reset countdown with `Last synced`; the actual Claude session was left available for normal use.
- With an invalid Codex executable, Claude updated independently while the main overlay lock was held. Synthetic 96/144/192 DPI checks verified 340 x 124 DIP compact dimensions, fixed toggle bounds, expanded dimensions, freshness and automatic expiry. Existing graph tooltips, keyboard, pinning, tray, dragging and 100 hide/show checks passed.
- One integration run completed all assertions but exceeded its ten-second shutdown deadline; that process subsequently exited. An identical rerun and the real-payload check exited within the deadline. No owned test overlay or App Server remained after final verification.
- Independent verifier confirmed the frozen changed/untracked file hashes and reran native/parity checks. A reviewer found no graph contract drift in warm-up filtering, chart scale, missing forecasts, gap segmentation, reset endpoint or indexed tooltip marks.

### Resource remeasurement

The packaged EXE ran against an isolated copy of approximately 7,400 existing Codex observations, one real Codex App Server and its conhost. Claude's four-field cache was connected. Each mode had 120 seconds of warmup, then 120 seconds of sampling at five-second intervals. CPU is normalized across logical processors. No working-set trimming or observation removal was used.

| State | Samples | Peak combined Private Working Set (MiB) | Mean CPU | GDI start/end | USER start/end |
|---|---:|---:|---:|---:|---:|
| Collapsed | 25 | 35.266 | 0.01361% | 11 / 11 | 15 / 15 |
| Expanded | 24 | 42.535 | 0.01488% | 11 / 11 | 14 / 14 |
| Hidden | 24 | 42.559 | 0.00810% | 11 / 11 | 13 / 14 |

All 73 samples met the <=50 MiB stable-state budget and <=0.1% mean CPU budget. The collapsed boundary sample at 120.52 seconds was included. Codex sync remained fresh at every phase end; the harness exited successfully and confirmed cleanup of its App Server tree.

An initial expanded diagnostic reached 57.332 MiB. Streaming graph geometry from existing observations and retaining only indexes for hover marks removed redundant JSON copies while keeping all observations and recorded forecasts. A later 30-second-warmup diagnostic caught a 69.609 MiB combined spike driven by App Server startup, then settled below 36 MiB. That failed diagnostic was retained, and the final run used the established two-minute warmup. This does not prove that startup or every future App Server operation stays below 50 MiB.

Reproduce the shortened run after building and packaging:

```powershell
$exe = (Resolve-Path 'release/native/win-unpacked/Codex Token Overlay.exe').Path
& './scripts/measure-native.ps1' -Executable $exe -ClaudeUsage -SampleSeconds 120 -WarmupSeconds 120 -RunLabel 'claude-v021-packaged'
```

This is a shortened remeasurement (`AcceptanceRun: false` in the harness), not the default ten-minute-per-mode benchmark or a long soak. Physical mixed-DPI dragging and an actual installer upgrade/rollback remain unverified. The older measurements below apply only to their identified revisions and binaries.

## Earlier native validation, 2026-09-25

Recorded on 2026-09-25 on a Windows x64 workstation. This summary intentionally excludes local account state, machine-specific paths and raw diagnostic captures.

## Tested revisions

- Native implementation: `d4efd1e`.
- Layout correction: `98fd6e0` (centered ring text, fixed toggle coordinates, content-dependent expanded height).
- Resource-tested EXE SHA256: `48DF9D0FFDC44DABF5B643B5F7A199FFA642629C4AF95C9E1A7C0E1A7E52C218`.
- Layout-corrected EXE SHA256: `83607907BD600A6D07B09634C76267080653D7A4B3AA815E54998798A9E4238D`.

Binary hashes identify local builds; rebuilding with another toolchain may produce different hashes. The resource measurements below precede the layout correction. They must not be described as a fresh performance run of the corrected binary.

## Functional evidence

- Native core: 64 assertions passed; existing and added TypeScript tests: 169 tests in 22 files passed; node/web typechecks passed.
- Shared TypeScript/C++ fixtures cover parsing, reset selection, projections, observation cadence, reset tolerance, missing forecasts, stale values and chart gaps.
- Native-written v1 state was read back using the v0.1.15 TypeScript store, including missing/null semantics.
- Corrupt input and failed writes preserve original files; first-write backup, history cap and legacy migration were checked.
- Actual Electron single-instance locking and native profile locking rejected simultaneous writers in both launch orders.
- An idle mock App Server exit recovered in approximately 3.37 seconds; test children were cleaned up.
- Final layout correction: native core tests and UI checks passed. Synthetic 96/144/192 DPI checks verified reduced height and identical screen bounds for Expand/Collapse in the tested positions.
- Tooltip content, keyboard Space activation, topmost state, hide/show, tray commands, drag hit-testing, position saving, additional quota scrolling, offline data and reset expiry were checked.

The images in `docs/images/` use synthetic quota fixtures, not an account's usage history.

## Resource results

Packaged Release EXE with a real, reused Codex App Server. Each state had a two-minute warmup followed by ten minutes of sampling at five-second intervals. Memory includes the overlay, App Server and conhost (three processes). CPU is normalized across the machine's logical processors.

| State | Samples | Mean Private Working Set (MiB) | Peak Private Working Set (MiB) | Peak Private Bytes (MiB) | Mean CPU |
|---|---:|---:|---:|---:|---:|
| Collapsed | 120 | 25.431 | 26.887 | 38.109 | 0.00813% |
| Expanded | 120 | 30.454 | 33.016 | 45.051 | 0.00826% |
| Hidden | 121 | 28.423 | 31.582 | 43.164 | 0.00754% |

All 361 stable samples were <=50 MiB, and every phase's mean CPU was <=0.1%. A scheduling boundary produced the extra hidden sample at 600.76 seconds; it was included. Sync freshness was checked at each phase end. The performance harness exited successfully and confirmed no owned child remained after shutdown. No working-set trimming was used.

The existing Electron overlay, visible and expanded, used six processes. A separate read-only ten-minute idle baseline after UI testing measured 78.994 MiB mean, 96.656 MiB peak and 0.02780% mean CPU. The native expanded mean was about 61.4% lower. Process age and history differed, so this is a local comparison, not a controlled universal speed or memory claim.

## Thirty-minute stability run

The original one-hour scope was reduced to 30 minutes at the user's request. After warmup, the fixed-data run collected 361 samples over 1800.68 seconds and performed 100 hide/show cycles.

- Peak Private Working Set: 12.305 MiB.
- First ten-minute mean: 11.445 MiB; last ten-minute mean: 9.740 MiB.
- GDI: 14 to 14; USER: 24 to 23.
- Handles: 280 to 318 overall; last ten minutes stayed between 318 and 322, ending at 318. The early increase coincided with other UI Automation checks; no continuing late-run growth was observed.

The original hour-long sampler was still active when the isolated overlay received a normal Quit after 30 minutes. The overlay exited cleanly; the sampler then reported `A measured process disappeared`. The shortened-run summary was derived from the retained raw CSV and explicit stop record, not from a successful hour-long sampler exit. This is not one-hour or permanent leak-free evidence.

## Remaining limits

- Physical mixed-DPI monitor dragging was not verified; DPI screenshots use synthetic messages. Coordinate unit tests cover mixed-DPI layouts and monitor removal.
- An actual overwrite installation, reboot/startup run and full upgrade/rollback installation were not performed during implementation. Packaging and data compatibility were verified separately.
- The full timed resource test was not repeated for the layout-only correction.
- Results depend on Windows, graphics drivers, Codex version, account data and system load.

Reproduction commands and test prerequisites are in the [README](../README.md). Raw measurements, logs, data backups and installers stay outside the published source tree.
