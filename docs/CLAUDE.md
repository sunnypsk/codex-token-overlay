# Claude Code 5-hour usage

Requires Claude Code v2.1.251 or newer with subscription rate-limit data. The bridge uses the official `rate_limits.five_hour.used_percentage` and `resets_at` fields on status-line stdin. It does not use Claude OAuth credentials, browser cookies, internal APIs, conversation logs, or model requests.

## Connect

After installing v0.2.1, run the bundled setup tool in PowerShell. Substitute your installed directory if you chose another location:

```powershell
& "$env:LOCALAPPDATA/Programs/Codex Token Overlay/setup-claude-statusline.ps1"
```

For a local build, select that executable:

```powershell
& './scripts/setup-claude-statusline.ps1' -Executable './build/native/Release/Codex Token Overlay.exe'
```

Setup saves a byte-for-byte backup beside Claude's `settings.json`, then adds only `statusLine`. Existing hooks and other settings are preserved. An unrelated custom status line is never overwritten. Rerunning setup is idempotent; it can update a previously managed command to a new executable location. `CLAUDE_CONFIG_DIR` is respected, and `-ClaudeConfigDirectory` can explicitly select a config directory.

The configured command runs a bundled PowerShell launcher with a quoted path and forward slashes. It pipes UTF-8 JSON into the native executable's `--claude-statusline` mode, which exits without creating a window, App Server, or main overlay profile lock. The selected executable and launcher must remain at that location. After an installation moves them, rerun setup with the installed executable.

Claude Code reloads settings automatically. Its status line will display `Claude 5h: ...`; the overlay receives the same usage. Data may be absent before the first API response. Workspace trust or managed hook restrictions can prevent Claude from running custom status lines; see [official configuration and troubleshooting](https://code.claude.com/docs/en/statusline).

## Display and storage

The account's 5-hour percentage and reset countdown appear in both overlay modes. The compact view becomes 340 x 124 DIP while connected. Codex charts and forecasts retain their existing dimensions. Hover over the Claude row for the reset and last-received time in HKT.

Only percentage, reset time and receipt time are saved to `%APPDATA%/codex-token-overlay/claude-usage.json`. The Codex `quota-state.json` schema is unchanged. Receipt time indicates when Claude Code supplied the reading, not a separate background API fetch.

- A valid 0% remains 0%. Missing or malformed values never become 0% or overwrite a valid cache.
- More than five minutes without a new reading shows `Last synced`. Closing Claude Code leaves the last reading and countdown available.
- After the window ends, usage becomes `N/A`; it does not assume a new session starts at 0%.
- Concurrent Claude sessions serialize atomic writes; the latest received valid sample wins. Their account quotas are never summed.
- Claude updates remain independent of Codex reconnects and continue while the overlay is hidden.

This version assumes one Claude account. Switching accounts without a new payload can retain the previous account's last reading. Weekly usage, costs and Claude forecasts are not displayed.

## Disconnect

Run the setup tool with `-Undo`, selecting the same Claude config directory/profile if you customized them:

```powershell
& "$env:LOCALAPPDATA/Programs/Codex Token Overlay/setup-claude-statusline.ps1" -Undo
```

Undo restores only the managed `statusLine` field, preserves other edits made since setup, and removes the integration's setup record and usage cache. If you have changed `statusLine` yourself, undo stops and preserves that command. The overlay returns to its original compact dimensions. Settings backups are retained.

## Validation

```powershell
& './scripts/build-native.ps1' -Test
& './scripts/test-native-claude.ps1'
```

The integration test uses fake Claude settings and an isolated overlay profile. It checks stdin/stdout, concurrent writers, invalid-input preservation, setup/undo, Codex-offline updates, freshness and expiry, and screenshots at synthetic 100%, 150% and 200% DPI. It does not sign in, send model prompts, modify real hooks or install an upgrade.
