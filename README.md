# Codex Token Overlay

A compact Windows overlay that shows account-level Codex token activity, local input/cached/output detail, API-equivalent USD estimates, and weekly reset information.

## What it shows

- Today, rolling 7 Days, and rolling 30 Days totals in `Asia/Hong_Kong`.
- Daily token trend charts for rolling 7/30 Days with Account-first/local-fallback attribution and explicit unavailable gaps.
- The current Codex usage percentage, exact reset time, and tokens observed since the reset.
- A current-week pace projection showing whether quota is likely to run out before the next reset and the projected usage percentage at reset.
- A current-reset-week projected weekly token capacity based only on tokens observed and the current reset percentage.
- An estimated weekly API-equivalent total and remaining cost based only on the current reset cycle, with priced coverage, usage basis, and lower-bound status.
- Token-only API-equivalent cost using the latest available OpenAI Standard rates, with an explicit coverage percentage.

Account daily totals come from the read-only Codex App Server methods `account/usage/read` and `account/rateLimits/read`. Current-day and input/cached/output detail are derived read-only from local Codex session JSONL files. The app never reads or stores OAuth/API secrets and never changes Codex sessions.

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
```

The NSIS installer is written to `release/`. The local build is unsigned, so Windows SmartScreen may show a warning.

## Accuracy notes

- USD values are estimates at current Standard API token rates, not ChatGPT subscription charges.
- Tool-call, container, image, storage, regional-processing, subscription, and region-specific fees are excluded. Fast-mode is represented only when the bundled, provenance-tracked premium fact is effective; otherwise the displayed Standard result is explicitly a lower bound.
- Account daily buckets can lag the current day; the UI marks local live fallback data until the account bucket arrives.
- Pricing starts with the pinned OpenAI/Codex LiteLLM subset, supplements long context as one indivisible pinned models.dev component, and refreshes through immutable HTTPS source URLs. Official OpenAI Docs are used only for release-fixture validation; no browser scraper runs at runtime.
- Bundled Fast facts are an integrity-pinned application fixture at `https://github.com/openai/codex-token-overlay/blob/main/assets/pricing/fast-facts.json`; they are provenance-tracked facts, not user pricing overrides. `scripts/update-pricing-snapshot.mjs` validates and hashes local fixtures; it does not claim to fetch upstream data.
- Every displayed price carries source URL, source or payload SHA, component effective/observed time, quality, freshness/error state, and coverage. Cache-write tokens with no explicit source rate remain unpriced rather than receiving a synthetic multiplier.
- USD values are API-equivalent estimates, never a subscription invoice or a user-configurable price override. Persisted state uses v2 generation files with an atomic checksum manifest and retains a v1 legacy fallback during migration.
- The quota projection linearly extrapolates the current reset week's average percentage-consumption pace. It is an estimate, not a guarantee, and can change as usage changes.
- The weekly API-equivalent estimate uses only priced tokens observed in the current reset cycle and scales that cost by the current reset-window percentage. Historical cycles and account-token totals never affect it; missing pricing, zero/invalid usage, and incomplete coverage are shown as `N/A` or lower bounds.
- The displayed weekly token capacity is a current-cycle projection, not a published fixed token cap; it reports low confidence below 15% usage and medium confidence thereafter. Historical cycles remain available for compatibility but do not affect displayed token or USD estimates.
- Persisted cycle/model pricing slices retain endpoint timestamps. If the endpoints resolve to different base, long-context, or Fast pricing facts, that indivisible slice is shown as an unpriced lower bound; a revision that changes and reverts between the endpoints cannot be recovered without raw replay.
- GPT-6 models are accepted by structured pricing normalization. The bundled GPT-6 Astra fallback uses the [official model page](https://developers.openai.com/api/docs/models/gpt-6-astra), verified on 2026-09-07 at 01:42:25 UTC, including Standard, >272K context, and Fast rates. This observation is the earliest effective boundary of the new fallback; earlier usage stays unpriced unless an older authoritative pricing component covers it. Internal identifiers such as `codex-auto-review` remain explicitly Unpriced until a supported rate exists.
- Complete valid sessions without cumulative token usage are indexed as empty, including old false-positive fallbacks. Existing token history is retained if a replacement raw file lacks usage; malformed or incomplete replays remain unresolved.
- Background usage changes are persisted in batches with a maximum 60-second timer delay from the first pending change; live UI updates retain their 15-second indexing cadence. Manual refresh, settings/position changes, migration cutovers, and normal shutdown flush immediately. An abnormal exit can require replaying up to that pending interval from the unchanged source JSONL files and refreshing account data. The checksum manifest and active/previous v2 generation format are unchanged.
