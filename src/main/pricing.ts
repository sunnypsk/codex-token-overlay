import { createHash } from 'node:crypto'
import { isRecord } from './token-math.js'
import type { BigTokenBreakdown } from './token-math.js'
import { uncachedInput } from './token-math.js'

/**
 * Prices are kept in microUSD per million tokens. The persisted unit is part
 * of the public contract; intermediate calculations use attoUSD/token.
 */
export interface StoredPriceSet {
  inputMicroUsdPerMillion: string
  cachedInputMicroUsdPerMillion: string
  /** Missing cache-write pricing is not the same as a zero price. */
  cacheWriteMicroUsdPerMillion: string | null
  outputMicroUsdPerMillion: string
}

export type PricingSource =
  | 'litellm'
  | 'models.dev'
  | 'live-models.dev'
  | 'embedded'
  | 'legacy'
  | 'official'

export type PricingQuality = 'verified' | 'observed' | 'embedded' | 'stale' | 'unverified' | 'legacy'

export interface PriceComponentProvenance {
  componentId: string
  source: PricingSource
  sourceUrl: string
  sourceSha256: string | null
  sourceCommit: string | null
  effectiveAt: string | null
  observedAt: string | null
  checkedAt: string | null
  quality: PricingQuality
}

export interface StoredModelPrice {
  short: StoredPriceSet
  long: StoredPriceSet | null
  longContextThreshold: string | null
  /** Base and long are separate components; they must never be field-merged. */
  base?: PriceComponentProvenance
  longComponent?: PriceComponentProvenance
  aliases?: string[]
}

export interface FastPriceFact {
  model: string
  numerator: string
  denominator: string
  source: PriceComponentProvenance
}

export interface PricingConflict {
  model: string
  component: 'base' | 'long'
  left: string
  right: string
  detectedAt: string
}

export interface StoredPriceBook {
  /** Kept for backwards compatibility with v1 clients. */
  sourceUrl: string
  checkedAt: string | null
  updatedAt: string
  stale: boolean
  message: string | null
  models: Record<string, StoredModelPrice>
  schemaVersion?: 2
  /** Persisted normalization contract; old books must bootstrap again. */
  normalizationRevision?: number
  sourceSha256?: string | null
  sourceEtag?: string | null
  commitEtag?: string | null
  payloadSha256?: string | null
  sourceCommit?: string | null
  sourceEffectiveAt?: string | null
  sourceQuality?: PricingQuality
  observedAt?: string | null
  liveModelsDevEtag?: string | null
  liveModelsDevPayloadSha256?: string | null
  liveModelsDevObservedAt?: string | null
  conflicts?: PricingConflict[]
  fastFacts?: Record<string, FastPriceFact>
  lastError?: string | null
}

export interface ContextUsage {
  short: BigTokenBreakdown
  long: BigTokenBreakdown
}

export interface EffectivePricingLedgerSnapshot {
  effectiveAt: string
  /** Optional observation timestamp used to order same-effective revisions. */
  observedAt?: string | null
  models: Record<string, unknown>
}

interface EffectiveLedgerCandidate {
  entry: EffectivePricingLedgerSnapshot
  effectiveMs: number
  observedMs: number
  appendPosition: number
}

export interface EffectiveModelPricing {
  modelId: string
  /** Canonical exact/alias target selected for this event, when priceable. */
  resolvedKey?: string
  price: StoredModelPrice | undefined
  longContextThreshold: bigint | null
  hasEffectiveBase: boolean
  hasEffectiveLong: boolean
  fastFact?: FastPriceFact | null
}

export interface ResolvedCanonicalModelPrice {
  key: string
  price: StoredModelPrice
}

export interface ValidatedFastRational {
  numerator: bigint
  denominator: bigint
}

const MAX_FAST_RATIONAL_DIGITS = 60

export interface ModelCostResult {
  microUsd: bigint | null
  pricedTokens: bigint
  unpricedTokens?: bigint
  lowerBound?: boolean
  attoUsd?: bigint
}

export interface DetailedModelCostResult extends ModelCostResult {
  short: ModelCostBucketResult
  long: ModelCostBucketResult
}

export interface ModelCostBucketResult {
  attoUsd: bigint
  pricedTokens: bigint
  unpricedTokens: bigint
  lowerBound: boolean
}

export type PricingFetcher = (input: string, init?: RequestInit) => Promise<Response>

export interface StructuredFetchResult {
  book: StoredPriceBook
  notModified: boolean
}

export const LITELLM_OWNER = 'BerriAI'
export const LITELLM_REPOSITORY = 'litellm'
export const LITELLM_BRANCH = 'main'
export const LITELLM_PATH = 'model_prices_and_context_window.json'
export const LITELLM_COMMIT_API =
  `https://api.github.com/repos/${LITELLM_OWNER}/${LITELLM_REPOSITORY}/commits?path=${LITELLM_PATH}&sha=${LITELLM_BRANCH}&per_page=1`
export const LITELLM_RAW_PREFIX = 'https://raw.githubusercontent.com'
export const MODELS_DEV_URL = 'https://models.dev/api.json'
export const OFFICIAL_PRICING_URL = 'https://developers.openai.com/api/docs/pricing.md'
const PRICE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1_000
const STALE_AFTER_MS = 36 * 60 * 60 * 1_000
const REQUEST_TIMEOUT_MS = 10_000
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024
const LONG_CONTEXT_THRESHOLD = 272_000n
export const PRICING_NORMALIZATION_REVISION = 3

const LITELLM_SOURCE_URL = `https://github.com/${LITELLM_OWNER}/${LITELLM_REPOSITORY}/blob/${LITELLM_BRANCH}/${LITELLM_PATH}`
const MODELS_DEV_SOURCE_URL = MODELS_DEV_URL
const FAST_FACTS_SOURCE_URL = 'https://github.com/openai/codex-token-overlay/blob/main/assets/pricing/fast-facts.json'
const FAST_FACTS_SHA256 = '668966f33b5afde6656c8e0ec29bc929042fce1f5428b33f4cca11280a5a0e4e'

const EMBEDDED_PROVENANCE: PriceComponentProvenance = {
  componentId: 'embedded-openai-codex-v2',
  source: 'embedded',
  sourceUrl: LITELLM_SOURCE_URL,
  sourceSha256: '6b36efaf886fad9be3dadf5ac23e23900f9ad3e82874d69ef634f1707ffdfe35',
  sourceCommit: null,
  effectiveAt: '2026-08-19T00:00:00.000Z',
  observedAt: null,
  checkedAt: null,
  quality: 'embedded'
}

const EMBEDDED_LONG_PROVENANCE: PriceComponentProvenance = {
  componentId: 'embedded-models-dev-long-v2',
  source: 'models.dev',
  sourceUrl: MODELS_DEV_SOURCE_URL,
  sourceSha256: '152b234c2738db110f5892ef9f4f6734696dde6d9f102b32e439b4dd09761359',
  sourceCommit: null,
  effectiveAt: '2026-08-19T00:00:00.000Z',
  observedAt: null,
  checkedAt: null,
  quality: 'embedded'
}

/** Fast facts are app provenance, not user pricing overrides. */
export const FAST_PRICE_FACTS: Record<string, { numerator: bigint; denominator: bigint }> = {
  'gpt-5.6-sol': { numerator: 2n, denominator: 1n },
  'gpt-5.6-terra': { numerator: 2n, denominator: 1n },
  'gpt-5.6-luna': { numerator: 2n, denominator: 1n },
  'gpt-5.5': { numerator: 5n, denominator: 2n },
  'gpt-5.4': { numerator: 2n, denominator: 1n },
  'gpt-5.3-codex': { numerator: 2n, denominator: 1n }
}

export class PricingService {
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null

  constructor(
    private readonly getPriceBook: () => StoredPriceBook,
    private readonly savePriceBook: (book: StoredPriceBook) => void,
    private readonly onUpdated: () => void,
    private readonly fetcher: PricingFetcher = fetch,
    /** Source-compatible v1 test hook; production never supplies it. */
    private readonly legacyBrowserFallback?: () => Promise<string>
  ) {}

  start(refreshImmediately = true): void {
    if (refreshImmediately) void this.refreshIfDue()
    this.timer = setInterval(() => void this.refreshIfDue(), PRICE_CHECK_INTERVAL_MS)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  async refreshIfDue(force = false): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.performRefresh(force).finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async performRefresh(force: boolean): Promise<void> {
    const current = ensurePriceBook(this.getPriceBook())
    const checkedAt = current.checkedAt ? Date.parse(current.checkedAt) : 0
    const fresh = !current.stale && (current.sourceQuality === 'verified' || current.sourceQuality === 'observed') && Number.isFinite(checkedAt)
    if (!force && fresh && Date.now() - checkedAt < PRICE_CHECK_INTERVAL_MS) return

    const now = new Date().toISOString()
    try {
      const result = await fetchStructuredPriceBook(current, this.fetcher, now)
      this.savePriceBook({
        ...result.book,
        checkedAt: now,
        stale: false,
        message: null,
        lastError: null
      })
    } catch (error) {
      // Kept solely for old tests/extensions that explicitly pass the v1
      // browser hook. UsageService no longer imports or supplies it.
      if (this.legacyBrowserFallback) {
        try {
          const markdown = await this.legacyBrowserFallback()
          const parsed = parsePricingMarkdown(markdown)
          if (Object.keys(parsed).length > 0) {
            this.savePriceBook({
              ...current,
              schemaVersion: 2,
              sourceUrl: OFFICIAL_PRICING_URL,
              checkedAt: now,
              updatedAt: current.updatedAt,
              stale: false,
              message: null,
              sourceQuality: 'observed',
              models: mergeModels(current.models, parsed)
            })
            this.onUpdated()
            return
          }
        } catch {
          // Fall through to the embedded/last-good state below.
        }
      }
      const message = error instanceof Error ? error.message : 'Unable to refresh structured pricing'
      this.savePriceBook({
        ...current,
        schemaVersion: 2,
        checkedAt: now,
        stale: true,
        message,
        lastError: message
      })
    }
    this.onUpdated()
  }
}

/** Fetch immutable LiteLLM, then merge the pinned long supplement and live misses. */
export async function fetchStructuredPriceBook(
  previous: StoredPriceBook,
  fetcher: PricingFetcher = fetch,
  now = new Date().toISOString()
): Promise<StructuredFetchResult> {
  const previousBook = ensurePriceBook(previous)
  const commitResponse = await fetchJsonWithPolicy(
    LITELLM_COMMIT_API,
    fetcher,
    'api.github.com',
    previousBook.commitEtag ? { 'if-none-match': previousBook.commitEtag } : undefined
  )
  const commit = commitResponse.notModified
    ? previousBook.sourceCommit && previousBook.sourceEffectiveAt
      ? { sha: previousBook.sourceCommit, date: previousBook.sourceEffectiveAt }
      : null
    : parseLatestCommitMetadata(commitResponse.value)
  if (!commit) throw new Error('LiteLLM commit metadata was missing a verified 40-hex SHA/date')
  if (previousBook.sourceCommit && previousBook.sourceCommit !== commit.sha) {
    const chain = await verifyDescendantChain(previousBook.sourceCommit, commit.sha, fetcher)
    if (!chain) throw new Error('LiteLLM source commit regressed or could not be verified as a descendant')
  }

  const rawUrl = `${LITELLM_RAW_PREFIX}/${LITELLM_OWNER}/${LITELLM_REPOSITORY}/${commit.sha}/${LITELLM_PATH}`
  const rawResponse = await fetchTextWithPolicy(
    rawUrl,
    fetcher,
    'raw.githubusercontent.com',
    previousBook.sourceEtag ? { 'if-none-match': previousBook.sourceEtag } : undefined
  )
  const sourceSha256 = rawResponse.notModified ? previousBook.sourceSha256 ?? null : rawResponse.payloadSha256
  const litellmModels = rawResponse.notModified
    ? previousBook.models
    : normalizeLiteLLMPriceBook(rawResponse.value, {
        source: 'litellm',
        sourceUrl: rawUrl,
        sourceSha256,
        sourceCommit: commit.sha,
        effectiveAt: commit.date,
        observedAt: now,
        checkedAt: now,
        quality: 'verified'
      })
  if (!rawResponse.notModified && Object.keys(litellmModels).length === 0) {
    throw new Error('LiteLLM pricing payload contained no recognized OpenAI/Codex models')
  }

  const longModels = createEmbeddedLongSupplement(now)
  const live = await fetchLiveModelsDev(previousBook, litellmModels, fetcher, now)
  const merged = mergePricingSources({
    base: litellmModels,
    longSupplement: longModels,
    live: live.models,
    previous: previousBook,
    now
  })
  const models = merged.models
  const semanticHash = canonicalPricingHash(models)
  const unchanged = semanticHash === previousBook.payloadSha256
  return {
    notModified: rawResponse.notModified && unchanged,
    book: {
      ...previousBook,
      schemaVersion: 2,
      normalizationRevision: PRICING_NORMALIZATION_REVISION,
      sourceUrl: LITELLM_SOURCE_URL,
      sourceSha256,
      sourceEtag: rawResponse.etag,
      payloadSha256: semanticHash,
      sourceCommit: commit.sha,
      commitEtag: commitResponse.etag,
      sourceEffectiveAt: commit.date,
      sourceQuality: 'verified',
      observedAt: now,
      updatedAt: unchanged ? previousBook.updatedAt : now,
      models,
      conflicts: merged.conflicts,
      fastFacts: createFastFacts(now),
      liveModelsDevEtag: live.etag ?? previousBook.liveModelsDevEtag ?? null,
      liveModelsDevPayloadSha256: live.payloadSha256 ?? previousBook.liveModelsDevPayloadSha256 ?? null,
      liveModelsDevObservedAt: live.observedAt ?? previousBook.liveModelsDevObservedAt ?? null
    }
  }
}

export function createBundledPriceBook(now = new Date().toISOString()): StoredPriceBook {
  const models = createEmbeddedModels(now)
  return {
    schemaVersion: 2,
    normalizationRevision: PRICING_NORMALIZATION_REVISION,
    sourceUrl: EMBEDDED_PROVENANCE.sourceUrl,
    checkedAt: null,
    updatedAt: now,
    stale: true,
    message: 'Using the pinned OpenAI/Codex pricing bundle until a verified refresh succeeds.',
    models,
    sourceSha256: EMBEDDED_PROVENANCE.sourceSha256,
    sourceEtag: null,
    commitEtag: null,
    payloadSha256: canonicalPricingHash(models),
    sourceCommit: null,
    sourceEffectiveAt: null,
    sourceQuality: 'embedded',
    observedAt: null,
    liveModelsDevEtag: null,
    liveModelsDevPayloadSha256: null,
    liveModelsDevObservedAt: null,
    conflicts: [],
    fastFacts: createFastFacts(now),
    lastError: null
  }
}

export function calculateModelCost(
  usage: ContextUsage,
  price: StoredModelPrice | undefined,
  options: { fast?: boolean; fastFact?: FastPriceFact | null } = {}
): ModelCostResult {
  const result = calculateModelCostDetailed(usage, price, options)
  // Preserve the v1 public return shape exactly. Consumers that need
  // lower-bound/unpriced/atto details use calculateModelCostDetailed.
  return { microUsd: result.microUsd, pricedTokens: result.pricedTokens }
}

export function calculateModelCostDetailed(
  usage: ContextUsage,
  price: StoredModelPrice | undefined,
  options: { fast?: boolean; fastFact?: FastPriceFact | null } = {}
): DetailedModelCostResult {
  if (!price || !hasEffectiveBase(price)) {
    return {
      microUsd: null,
      pricedTokens: 0n,
      unpricedTokens: usage.short.total + usage.long.total,
      lowerBound: false,
      attoUsd: 0n,
      short: {
        attoUsd: 0n,
        pricedTokens: 0n,
        unpricedTokens: usage.short.total,
        lowerBound: false
      },
      long: {
        attoUsd: 0n,
        pricedTokens: 0n,
        unpricedTokens: usage.long.total,
        lowerBound: false
      }
    }
  }
  const short = calculateBucket(usage.short, price.short, options)
  const long = usage.long.total > 0n
    ? price.long
      ? calculateBucket(usage.long, price.long, options)
      : {
          attoUsd: 0n,
          pricedTokens: 0n,
          unpricedTokens: usage.long.total,
          lowerBound: false
        }
    : {
        attoUsd: 0n,
        pricedTokens: 0n,
        unpricedTokens: 0n,
        lowerBound: false
      }
  const attoUsd = short.attoUsd + long.attoUsd
  const pricedTokens = short.pricedTokens + long.pricedTokens
  const unpricedTokens = short.unpricedTokens + long.unpricedTokens
  return {
    microUsd: pricedTokens > 0n ? roundAttoUsdToMicroUsd(attoUsd) : null,
    pricedTokens,
    unpricedTokens,
    lowerBound: short.lowerBound || long.lowerBound,
    attoUsd,
    short,
    long
  }
}

function calculateBucket(
  tokens: BigTokenBreakdown,
  rates: StoredPriceSet,
  options: { fast?: boolean; fastFact?: FastPriceFact | null }
): ModelCostBucketResult {
  const fast = options.fast === true
  const fact = fast ? validateFastRationalFact(options.fastFact) : null
  const numerator = fact?.numerator ?? 1n
  const denominator = fact?.denominator ?? 1n
  let premiumVerified = true
  const attoRate = (microUsdPerMillion: string): bigint => {
    const standardAttoRate = parseMicroRate(microUsdPerMillion) * 1_000_000n
    const premiumNumerator = standardAttoRate * numerator
    if (premiumNumerator % denominator !== 0n) {
      // Divisibility is checked after converting the rate to the atto
      // boundary. A 5/2 fact therefore remains exact for rates such as
      // 5,000,000 microUSD/M, even when the token count is odd.
      premiumVerified = false
      return standardAttoRate
    }
    return premiumNumerator / denominator
  }
  let attoUsd = 0n
  let pricedTokens = 0n
  const uncached = uncachedInput(tokens)
  if (uncached > 0n) {
    attoUsd += uncached * attoRate(rates.inputMicroUsdPerMillion)
    pricedTokens += uncached
  }
  if (tokens.cachedInput > 0n) {
    attoUsd += tokens.cachedInput * attoRate(rates.cachedInputMicroUsdPerMillion)
    pricedTokens += tokens.cachedInput
  }
  let unpricedTokens = 0n
  if (tokens.cacheWriteInput > 0n) {
    if (rates.cacheWriteMicroUsdPerMillion === null) unpricedTokens += tokens.cacheWriteInput
    else {
      attoUsd += tokens.cacheWriteInput * attoRate(rates.cacheWriteMicroUsdPerMillion)
      pricedTokens += tokens.cacheWriteInput
    }
  }
  if (tokens.output > 0n) {
    attoUsd += tokens.output * attoRate(rates.outputMicroUsdPerMillion)
    pricedTokens += tokens.output
  }
  if (fast && !premiumVerified) {
    // If any premium rate cannot be represented exactly, the whole request
    // falls back to its Standard lower bound; do not mix premium and base
    // buckets in one supposedly Fast quote.
    attoUsd = standardBucketAtto(tokens, rates)
  }
  return { attoUsd, pricedTokens, unpricedTokens, lowerBound: fast && (!fact || !premiumVerified) }
}

function standardBucketAtto(tokens: BigTokenBreakdown, rates: StoredPriceSet): bigint {
  let attoUsd = uncachedInput(tokens) * parseMicroRate(rates.inputMicroUsdPerMillion) * 1_000_000n
  attoUsd += tokens.cachedInput * parseMicroRate(rates.cachedInputMicroUsdPerMillion) * 1_000_000n
  if (rates.cacheWriteMicroUsdPerMillion !== null) attoUsd += tokens.cacheWriteInput * parseMicroRate(rates.cacheWriteMicroUsdPerMillion) * 1_000_000n
  attoUsd += tokens.output * parseMicroRate(rates.outputMicroUsdPerMillion) * 1_000_000n
  return attoUsd
}

/** Round exactly once, half-up, after all buckets have been summed. */
export function roundAttoUsdToMicroUsd(attoUsd: bigint): bigint {
  if (attoUsd <= 0n) return 0n
  return (attoUsd + 500_000_000_000n) / 1_000_000_000_000n
}

export function reduceRational(numerator: bigint, denominator: bigint): { numerator: bigint; denominator: bigint } {
  if (numerator < 0n || denominator <= 0n) throw new Error('Invalid rational')
  const gcd = (left: bigint, right: bigint): bigint => {
    let a = left
    let b = right
    while (b !== 0n) [a, b] = [b, a % b]
    return a || 1n
  }
  const divisor = gcd(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

/** Validate persisted/direct Fast facts before any BigInt/modulo operation. */
export function validateFastRationalFact(fact: FastPriceFact | null | undefined): ValidatedFastRational | null {
  if (!fact || typeof fact.numerator !== 'string' || typeof fact.denominator !== 'string') return null
  if (!/^(?:0|[1-9]\d*)$/u.test(fact.numerator) || !/^(?:0|[1-9]\d*)$/u.test(fact.denominator)) return null
  if (fact.numerator.length > MAX_FAST_RATIONAL_DIGITS || fact.denominator.length > MAX_FAST_RATIONAL_DIGITS) return null
  try {
    const numerator = BigInt(fact.numerator)
    const denominator = BigInt(fact.denominator)
    if (numerator <= 0n || denominator <= 0n) return null
    return reduceRational(numerator, denominator)
  } catch {
    return null
  }
}

export function fastFactForModel(model: string, book: StoredPriceBook | null = null, eventAt?: string | number): FastPriceFact | null {
  const key = normalizeModelId(model)
  const eventMs = eventAt === undefined ? null : typeof eventAt === 'number' ? eventAt : Date.parse(eventAt)
  if (eventMs !== null && !Number.isFinite(eventMs)) return null
  const value = book?.fastFacts?.[key]
  if (value) {
    if (!validateFastRationalFact(value)) return null
    const effectiveMs = value.source?.effectiveAt ? Date.parse(value.source.effectiveAt) : Number.NaN
    if (!Number.isFinite(effectiveMs) || (eventMs !== null && effectiveMs > eventMs)) return null
    return value
  }
  if (book?.fastFacts) return null
  const fact = FAST_PRICE_FACTS[key]
  if (!fact) return null
  const embeddedEffectiveMs = Date.parse('2026-08-19T00:00:00.000Z')
  if (eventMs !== null && embeddedEffectiveMs > eventMs) return null
  const reduced = reduceRational(fact.numerator, fact.denominator)
  return {
    model: key,
    numerator: reduced.numerator.toString(),
    denominator: reduced.denominator.toString(),
    source: {
      componentId: 'embedded-fast-facts-v2',
      source: 'embedded',
      sourceUrl: FAST_FACTS_SOURCE_URL,
      sourceSha256: FAST_FACTS_SHA256,
      sourceCommit: null,
      effectiveAt: '2026-08-19T00:00:00.000Z',
      observedAt: null,
      checkedAt: null,
      quality: 'embedded'
    }
  }
}

export function normalizeModelId(model: string): string {
  return model.trim().replace(/^openai[/:]/iu, '').toLowerCase()
}

function resolveModelEntry(book: StoredPriceBook, model: string, exactOnly = false): ResolvedCanonicalModelPrice | undefined {
  const normalized = normalizeModelId(model)
  const exact = book.models[model] ?? book.models[normalized]
  if (exact) {
    const key = book.models[model] ? model : normalized
    return { key, price: exact }
  }
  if (exactOnly) return undefined
  const alias = MODEL_ALIASES[normalized]
  return alias && book.models[alias] ? { key: alias, price: book.models[alias] } : undefined
}

function hasCanonicalBaseProvenance(model: string, price: StoredModelPrice): boolean {
  const base = price.base
  // Markdown/v1 books can be valid without component provenance. If metadata
  // exists, it must be a recognized source and identify the resolved target.
  if (!base) return true
  if (!isCanonicalPricingSource(base.source)) return false
  return base.componentId === `${base.source}-base-${normalizeModelId(model)}`
}

function isCanonicalPricingSource(value: unknown): value is PricingSource {
  return value === 'litellm' || value === 'models.dev' || value === 'live-models.dev' || value === 'embedded'
}

export function resolveModelPrice(book: StoredPriceBook, model: string, options: { exactOnly?: boolean } = {}): StoredModelPrice | undefined {
  return resolveModelEntry(book, model, options.exactOnly)?.price
}

/** Resolve a recognized exact/normalized/alias model with canonical provenance. */
export function resolveCanonicalModelPrice(book: StoredPriceBook, model: string): ResolvedCanonicalModelPrice | undefined {
  if (!isRecognizedModel(model)) return undefined
  const resolved = resolveModelEntry(book, model)
  if (!resolved || !isRecognizedModel(resolved.key) || !hasCanonicalBaseProvenance(resolved.key, resolved.price)) return undefined
  return resolved
}

/** Resolve one model revision at an event timestamp, including aliases. */
export function resolveEffectiveModelPricing(
  book: StoredPriceBook,
  model: string,
  eventAt: string | number,
  ledger: EffectivePricingLedgerSnapshot[] = []
): EffectiveModelPricing {
  const eventMs = typeof eventAt === 'number' ? eventAt : parseTimestamp(eventAt)
  const modelId = normalizeModelId(model)
  if (!Number.isFinite(eventMs)) return { modelId, price: undefined, longContextThreshold: null, hasEffectiveBase: false, hasEffectiveLong: false, fastFact: null }
  const validLedger = ledger.flatMap((entry, appendPosition) => {
    if (!entry || !isRecord(entry.models)) return []
    const effectiveMs = parseTimestamp(entry.effectiveAt)
    if (!Number.isFinite(effectiveMs)) return []
    const observedMs = parseTimestamp(entry.observedAt)
    return [{ entry, effectiveMs, observedMs, appendPosition }]
  })
  const revision = validLedger
    .filter((candidate) => candidate.effectiveMs <= eventMs)
    .sort(compareLedgerCandidates)[0]?.entry
  if (ledger.length > 0 && !revision) return { modelId, price: undefined, longContextThreshold: null, hasEffectiveBase: false, hasEffectiveLong: false, fastFact: null }
  const modelBook = revision
    ? { ...book, models: revision.models as Record<string, StoredModelPrice> }
    : book
  const resolved = resolveCanonicalModelPrice(modelBook, model)
  const price = resolved?.price
  const baseEffectiveMs = price?.base?.effectiveAt ? Date.parse(price.base.effectiveAt) : Number.NaN
  if (!price || !price.base?.effectiveAt || !Number.isFinite(baseEffectiveMs) || baseEffectiveMs > eventMs || !hasEffectiveBase(price)) {
    return { modelId, resolvedKey: resolved?.key, price: undefined, longContextThreshold: null, hasEffectiveBase: false, hasEffectiveLong: false, fastFact: null }
  }
  const longEffectiveMs = price.longComponent?.effectiveAt ? Date.parse(price.longComponent.effectiveAt) : Number.NaN
  const hasEffectiveLong = isCompleteLong(price) && Boolean(price.longComponent?.effectiveAt) && Number.isFinite(longEffectiveMs) && longEffectiveMs <= eventMs
  const threshold = hasEffectiveLong && price.longContextThreshold && /^\d+$/.test(price.longContextThreshold)
    ? BigInt(price.longContextThreshold)
    : null
  const fastFact = fastFactForModel(modelId, modelBook, eventMs)
  return { modelId, resolvedKey: resolved?.key, price, longContextThreshold: threshold, hasEffectiveBase: true, hasEffectiveLong, fastFact }
}

function parseTimestamp(value: unknown): number {
  return typeof value === 'string' ? Date.parse(value) : Number.NaN
}

function compareLedgerCandidates(left: EffectiveLedgerCandidate, right: EffectiveLedgerCandidate): number {
  const effectiveOrder = right.effectiveMs - left.effectiveMs
  if (effectiveOrder !== 0) return effectiveOrder

  const leftObserved = Number.isFinite(left.observedMs)
  const rightObserved = Number.isFinite(right.observedMs)
  if (leftObserved !== rightObserved) return leftObserved ? -1 : 1
  if (leftObserved && rightObserved) {
    const observedOrder = right.observedMs - left.observedMs
    if (observedOrder !== 0) return observedOrder
  }

  // Array order is the append order of the durable ledger. It is the final
  // deterministic tie-break when observation metadata cannot distinguish
  // revisions (or is equal).
  return right.appendPosition - left.appendPosition
}

export function canonicalPricingHash(models: Record<string, StoredModelPrice>): string {
  // Observation/check timestamps are transport metadata, not semantic
  // pricing content. Excluding them makes an identical 304 update checkedAt
  // only, as required by the persistence contract.
  return sha256(stableJson(stripVolatileProvenance(models)))
}

export function normalizeLiteLLMPriceBook(
  payload: unknown,
  provenance: Omit<PriceComponentProvenance, 'componentId'> & { componentId?: string } = {
    source: 'litellm',
    sourceUrl: LITELLM_SOURCE_URL,
    sourceSha256: null,
    sourceCommit: null,
    effectiveAt: null,
    observedAt: null,
    checkedAt: null,
    quality: 'verified'
  }
): Record<string, StoredModelPrice> {
  const root = typeof payload === 'string' ? parseJson(payload) : payload
  if (!isRecord(root)) throw new Error('LiteLLM pricing payload was not an object')
  const models: Record<string, StoredModelPrice> = {}
  for (const [rawModel, rawValue] of Object.entries(root)) {
    if (!isRecognizedModel(rawModel) || !isRecord(rawValue)) continue
    const provider = typeof rawValue.litellm_provider === 'string' ? rawValue.litellm_provider.toLowerCase() : null
    if (provider && provider !== 'openai' && provider !== 'codex') continue
    const model = normalizeModelId(rawModel)
    const rate = parseLiteLLMRate(rawValue)
    if (!rate) continue
    // LiteLLM max_* values describe capacity only. They are not evidence of
    // a separate long-context rate component.
    const explicitLong = parseExplicitLiteLLMLongRate(rawValue)
    const existing = models[model]
    const component = makeProvenance(provenance, `${provenance.source}-base-${model}`)
    if (!existing) {
      models[model] = {
        short: rate,
        long: explicitLong?.rate ?? null,
        longContextThreshold: explicitLong?.threshold ?? null,
        base: component,
        ...(explicitLong ? { longComponent: makeProvenance(provenance, `${provenance.source}-long-${model}`) } : {})
      }
      continue
    }
    if (explicitLong && !isCompleteLong(existing)) {
      existing.long = explicitLong.rate
      existing.longContextThreshold = explicitLong.threshold
      existing.longComponent = makeProvenance(provenance, `${provenance.source}-long-${model}`)
    }
  }
  return models
}

export function normalizeModelsDevPriceBook(
  payload: unknown,
  provenance: Omit<PriceComponentProvenance, 'componentId'> & { componentId?: string } = {
    source: 'models.dev',
    sourceUrl: MODELS_DEV_SOURCE_URL,
    sourceSha256: null,
    sourceCommit: null,
    effectiveAt: null,
    observedAt: null,
    checkedAt: null,
    quality: 'observed'
  },
  options: { exactCase?: boolean } = {}
): Record<string, StoredModelPrice> {
  const root = typeof payload === 'string' ? parseJson(payload) : payload
  const models: Record<string, StoredModelPrice> = {}
  walkModelsDev(root, (modelName, record) => {
    if (!isRecognizedModel(modelName)) return
    const rate = parseModelsDevRate(record)
    if (!rate) return
    const limit = isRecord(record.limit) ? record.limit : record
    const isLong = numericValue(limit.max_input_tokens) > Number(LONG_CONTEXT_THRESHOLD)
    const model = options.exactCase ? modelName : normalizeModelId(modelName)
    const component = makeProvenance(provenance, `${provenance.source}-base-${model}`)
    models[model] = isLong
      ? { short: emptyPriceSet(), long: rate, longContextThreshold: LONG_CONTEXT_THRESHOLD.toString(), longComponent: component }
      : { short: rate, long: null, longContextThreshold: null, base: component }
  })
  return models
}

export function mergePricingSources(input: {
  base: Record<string, StoredModelPrice>
  longSupplement?: Record<string, StoredModelPrice>
  live?: Record<string, StoredModelPrice>
  previous?: StoredPriceBook
  now?: string
}): { models: Record<string, StoredModelPrice>; conflicts: PricingConflict[] } {
  const now = input.now ?? new Date().toISOString()
  const models: Record<string, StoredModelPrice> = {}
  const conflicts: PricingConflict[] = []
  for (const [model, value] of Object.entries(input.base)) models[model] = cloneModelPrice(value)

  for (const [model, supplement] of Object.entries(input.longSupplement ?? {})) {
    const current = models[model]
    if (!current) continue
    // The long supplement is intentionally not a base-price authority. A
    // complete LiteLLM base remains canonical, so capacity-shaped duplicate
    // rows cannot create a false base conflict.
    if (isCompleteLong(current) && isCompleteLong(supplement)) {
      const differs = stableJson(current.long) !== stableJson(supplement.long)
      if (differs) {
        conflicts.push({ model, component: 'long', left: stableJson(current.long), right: stableJson(supplement.long), detectedAt: now })
      }
      // LiteLLM remains the authoritative complete long component. If the
      // supplement is the explicit LiteLLM component, replace a non-LiteLLM
      // candidate as one whole component after recording any conflict.
      if (current.longComponent?.source !== 'litellm' && supplement.longComponent?.source === 'litellm') {
        current.long = supplement.long ? { ...supplement.long } : null
        current.longContextThreshold = supplement.longContextThreshold
        current.longComponent = supplement.longComponent ? { ...supplement.longComponent } : undefined
      }
      continue
    }
    if (!isCompleteLong(current) && isCompleteLong(supplement)) {
      // Replace the entire long component atomically. Never retain a partial
      // rate field from a source that could not prove the whole component.
      current.long = supplement.long ? { ...supplement.long } : null
      current.longContextThreshold = supplement.longContextThreshold
      current.longComponent = supplement.longComponent ? { ...supplement.longComponent } : undefined
    }
  }

  // Live models.dev is whole-model miss-only; it never fills a missing field.
  for (const [model, live] of Object.entries(input.live ?? {})) {
    if (!models[model] && isCompleteModel(live)) models[model] = cloneModelPrice(live)
  }

  // Embedded data is a last-good fallback for models omitted by a remote response.
  for (const [model, value] of Object.entries(createEmbeddedModels(now))) {
    if (!models[model]) models[model] = cloneModelPrice(value)
  }
  return { models, conflicts }
}

export function parsePricingMarkdown(markdown: string): Record<string, StoredModelPrice> {
  const lines = markdown.split(/\r?\n/).map((line) => cleanMarkdownLine(line))
  const models: Record<string, StoredModelPrice> = {}
  let foundHeader = false
  let parsedAny = false
  for (const line of lines) {
    const cells = splitTableRow(line)
    if (!foundHeader) {
      foundHeader = isTokenPriceHeader(cells)
      continue
    }
    if (cells.length === 0 || isSeparatorRow(cells)) continue
    const parsed = parseTokenPriceRow(cells)
    if (!parsed) {
      if (parsedAny) break
      continue
    }
    models[parsed.model] = parsed.price
    parsedAny = true
  }
  return models
}

export function parseModelPricingMarkdown(model: string, markdown: string): StoredModelPrice | null {
  const input = findLabelledMoney(markdown, 'Input')
  const cached = findLabelledMoney(markdown, 'Cached input')
  const output = findLabelledMoney(markdown, 'Output')
  if (input === null || cached === null || output === null) return null
  const cacheWriteMultiplier = findMultiplier(markdown, /Cache writes are billed at\s*([0-9.]+)x/iu)
  const thresholdMatch = markdown.match(/Prompts with\s*>\s*([0-9,]+)K input tokens/iu)
  const inputMultiplier = findMultiplier(markdown, /priced at\s*([0-9.]+)x input/iu)
  const outputMultiplier = findMultiplier(markdown, /and\s*([0-9.]+)x output/iu)
  const cacheWrite = cacheWriteMultiplier === null ? null : multiplyDecimal(input, cacheWriteMultiplier)
  return {
    short: makePriceSet(input, cached, cacheWrite, output),
    long: thresholdMatch
      ? makePriceSet(
          multiplyDecimal(input, inputMultiplier ?? 1),
          multiplyDecimal(cached, inputMultiplier ?? 1),
          cacheWrite === null ? null : multiplyDecimal(cacheWrite, inputMultiplier ?? 1),
          multiplyDecimal(output, outputMultiplier ?? 1)
        )
      : null,
    longContextThreshold: thresholdMatch ? (BigInt(thresholdMatch[1]!.replaceAll(',', '')) * 1_000n).toString() : null,
    aliases: [normalizeModelId(model)]
  }
}

function createEmbeddedModels(now: string): Record<string, StoredModelPrice> {
  const make = (model: string, short: StoredPriceSet, long: StoredPriceSet): StoredModelPrice => ({
    short,
    long,
    longContextThreshold: LONG_CONTEXT_THRESHOLD.toString(),
    base: { ...EMBEDDED_PROVENANCE, componentId: `embedded-base-${model}`, observedAt: now },
    longComponent: { ...EMBEDDED_LONG_PROVENANCE, componentId: `embedded-long-${model}`, observedAt: now }
  })
  return {
    'gpt-5.6-sol': make('gpt-5.6-sol', priceSet('5', '0.5', '6.25', '30'), priceSet('10', '1', '12.5', '45')),
    'gpt-5.6': make('gpt-5.6', priceSet('5', '0.5', '6.25', '30'), priceSet('10', '1', '12.5', '45')),
    'gpt-5.6-terra': make('gpt-5.6-terra', priceSet('2', '0.2', '2.5', '12'), priceSet('4', '0.4', '5', '18')),
    'gpt-5.6-luna': make('gpt-5.6-luna', priceSet('0.2', '0.02', '0.25', '1.2'), priceSet('0.4', '0.04', '0.5', '1.8')),
    'gpt-5.5': make('gpt-5.5', priceSet('5', '0.5', '6.25', '30'), priceSet('10', '1', '12.5', '45')),
    'gpt-5.4': make('gpt-5.4', priceSet('5', '0.5', '6.25', '30'), priceSet('10', '1', '12.5', '45')),
    'gpt-5.3-codex': make('gpt-5.3-codex', priceSet('5', '0.5', '6.25', '30'), priceSet('10', '1', '12.5', '45'))
  }
}

function createEmbeddedLongSupplement(now: string): Record<string, StoredModelPrice> {
  const embedded = createEmbeddedModels(now)
  const result: Record<string, StoredModelPrice> = {}
  for (const [model, value] of Object.entries(embedded)) {
    result[model] = { short: emptyPriceSet(), long: value.long, longContextThreshold: value.longContextThreshold, longComponent: value.longComponent }
  }
  return result
}

function createFastFacts(now: string): Record<string, FastPriceFact> {
  const result: Record<string, FastPriceFact> = {}
  for (const [model, value] of Object.entries(FAST_PRICE_FACTS)) {
    const reduced = reduceRational(value.numerator, value.denominator)
    result[model] = {
      model,
      numerator: reduced.numerator.toString(),
      denominator: reduced.denominator.toString(),
      source: {
        componentId: 'embedded-fast-facts-v2',
        source: 'embedded',
        sourceUrl: FAST_FACTS_SOURCE_URL,
        sourceSha256: FAST_FACTS_SHA256,
        sourceCommit: null,
        effectiveAt: '2026-08-19T00:00:00.000Z',
        observedAt: now,
        checkedAt: null,
        quality: 'embedded'
      }
    }
  }
  return result
}

function makeProvenance(provenance: Omit<PriceComponentProvenance, 'componentId'> & { componentId?: string }, componentId: string): PriceComponentProvenance {
  return { ...provenance, componentId }
}

function parseLiteLLMRate(record: Record<string, unknown>): StoredPriceSet | null {
  const input = tokenUsdToMicro(record.input_cost_per_token ?? record.input)
  const output = tokenUsdToMicro(record.output_cost_per_token ?? record.output)
  const cached = tokenUsdToMicro(record.cache_read_input_token_cost ?? record.cached_input_cost_per_token ?? record.cache_read)
  if (input === null || output === null || cached === null) return null
  return {
    inputMicroUsdPerMillion: input,
    cachedInputMicroUsdPerMillion: cached,
    cacheWriteMicroUsdPerMillion: tokenUsdToMicro(record.cache_creation_input_token_cost ?? record.cache_write_input_token_cost),
    outputMicroUsdPerMillion: output
  }
}

interface ExplicitLiteLLMLongRate {
  rate: StoredPriceSet
  threshold: string
}

function parseExplicitLiteLLMLongRate(record: Record<string, unknown>): ExplicitLiteLLMLongRate | null {
  // Keep this allowlist deliberately explicit: max_input_tokens/max_tokens
  // are capacity fields and must not be interpreted as pricing components.
  const nestedKeys = [
    'long',
    'long_context',
    'longContext',
    'long_context_pricing',
    'longContextPricing',
    'context_window_pricing'
  ]
  for (const key of nestedKeys) {
    const nested = record[key]
    if (!isRecord(nested)) continue
    const rate = parseLiteLLMRate(nested)
    if (!rate) continue
    return { rate, threshold: parseLongThreshold(nested) }
  }

  const direct = {
    input: firstDefined(record, ['input_cost_per_token_above_272k', 'input_cost_per_token_above_272K', 'long_context_input_cost_per_token', 'long_input_cost_per_token']) ?? firstMatching(record, /(?:^long(?:_context)?_input_cost_per_token$|^input_cost_per_token_(?:above|over)_\d+k$|^input_cost_per_token_(?:long|long_context)$)/iu),
    cached: firstDefined(record, ['cache_read_input_token_cost_above_272k', 'cache_read_input_token_cost_above_272K', 'long_context_cache_read_input_token_cost', 'long_cache_read_input_token_cost']) ?? firstMatching(record, /(?:^long(?:_context)?_cache_read_input_token_cost$|^cache_read_input_token_cost_(?:above|over)_\d+k$|^cache_read_input_token_cost_(?:long|long_context)$)/iu),
    cacheWrite: firstDefined(record, ['cache_creation_input_token_cost_above_272k', 'cache_creation_input_token_cost_above_272K', 'long_context_cache_creation_input_token_cost', 'long_cache_creation_input_token_cost']) ?? firstMatching(record, /(?:^long(?:_context)?_cache_(?:creation|write)_input_token_cost$|^cache_(?:creation|write)_input_token_cost_(?:above|over)_\d+k$|^cache_(?:creation|write)_input_token_cost_(?:long|long_context)$)/iu),
    output: firstDefined(record, ['output_cost_per_token_above_272k', 'output_cost_per_token_above_272K', 'long_context_output_cost_per_token', 'long_output_cost_per_token']) ?? firstMatching(record, /(?:^long(?:_context)?_output_cost_per_token$|^output_cost_per_token_(?:above|over)_\d+k$|^output_cost_per_token_(?:long|long_context)$)/iu)
  }
  const input = tokenUsdToMicro(direct.input)
  const cached = tokenUsdToMicro(direct.cached)
  const output = tokenUsdToMicro(direct.output)
  if (input === null || cached === null || output === null) return null
  return {
    rate: {
      inputMicroUsdPerMillion: input,
      cachedInputMicroUsdPerMillion: cached,
      cacheWriteMicroUsdPerMillion: tokenUsdToMicro(direct.cacheWrite),
      outputMicroUsdPerMillion: output
    },
    threshold: parseLongThreshold(record)
  }
}

function firstDefined(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) if (record[key] !== undefined && record[key] !== null) return record[key]
  return undefined
}

function firstMatching(record: Record<string, unknown>, pattern: RegExp): unknown {
  const key = Object.keys(record).find((candidate) => pattern.test(candidate))
  return key ? record[key] : undefined
}

function parseLongThreshold(record: Record<string, unknown>): string {
  for (const key of Object.keys(record)) {
    const match = key.match(/_(?:above|over)_(\d+)k$/iu)
    if (match) return (BigInt(match[1]!) * 1_000n).toString()
  }
  const candidate = record.long_context_threshold ?? record.longContextThreshold ?? record.long_context_pricing_threshold ?? record.longContextPricingThreshold ?? record.threshold
  const numeric = numericValue(candidate)
  return Number.isFinite(numeric) && numeric > 0 ? Math.trunc(numeric).toString() : LONG_CONTEXT_THRESHOLD.toString()
}

function parseModelsDevRate(record: Record<string, unknown>): StoredPriceSet | null {
  const cost = isRecord(record.cost) ? record.cost : record
  const input = usdPerMillionToMicro(cost.input ?? cost.prompt ?? cost.input_cost)
  const output = usdPerMillionToMicro(cost.output ?? cost.completion ?? cost.output_cost)
  const cached = usdPerMillionToMicro(cost.cache_read ?? cost.cached_input ?? cost.cacheRead ?? cost.cache_read_input)
  if (input === null || output === null || cached === null) return null
  return {
    inputMicroUsdPerMillion: input,
    cachedInputMicroUsdPerMillion: cached,
    cacheWriteMicroUsdPerMillion: usdPerMillionToMicro(cost.cache_write ?? cost.cache_creation ?? cost.cacheWrite),
    outputMicroUsdPerMillion: output
  }
}

function walkModelsDev(value: unknown, callback: (modelName: string, record: Record<string, unknown>) => void, keyHint = '', providerHint = ''): void {
  if (!isRecord(value)) return
  if (isRecord(value.cost) || value.input !== undefined || value.output !== undefined) {
    const modelName = typeof value.id === 'string' ? value.id : typeof value.name === 'string' ? value.name : keyHint
    if (modelName && (!providerHint || providerHint === 'openai' || providerHint === 'codex' || providerHint === 'models' || isRecognizedModel(providerHint))) callback(modelName, value)
  }
  for (const [key, child] of Object.entries(value)) {
    if (!isRecord(child)) continue
    const nextProvider = !providerHint && key.toLowerCase() !== 'models' && key.toLowerCase() !== 'model' ? key.toLowerCase() : providerHint
    walkModelsDev(child, callback, key, nextProvider)
  }
}

async function fetchLiveModelsDev(previous: StoredPriceBook, verifiedModels: Record<string, StoredModelPrice>, fetcher: PricingFetcher, now: string): Promise<{ models: Record<string, StoredModelPrice>; etag: string | null; payloadSha256: string | null; observedAt: string | null }> {
  try {
    const headers: Record<string, string> = { accept: 'application/json' }
    if (previous.liveModelsDevEtag) headers['if-none-match'] = previous.liveModelsDevEtag
    const response = await fetchTextWithPolicy(MODELS_DEV_URL, fetcher, 'models.dev', headers)
    if (response.notModified) {
      const previousLive: Record<string, StoredModelPrice> = {}
      for (const [model, value] of Object.entries(previous.models)) {
        if (value.base?.source === 'live-models.dev') previousLive[model] = value
      }
      return { models: previousLive, etag: previous.liveModelsDevEtag ?? null, payloadSha256: previous.liveModelsDevPayloadSha256 ?? null, observedAt: previous.liveModelsDevObservedAt ?? null }
    }
    const changedPayload = previous.liveModelsDevPayloadSha256 !== response.payloadSha256
    const observedAt = now
    const effectiveAt = changedPayload ? now : previous.liveModelsDevObservedAt ?? now
    const parsed = normalizeModelsDevPriceBook(response.value, {
      source: 'live-models.dev',
      sourceUrl: MODELS_DEV_URL,
      sourceSha256: response.payloadSha256,
      sourceCommit: null,
      effectiveAt,
      observedAt,
      checkedAt: now,
      quality: 'observed'
    }, { exactCase: true })
    const missing: Record<string, StoredModelPrice> = {}
    for (const [model, value] of Object.entries(parsed)) if (!verifiedModels[model]) missing[model] = value
    return { models: missing, etag: response.etag, payloadSha256: response.payloadSha256, observedAt: now }
  } catch {
    return { models: {}, etag: previous.liveModelsDevEtag ?? null, payloadSha256: previous.liveModelsDevPayloadSha256 ?? null, observedAt: previous.liveModelsDevObservedAt ?? null }
  }
}

interface ResponseTextResult {
  value: string
  payloadSha256: string
  etag: string | null
  notModified: boolean
}

interface TimedResponse {
  response: Response
  controller: AbortController
  clear: () => void
}

async function fetchTextWithPolicy(url: string, fetcher: PricingFetcher, expectedHost: string, headers?: Record<string, string>): Promise<ResponseTextResult> {
  const timed = await fetchWithRetry(url, fetcher, expectedHost, headers)
  try {
    const response = timed.response
    if (response.status === 304) return { value: '', payloadSha256: '', etag: response.headers.get('etag'), notModified: true }
    if (!response.ok) throw new Error(`Pricing endpoint returned HTTP ${response.status}`)
    const value = await readResponseTextLimited(response, timed.controller.signal)
    return { value, payloadSha256: sha256(value), etag: response.headers.get('etag'), notModified: false }
  } finally {
    timed.clear()
  }
}

async function fetchJsonWithPolicy(url: string, fetcher: PricingFetcher, expectedHost: string, headers?: Record<string, string>): Promise<{ value: unknown; notModified: boolean; etag: string | null }> {
  const timed = await fetchWithRetry(url, fetcher, expectedHost, headers)
  try {
    const response = timed.response
    if (response.status === 304) return { value: null, notModified: true, etag: response.headers.get('etag') }
    if (!response.ok) throw new Error(`Pricing endpoint returned HTTP ${response.status}`)
    return { value: parseJson(await readResponseTextLimited(response, timed.controller.signal)), notModified: false, etag: response.headers.get('etag') }
  } finally {
    timed.clear()
  }
}

async function fetchWithRetry(url: string, fetcher: PricingFetcher, expectedHost: string, headers?: Record<string, string>, redirectDepth = 0): Promise<TimedResponse> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || parsed.hostname !== expectedHost) throw new Error('Pricing host is not allowlisted')
  let last: TimedResponse | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const timed = await fetchTimed(url, REQUEST_TIMEOUT_MS, fetcher, { accept: 'application/json,text/plain;q=0.9,*/*;q=0.1', ...headers })
    last = timed
    const response = timed.response
    try {
      if (response.url) {
        const finalUrl = new URL(response.url)
        if (finalUrl.protocol !== 'https:' || finalUrl.hostname !== expectedHost) throw new Error('Pricing request attempted an insecure or cross-host redirect')
      }
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        const redirectUrl = new URL(location, url)
        if (redirectUrl.protocol !== 'https:' || redirectUrl.hostname !== expectedHost) throw new Error('Pricing request attempted an insecure or cross-host redirect')
        if (redirectDepth >= 2) throw new Error('Pricing endpoint redirected too many times')
        timed.clear()
        return fetchWithRetry(new URL(location, url).toString(), fetcher, expectedHost, headers, redirectDepth + 1)
      }
      if (![429, 500, 502, 503, 504].includes(response.status) || attempt === 2) return timed
    } catch (error) {
      timed.clear()
      throw error
    }
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'))
    timed.clear()
    await delay(Math.min(1_000, retryAfter ?? 50 * 2 ** attempt))
  }
  return last!
}

async function fetchTimed(url: string, timeoutMs: number, fetcher: PricingFetcher, headers?: Record<string, string>): Promise<TimedResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetcher(url, { signal: controller.signal, headers, redirect: 'manual' })
  } catch (error) {
    clearTimeout(timer)
    throw error
  }
  let cleared = false
  return {
    response,
    controller,
    clear: () => {
      if (cleared) return
      cleared = true
      clearTimeout(timer)
    }
  }
}

/**
 * Compatibility boundary: the old internal header-only fetchWithTimeout was
 * removed. Callers needing a bounded payload must use this full-body helper;
 * no Response is returned while its timeout is already cleared.
 */
export async function fetchTextWithTimeout(url: string, timeoutMs = REQUEST_TIMEOUT_MS, fetcher: PricingFetcher = fetch, headers?: Record<string, string>): Promise<string> {
  const timed = await fetchTimed(url, timeoutMs, fetcher, headers)
  try {
    if (!timed.response.ok) throw new Error(`Pricing endpoint returned HTTP ${timed.response.status}`)
    return await readResponseTextLimited(timed.response, timed.controller.signal)
  } finally {
    timed.clear()
  }
}

async function readResponseTextLimited(response: Response, signal?: AbortSignal): Promise<string> {
  if (!response.body) {
    const value = await response.text()
    throwIfAborted(signal)
    if (Buffer.byteLength(value, 'utf8') > MAX_RESPONSE_BYTES) throw new Error('Pricing response exceeded 64 MiB')
    return value
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  const onAbort = (): void => {
    void reader.cancel(signal?.reason)
  }
  if (signal?.aborted) throw signal.reason ?? new Error('Pricing response read timed out')
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    while (true) {
      const next = await reader.read()
      throwIfAborted(signal)
      if (next.done) break
      total += next.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Pricing response exceeded 64 MiB')
      }
      chunks.push(next.value)
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    reader.releaseLock()
  }
  throwIfAborted(signal)
  return new TextDecoder().decode(concatBytes(chunks, total))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const reason = signal.reason ?? Object.assign(new Error('Pricing response read aborted'), { name: 'AbortError' })
  throw reason
}

async function verifyDescendantChain(previous: string, candidate: string, fetcher: PricingFetcher): Promise<boolean> {
  if (!/^[0-9a-f]{40}$/iu.test(previous) || !/^[0-9a-f]{40}$/iu.test(candidate)) return false
  try {
    const endpoint = `https://api.github.com/repos/${LITELLM_OWNER}/${LITELLM_REPOSITORY}/compare/${previous}...${candidate}`
    const response = await fetchJsonWithPolicy(endpoint, fetcher, 'api.github.com')
    const record = isRecord(response.value) ? response.value : null
    return Boolean(record && (record.status === 'ahead' || record.status === 'identical'))
  } catch {
    return false
  }
}

function parseLatestCommitMetadata(value: unknown): { sha: string; date: string } | null {
  const candidate = Array.isArray(value) ? value[0] : value
  if (!isRecord(candidate)) return null
  const sha = typeof candidate.sha === 'string' ? candidate.sha : null
  const commit = isRecord(candidate.commit) ? candidate.commit : null
  const committer = commit && isRecord(commit.committer) ? commit.committer : null
  const date = typeof committer?.date === 'string' ? committer.date : null
  if (!sha || !/^[0-9a-f]{40}$/iu.test(sha) || !date || !Number.isFinite(Date.parse(date))) return null
  return { sha: sha.toLowerCase(), date: new Date(date).toISOString() }
}

function ensurePriceBook(book: StoredPriceBook): StoredPriceBook {
  const embedded = createBundledPriceBook(book.updatedAt || new Date().toISOString())
  const candidate = { ...embedded, ...book, models: book.models ?? embedded.models, conflicts: book.conflicts ?? [], fastFacts: book.fastFacts ?? embedded.fastFacts, lastError: book.lastError ?? null }
  if (!isValidPriceBook(candidate)) {
    return {
      ...embedded,
      updatedAt: book.updatedAt || embedded.updatedAt,
      stale: true,
      message: 'Stored pricing required normalization; using the pinned bundle until refresh succeeds.',
      lastError: null
    }
  }
  return candidate
}

function cloneModelPrice(value: StoredModelPrice): StoredModelPrice {
  return {
    short: { ...value.short },
    long: value.long ? { ...value.long } : null,
    longContextThreshold: value.longContextThreshold,
    ...(value.base ? { base: { ...value.base } } : {}),
    ...(value.longComponent ? { longComponent: { ...value.longComponent } } : {}),
    ...(value.aliases ? { aliases: [...value.aliases] } : {})
  }
}

function mergeModels(left: Record<string, StoredModelPrice>, right: Record<string, StoredModelPrice>): Record<string, StoredModelPrice> {
  const result: Record<string, StoredModelPrice> = {}
  for (const [model, value] of Object.entries(left)) result[model] = cloneModelPrice(value)
  for (const [model, value] of Object.entries(right)) result[model] = cloneModelPrice(value)
  return result
}

function isCompletePriceSet(value: StoredPriceSet | null): value is StoredPriceSet {
  return value !== null &&
    /^\d+$/u.test(value.inputMicroUsdPerMillion) &&
    /^\d+$/u.test(value.cachedInputMicroUsdPerMillion) &&
    /^\d+$/u.test(value.outputMicroUsdPerMillion) &&
    (value.cacheWriteMicroUsdPerMillion === null || /^\d+$/u.test(value.cacheWriteMicroUsdPerMillion))
}

function isCompleteLong(value: StoredModelPrice): boolean {
  return isCompletePriceSet(value.long)
}

function isCompleteModel(value: StoredModelPrice): boolean {
  return isCompletePriceSet(value.short) && Boolean(value.base)
}

function isValidPriceBook(value: StoredPriceBook): boolean {
  if (value.schemaVersion !== 2 || value.normalizationRevision !== PRICING_NORMALIZATION_REVISION) return false
  if (!['verified', 'observed', 'embedded'].includes(value.sourceQuality ?? '')) return false
  if (!isRecord(value.models) || Object.keys(value.models).length === 0) return false
  for (const model of Object.values(value.models)) {
    if (!isRecord(model) || !isCompletePriceSet(model.short) || !hasPositiveRate(model.short) || !('long' in model)) return false
    if (model.long !== null && !isCompletePriceSet(model.long)) return false
  }
  if (value.payloadSha256 && value.payloadSha256 !== canonicalPricingHash(value.models)) return false
  return true
}

function hasEffectiveBase(value: StoredModelPrice): boolean {
  if (value.base) return isCompletePriceSet(value.short) && hasPositiveRate(value.short)
  // v1 markdown fixtures have no component metadata. A non-zero short set is
  // still an effective legacy price; the all-zero placeholder used for a
  // long-only LiteLLM row is deliberately unpriced.
  return isCompletePriceSet(value.short) && [
    value.short.inputMicroUsdPerMillion,
    value.short.cachedInputMicroUsdPerMillion,
    value.short.outputMicroUsdPerMillion
  ].some((rate) => /^\d+$/.test(rate) && BigInt(rate) > 0n)
}

function hasPositiveRate(value: StoredPriceSet): boolean {
  return [value.inputMicroUsdPerMillion, value.cachedInputMicroUsdPerMillion, value.cacheWriteMicroUsdPerMillion, value.outputMicroUsdPerMillion]
    .some((rate) => rate !== null && /^\d+$/u.test(rate) && BigInt(rate) > 0n)
}

function isRecognizedModel(model: string): boolean {
  const normalized = normalizeModelId(model)
  return /^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$)|codex(?:[.-]|$))/iu.test(normalized) && !/^(?:azure|anthropic|bedrock|vertex)[/:]/iu.test(model)
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new Error('Pricing response was not valid JSON')
  }
}

function tokenUsdToMicro(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return scaledDecimalToInteger(value, 1_000_000_000_000n, 'LiteLLM token price')
}

function usdPerMillionToMicro(value: unknown): string | null {
  if (value === undefined || value === null) return null
  return scaledDecimalToInteger(value, 1_000_000n, 'models.dev price')
}

function scaledDecimalToInteger(value: unknown, scale: bigint, label: string): string | null {
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : ''
  const match = text.match(/^\+?(?<whole>\d+)(?:\.(?<fraction>\d*))?(?:e(?<exponent>[+-]?\d+))?$/iu) ?? text.match(/^\+?\.(?<fractionOnly>\d+)(?:e(?<exponentOnly>[+-]?\d+))?$/iu)
  if (!match) throw new Error(`${label} was not a non-negative decimal/scientific value`)
  const whole = match.groups?.whole ?? '0'
  const fraction = match.groups?.fraction ?? match.groups?.fractionOnly ?? ''
  const exponent = Number(match.groups?.exponent ?? match.groups?.exponentOnly ?? '0')
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 10_000) throw new Error(`${label} exponent is out of bounds`)
  const digitsText = `${whole}${fraction}`.replace(/^0+(?=\d)/u, '') || '0'
  const digits = BigInt(digitsText)
  const decimalPlaces = fraction.length - exponent
  let numerator: bigint
  let denominator: bigint
  if (decimalPlaces >= 0) {
    denominator = 10n ** BigInt(decimalPlaces)
    numerator = digits * scale
  } else {
    denominator = 1n
    numerator = digits * scale * (10n ** BigInt(-decimalPlaces))
  }
  if (numerator % denominator !== 0n) throw new Error(`${label} contains excess precision after scaling`)
  const result = numerator / denominator
  if (result > 9_007_199_254_740_991n) throw new Error(`${label} exceeds the safe integer range`)
  return result.toString()
}

function parseMicroRate(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Invalid persisted microUSD rate')
  return BigInt(value)
}

function numericValue(value: unknown): number {
  return typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : 0
}

function emptyPriceSet(): StoredPriceSet {
  return { inputMicroUsdPerMillion: '0', cachedInputMicroUsdPerMillion: '0', cacheWriteMicroUsdPerMillion: null, outputMicroUsdPerMillion: '0' }
}

function priceSet(input: string, cachedInput: string, cacheWrite: string | null, output: string): StoredPriceSet {
  return { inputMicroUsdPerMillion: decimalUsdToMicroUsd(input), cachedInputMicroUsdPerMillion: decimalUsdToMicroUsd(cachedInput), cacheWriteMicroUsdPerMillion: cacheWrite === null ? null : decimalUsdToMicroUsd(cacheWrite), outputMicroUsdPerMillion: decimalUsdToMicroUsd(output) }
}

function makePriceSet(input: string, cachedInput: string, cacheWrite: string | null, output: string): StoredPriceSet {
  return priceSet(input, cachedInput, cacheWrite, output)
}

function decimalUsdToMicroUsd(value: string): string {
  return scaledDecimalToInteger(value.replaceAll(',', '').trim(), 1_000_000n, 'Markdown price')!
}

function cleanMarkdownLine(line: string): string {
  return line.replaceAll('`', '').trim()
}

function splitTableRow(line: string): string[] {
  if (!line.includes('|')) return []
  return line.replace(/^\s*\|/u, '').replace(/\|\s*$/u, '').split('|').map((cell) => cell.trim())
}

function isSeparatorRow(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))
}

function isTokenPriceHeader(cells: string[]): boolean {
  return cells.length >= 9 && cells[0]?.toLowerCase() === 'model' && cells.filter((cell) => cell.toLowerCase() === 'input').length >= 2 && cells.filter((cell) => cell.toLowerCase() === 'output').length >= 2
}

function parseTokenPriceRow(cells: string[]): { model: string; price: StoredModelPrice } | null {
  if (cells.length < 9) return null
  const model = cells[0]?.trim()
  if (!model || !isRecognizedModel(model)) return null
  const values = cells.slice(1, 9).map(parseMoney)
  if (values.slice(0, 4).some((value) => value === null)) return null
  const short = makePriceSet(values[0]!, values[1]!, values[2]!, values[3]!)
  const hasLong = values.slice(4).every((value) => value !== null)
  const long = hasLong ? makePriceSet(values[4]!, values[5]!, values[6]!, values[7]!) : null
  return { model, price: { short, long, longContextThreshold: long ? LONG_CONTEXT_THRESHOLD.toString() : null } }
}

function parseMoney(cell: string | undefined): string | null {
  if (!cell || cell.trim() === '-') return null
  const match = cell.match(/\$?\s*([0-9][0-9,.]*)/u)
  return match?.[1]?.replaceAll(',', '') ?? null
}

function findLabelledMoney(markdown: string, label: string): string | null {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const regex = new RegExp(`${escaped}[\\s|:*_\\-]*\\$([0-9][0-9,.]*)`, 'iu')
  return markdown.match(regex)?.[1]?.replaceAll(',', '') ?? null
}

function findMultiplier(markdown: string, regex: RegExp): number | null {
  const parsed = Number(markdown.match(regex)?.[1])
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function multiplyDecimal(value: string, multiplier: number): string {
  const scaled = Math.round(Number(value) * multiplier * 1_000_000)
  return (scaled / 1_000_000).toFixed(6).replace(/\.?0+$/u, '')
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

function stripVolatileProvenance(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileProvenance)
  if (isRecord(value)) {
    const result: Record<string, unknown> = {}
    for (const [key, child] of Object.entries(value)) {
      if (key === 'observedAt' || key === 'checkedAt') continue
      result[key] = stripVolatileProvenance(child)
    }
    return result
  }
  return value
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

const MODEL_ALIASES: Record<string, string> = {
  'gpt-5.6-codex': 'gpt-5.6',
  'gpt-5.3': 'gpt-5.3-codex',
  'gpt-5.3-codex-latest': 'gpt-5.3-codex'
}

export const pricingConstants = {
  PRICING_URL: OFFICIAL_PRICING_URL,
  PRICING_NORMALIZATION_REVISION,
  LITELLM_COMMIT_API,
  LITELLM_RAW_PREFIX,
  MODELS_DEV_URL,
  PRICE_CHECK_INTERVAL_MS,
  STALE_AFTER_MS,
  REQUEST_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MAX_FAST_RATIONAL_DIGITS,
  LONG_CONTEXT_THRESHOLD,
  ALLOWLISTED_HOSTS: ['api.github.com', 'raw.githubusercontent.com', 'models.dev'] as const
}

export const pricingInternals = {
  parseLatestCommitMetadata,
  parseRetryAfter,
  isRecognizedModel,
  resolveCanonicalModelPrice,
  hasEffectiveBase,
  readResponseTextLimited,
  stableJson,
  stripVolatileProvenance
}
