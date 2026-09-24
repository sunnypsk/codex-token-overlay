# Codex Token Overlay

A compact Windows overlay for Codex quota percentages. It shows the current Codex usage percentage, the reset countdown and time, a current-window percentage forecast, and percentages for other available limits. Expanding the overlay shows observed percentage history, recorded forecasts of usage at reset, and a dashed expected-usage line from the latest reading to reset. The overlay can be collapsed, pinned above other windows, and controlled from the system tray.

The active service reads `account/rateLimits/read` from the local Codex App Server every minute and when Codex reports a limit change. Manual refresh and reconnect remain available. It does not request account token usage, scan local session files, or refresh pricing.

## Updating from 0.1.9

Version 0.1.11 stores only overlay settings, window position, and recent rate limits in `quota-state.json`. On first launch it reads the existing usage state to copy those values. The previous usage files are left untouched, so an older installation can still use them.

If Codex is offline, a still-active cached percentage is marked as last synced; its forecast is unavailable. Once the cached reset time has passed, the percentage and reset display become unavailable until Codex supplies a new window. A missing percentage is never shown as 0%.

Observed trend history begins with the first successful sync after the trend was introduced. Each successful sync now saves the forecast made at that timestamp for the end of the active reset window. Earlier observed readings remain visible, but their historical forecasts are shown as not recorded. One reading per minute is stored in `quota-state.json` for the active primary reset window. Solid lines break when readings are more than two minutes apart; missing forecasts also break the historical forecast line. The dashed expected-usage line extrapolates from the latest observation to reset. An offline or stale overlay keeps both recorded histories visible but hides this future estimate until sync resumes.

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
