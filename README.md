# Codex Token Overlay

A compact Windows overlay that shows account-level Codex token activity, local input/cached/output detail, API-equivalent USD estimates, and weekly reset information.

## What it shows

- Today, Monday-to-now week, and current month totals in `Asia/Hong_Kong`.
- The current Codex usage percentage, exact reset time, and tokens observed since the reset.
- A current-week pace projection showing whether quota is likely to run out before the next reset and the projected usage percentage at reset.
- An empirical weekly raw-token capacity range based on the current and up to eight recent valid reset cycles.
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
- Codex limits are weighted and model-dependent. The displayed weekly token capacity is an empirical range, not a published fixed token cap.
