# Native validation record

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
