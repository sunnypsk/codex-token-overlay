import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { TokenBreakdown } from '../shared/contracts.js'
import {
  calculateModelCostDetailed,
  resolveCanonicalModelPrice,
  resolveEffectiveModelPricing,
  type PricingQuality,
  type PricingSource,
  type StoredPriceBook
} from './pricing.js'
import type {
  PersistentState,
  ServiceTier,
  StoredModelAggregate,
  StoredSessionState,
  StoredSpeedAggregate
} from './state.js'
import { deserializeTokens, zeroTokens } from './token-math.js'

export const PRICING_DIAGNOSTIC_EVENT = 'pricing-diagnostic.v1'
const DEFAULT_MAX_BYTES = 512 * 1024
const DEFAULT_MAX_ENTRIES = 256
const MAX_SAMPLES = 8
const MAX_FILE_BYTES = 512 * 1024
const MAX_ENTRIES = 256
const MAX_STRING_LENGTH = 96
const MAX_HASH_INPUT_LENGTH = 4_096
const MAX_DECIMAL_DIGITS = 48

export type PricingDiagnosticReason =
  | 'legacy_fallback'
  | 'unknown_context'
  | 'missing_model_or_alias'
  | 'pre_effective_or_missing_rate'
  | 'priceable'

export type PricingDiagnosticSourceKind = PricingSource | 'mixed' | 'unknown'

export interface PricingDiagnosticSample {
  model: string
  componentId?: string
  reason: PricingDiagnosticReason
  context: 'short' | 'long' | 'unknown'
  serviceTier: ServiceTier
  tokens: string
  lowerBound: boolean
}

export interface PricingDiagnosticSummary {
  recordVersion: 1
  event: typeof PRICING_DIAGNOSTIC_EVENT
  at: string
  summaryHash: string
  pricing: {
    /** Fixed source enum; arbitrary persisted URLs are never serialized. */
    source: PricingDiagnosticSourceKind
    sourceSha256: string | null
    payloadSha256: string | null
    sourceQuality: PricingQuality | 'unknown'
    stale: boolean
    checkedAt: string | null
    updatedAt: string | null
    effectiveAt: string | null
    observedAt: string | null
    componentCount: number
  }
  rebuild: {
    state: string
    indexRevision: number
    attributionRevision: number
    processedFiles: number
    totalFiles: number
    pending: number
    unreconciledSessions: number
    mode: string
    replayedSessions: number
    retainedLegacySessions: number
    rawTokenDelta: string
    failureDiagnostics: string[]
  }
  totals: {
    localTokens: string
    pricedTokens: string
    unpricedTokens: string
    lowerBoundTokens: string
    overflowBuckets: string
  }
  /** Primary reason counts are mutually exclusive and sum to local buckets. */
  reasonCounts: Record<PricingDiagnosticReason, string>
  samples: PricingDiagnosticSample[]
}

export interface PricingDiagnosticsOptions {
  maxBytes?: number
  maxEntries?: number
  now?: () => string
  log?: (message: string) => void
  warn?: (message: string) => void
}

interface MutableTotals {
  localTokens: bigint
  pricedTokens: bigint
  unpricedTokens: bigint
  lowerBoundTokens: bigint
  overflowBuckets: bigint
}

interface SampleCandidate extends PricingDiagnosticSample {
  tokenCount: bigint
}

interface StoredSegment {
  model: string
  aggregate: StoredModelAggregate
  legacy: boolean
}

/**
 * Builds a privacy-safe summary from the persisted projection. It deliberately
 * reads aggregate buckets only; raw JSONL payloads and session identifiers
 * never enter the diagnostic object.
 */
export function buildPricingDiagnosticSummary(
  state: PersistentState,
  now = new Date().toISOString()
): PricingDiagnosticSummary {
  const totals: MutableTotals = {
    localTokens: 0n,
    pricedTokens: 0n,
    unpricedTokens: 0n,
    lowerBoundTokens: 0n,
    overflowBuckets: 0n
  }
  const reasonCounts: Record<PricingDiagnosticReason, bigint> = {
    legacy_fallback: 0n,
    unknown_context: 0n,
    missing_model_or_alias: 0n,
    pre_effective_or_missing_rate: 0n,
    priceable: 0n
  }
  const samples: SampleCandidate[] = []
  const seenComponents = new Set<string>()
  for (const model of Object.values(state.priceBook.models)) {
    if (model.base?.componentId) seenComponents.add(model.base.componentId)
    if (model.longComponent?.componentId) seenComponents.add(model.longComponent.componentId)
  }

  for (const session of Object.values(state.sessions)) {
    for (const segment of collectSessionSegments(session)) {
      for (const [speed, speedUsage] of collectSpeedBuckets(segment.aggregate)) {
        const eventAt = speedUsage.firstEventAt ?? segment.aggregate.firstEventAt ?? state.priceBook.updatedAt
        for (const context of ['short', 'long', 'unknown'] as const) {
          const rawUsage = speedUsage[context] ?? serializeZero()
          const usage = readDiagnosticTokens(rawUsage)
          if (usage.overflow) {
            totals.overflowBuckets += 1n
            continue
          }
          const tokens = usage.tokens
          if (tokens.total <= 0n) continue
          totals.localTokens += tokens.total

          const classification = classifyBucket({
            book: state.priceBook,
            ledger: state.pricingLedger,
            model: segment.model,
            context,
            serviceTier: speed,
            eventAt,
            legacy: segment.legacy,
            tokens
          })
          reasonCounts[classification.reason] += tokens.total
          totals.pricedTokens += classification.pricedTokens
          totals.unpricedTokens += classification.unpricedTokens
          if (classification.lowerBound) totals.lowerBoundTokens += tokens.total
          const componentId = classification.componentId
          if (componentId) seenComponents.add(componentId)
          samples.push({
            model: classification.modelLabel,
            ...(componentId ? { componentId: safeComponentLabel(componentId) } : {}),
            reason: classification.reason,
            context,
            serviceTier: speed,
            tokens: boundedDecimal(tokens.total),
            lowerBound: classification.lowerBound,
            tokenCount: tokens.total
          })
        }
      }
    }
  }

  const sampleRows = samples
    .sort((left, right) => right.tokenCount > left.tokenCount ? 1 : right.tokenCount < left.tokenCount ? -1 : sampleKey(left).localeCompare(sampleKey(right)))
    .slice(0, MAX_SAMPLES)
    .map(({ tokenCount: _tokenCount, ...sample }) => sample)
  const base: Omit<PricingDiagnosticSummary, 'at' | 'summaryHash'> = {
    recordVersion: 1,
    event: PRICING_DIAGNOSTIC_EVENT,
    pricing: {
      source: sourceKindForBook(state.priceBook),
      sourceSha256: safeDigest(state.priceBook.sourceSha256),
      payloadSha256: safeDigest(state.priceBook.payloadSha256),
      sourceQuality: safeQuality(state.priceBook.sourceQuality),
      stale: state.priceBook.stale,
      checkedAt: safeTimestamp(state.priceBook.checkedAt),
      updatedAt: safeTimestamp(state.priceBook.updatedAt),
      effectiveAt: safeTimestamp(state.priceBook.sourceEffectiveAt),
      observedAt: safeTimestamp(state.priceBook.observedAt),
      componentCount: seenComponents.size
    },
    rebuild: {
      state: safeRebuildState(state.rebuild.state),
      indexRevision: safeNumber(state.indexRevision),
      attributionRevision: safeNumber(state.attributionRevision),
      processedFiles: safeNumber(state.rebuild.processedFiles),
      totalFiles: safeNumber(state.rebuild.totalFiles),
      pending: safeNumber(state.rebuild.pending),
      unreconciledSessions: safeNumber(state.unreconciledSessions.length),
      mode: safeRebuildMode(state.rebuild.mode),
      replayedSessions: safeNumber(state.rebuild.replayedSessions),
      retainedLegacySessions: safeNumber(state.rebuild.retainedLegacySessions),
      rawTokenDelta: safeSignedCount(state.rebuild.rawTokenDelta),
      failureDiagnostics: safeFailureDiagnostics(state.rebuild.failureDiagnostics)
    },
    totals: {
      localTokens: boundedDecimal(totals.localTokens),
      pricedTokens: boundedDecimal(totals.pricedTokens),
      unpricedTokens: boundedDecimal(totals.unpricedTokens),
      lowerBoundTokens: boundedDecimal(totals.lowerBoundTokens),
      overflowBuckets: boundedDecimal(totals.overflowBuckets)
    },
    reasonCounts: serializeReasonCounts(reasonCounts),
    samples: sampleRows
  }
  const at = safeTimestamp(now) ?? new Date().toISOString()
  return { ...base, at, summaryHash: semanticSummaryHash({ ...base, at }) }
}

export class PricingDiagnostics {
  private static readonly announcedPaths = new Set<string>()
  readonly filePath: string
  private readonly maxBytes: number
  private readonly maxEntries: number
  private readonly now: () => string
  private readonly log: (message: string) => void
  private readonly warn: (message: string) => void
  private writing: Promise<boolean> = Promise.resolve(false)

  constructor(logsPath: string, options: PricingDiagnosticsOptions = {}) {
    this.filePath = logsPath.toLowerCase().endsWith('.jsonl') ? logsPath : join(logsPath, 'pricing-diagnostics.jsonl')
    this.maxBytes = Math.min(MAX_FILE_BYTES, Math.max(256, options.maxBytes ?? DEFAULT_MAX_BYTES))
    this.maxEntries = Math.min(MAX_ENTRIES, Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES))
    this.now = options.now ?? (() => new Date().toISOString())
    this.log = options.log ?? ((message) => console.info(message))
    this.warn = options.warn ?? (() => console.warn('Unable to persist pricing diagnostics.'))
    if (!PricingDiagnostics.announcedPaths.has(this.filePath)) {
      PricingDiagnostics.announcedPaths.add(this.filePath)
      this.log(`Pricing diagnostics: ${this.filePath}`)
    }
  }

  emit(state: PersistentState): Promise<boolean> {
    let summary: PricingDiagnosticSummary
    try {
      summary = sanitizeSummaryForWrite(buildPricingDiagnosticSummary(state, this.now()))
    } catch {
      this.warn('Unable to build pricing diagnostics.')
      return Promise.resolve(false)
    }
    const task = this.writing.then(() => this.writeIfChanged(summary), () => this.writeIfChanged(summary))
    this.writing = task.catch(() => false)
    return task.catch(() => false)
  }

  async flush(): Promise<void> {
    await this.writing.catch(() => false)
  }

  private async writeIfChanged(summary: PricingDiagnosticSummary): Promise<boolean> {
    try {
      await mkdir(dirname(this.filePath), { recursive: true })
      const existing = await readFile(this.filePath, 'utf8').catch(() => '')
      const validLines = parseValidLines(existing).map((line) => capExistingLine(line, this.maxBytes))
      const rawLines = existing.split(/\r?\n/u).filter(Boolean)
      const duplicate = hasSummaryHash(validLines, summary.summaryHash)
      const canonical = rawLines.length === validLines.length && rawLines.every((line, index) => line === validLines[index])
      let changed = !duplicate || !canonical
      if (!duplicate) validLines.push(serializeSummaryLine(summary, this.maxBytes))
      while (validLines.length > this.maxEntries) {
        validLines.shift()
        changed = true
      }
      while (Buffer.byteLength(`${validLines.join('\n')}\n`, 'utf8') > this.maxBytes && validLines.length > 1) {
        validLines.shift()
        changed = true
      }
      if (!changed) return false
      const content = `${validLines.join('\n')}\n`
      await writeAtomically(this.filePath, content)
      return true
    } catch {
      // Deliberately omit the path and error text: persisted diagnostics must
      // not turn an I/O failure into a new privacy leak.
      this.warn('Unable to persist pricing diagnostics.')
      return false
    }
  }
}

function sanitizeSummaryForWrite(summary: PricingDiagnosticSummary): PricingDiagnosticSummary {
  if (isSafeDiagnosticRecord(summary)) return summary
  const fallback = {
    recordVersion: 1 as const,
    event: PRICING_DIAGNOSTIC_EVENT as typeof PRICING_DIAGNOSTIC_EVENT,
    at: safeTimestamp(summary.at) ?? new Date().toISOString(),
    pricing: {
      source: 'unknown' as const,
      sourceSha256: null,
      payloadSha256: null,
      sourceQuality: 'unknown' as const,
      stale: false,
      checkedAt: null,
      updatedAt: null,
      effectiveAt: null,
      observedAt: null,
      componentCount: 0
    },
    rebuild: {
      state: 'unknown',
      indexRevision: 0,
      attributionRevision: 0,
      processedFiles: 0,
      totalFiles: 0,
      pending: 0,
      unreconciledSessions: 0,
      mode: 'unknown',
      replayedSessions: 0,
      retainedLegacySessions: 0,
      rawTokenDelta: '0',
      failureDiagnostics: []
    },
    totals: {
      localTokens: 'overflow#0000000000000000',
      pricedTokens: 'overflow#0000000000000000',
      unpricedTokens: 'overflow#0000000000000000',
      lowerBoundTokens: 'overflow#0000000000000000',
      overflowBuckets: '1'
    },
    reasonCounts: {
      legacy_fallback: '0',
      unknown_context: '0',
      missing_model_or_alias: '0',
      pre_effective_or_missing_rate: '0',
      priceable: '0'
    },
    samples: []
  }
  return { ...fallback, summaryHash: semanticSummaryHash(fallback) }
}

function semanticSummaryHash(value: Record<string, unknown>): string {
  const { at: _at, ...withoutAt } = value
  const pricing = withoutAt.pricing
  return sha256(JSON.stringify({
    ...withoutAt,
    pricing: pricing && typeof pricing === 'object'
      ? { ...(pricing as Record<string, unknown>), checkedAt: null, updatedAt: '', observedAt: null }
      : pricing
  }))
}

function serializeSummaryLine(summary: PricingDiagnosticSummary, maxBytes: number): string {
  const variants: unknown[] = [
    summary,
    { ...summary, samples: [] },
    {
      ...summary,
      samples: [],
      pricing: {
        ...summary.pricing,
        sourceSha256: null,
        payloadSha256: null,
        checkedAt: null,
        updatedAt: null,
        effectiveAt: null,
        observedAt: null,
        componentCount: 0
      }
    },
    {
      event: summary.event,
      at: summary.at,
      summaryHash: summary.summaryHash,
      totals: summary.totals,
      reasonCounts: summary.reasonCounts
    },
    { event: summary.event, at: summary.at, summaryHash: summary.summaryHash }
  ]
  for (const value of variants) {
    const line = JSON.stringify(value)
    if (Buffer.byteLength(`${line}\n`, 'utf8') <= maxBytes) return line
  }
  // The final variant is already bounded to fixed enums, hashes, and a
  // generated timestamp. This fallback remains valid JSON even for a very
  // small test cap, so a single candidate can never exceed the hard cap.
  return JSON.stringify({ event: summary.event, summaryHash: summary.summaryHash })
}

function capExistingLine(line: string, maxBytes: number): string {
  if (Buffer.byteLength(`${line}\n`, 'utf8') <= maxBytes) return line
  try {
    return serializeSummaryLine(JSON.parse(line) as PricingDiagnosticSummary, maxBytes)
  } catch {
    return JSON.stringify({ event: PRICING_DIAGNOSTIC_EVENT, summaryHash: '0'.repeat(64) })
  }
}

function parseValidLines(content: string): string[] {
  const valid: string[] = []
  for (const line of content.split(/\r?\n/u)) {
    if (!line) continue
    try {
      const value = JSON.parse(line) as { event?: unknown; summaryHash?: unknown; recordVersion?: unknown }
      if (value.event !== PRICING_DIAGNOSTIC_EVENT || typeof value.summaryHash !== 'string' || !/^[0-9a-f]{64}$/iu.test(value.summaryHash)) continue
      // Rebuild the retained line from only fixed fields. This also repairs
      // diagnostics written by an older build that may contain source URLs or
      // unbounded model labels.
      valid.push(isSafeDiagnosticRecord(value)
        ? JSON.stringify(value)
        : JSON.stringify({ event: PRICING_DIAGNOSTIC_EVENT, summaryHash: value.summaryHash.toLowerCase() }))
    } catch {
      // Drop malformed interior/trailing lines during the next successful
      // write rather than preserving untrusted bytes.
    }
  }
  return valid
}

function isSafeDiagnosticRecord(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  const topLevel = ['recordVersion', 'event', 'at', 'summaryHash', 'pricing', 'rebuild', 'totals', 'reasonCounts', 'samples']
  if (Object.keys(record).some((key) => !topLevel.includes(key))) return false
  if (record.recordVersion !== 1 || record.event !== PRICING_DIAGNOSTIC_EVENT || typeof record.summaryHash !== 'string' || !/^[0-9a-f]{64}$/iu.test(record.summaryHash)) return false
  if (safeTimestamp(record.at) === null) return false
  const pricing = record.pricing
  if (!pricing || typeof pricing !== 'object' || Array.isArray(pricing)) return false
  const pricingRecord = pricing as Record<string, unknown>
  if (Object.keys(pricingRecord).some((key) => !['source', 'sourceSha256', 'payloadSha256', 'sourceQuality', 'stale', 'checkedAt', 'updatedAt', 'effectiveAt', 'observedAt', 'componentCount'].includes(key))) return false
  if (!isSourceKindOrMixed(pricingRecord.source) || (pricingRecord.sourceQuality !== 'verified' && pricingRecord.sourceQuality !== 'observed' && pricingRecord.sourceQuality !== 'embedded' && pricingRecord.sourceQuality !== 'stale' && pricingRecord.sourceQuality !== 'unverified' && pricingRecord.sourceQuality !== 'legacy' && pricingRecord.sourceQuality !== 'unknown')) return false
  if (!isSafeDigestOrNull(pricingRecord.sourceSha256) || !isSafeDigestOrNull(pricingRecord.payloadSha256)) return false
  for (const key of ['checkedAt', 'updatedAt', 'effectiveAt', 'observedAt']) {
    if (pricingRecord[key] !== null && safeTimestamp(pricingRecord[key]) === null) return false
  }
  if (typeof pricingRecord.stale !== 'boolean' || !isFiniteInteger(pricingRecord.componentCount)) return false
  const rebuild = record.rebuild
  if (!rebuild || typeof rebuild !== 'object' || Array.isArray(rebuild)) return false
  const rebuildRecord = rebuild as Record<string, unknown>
  if (Object.keys(rebuildRecord).some((key) => !['state', 'indexRevision', 'attributionRevision', 'processedFiles', 'totalFiles', 'pending', 'unreconciledSessions', 'mode', 'replayedSessions', 'retainedLegacySessions', 'rawTokenDelta', 'failureDiagnostics'].includes(key))) return false
  if (rebuildRecord.state !== safeRebuildState(rebuildRecord.state)) return false
  for (const key of ['indexRevision', 'attributionRevision', 'processedFiles', 'totalFiles', 'pending', 'unreconciledSessions']) {
    if (!isFiniteInteger(rebuildRecord[key])) return false
  }
  if (rebuildRecord.mode !== safeRebuildMode(rebuildRecord.mode)) return false
  for (const key of ['replayedSessions', 'retainedLegacySessions']) {
    if (!isFiniteInteger(rebuildRecord[key])) return false
  }
  if (!isSignedCount(rebuildRecord.rawTokenDelta)) return false
  if (!Array.isArray(rebuildRecord.failureDiagnostics) || rebuildRecord.failureDiagnostics.length > 32 || !rebuildRecord.failureDiagnostics.every((item) => isSafeFailureDiagnostic(item))) return false
  const totals = record.totals
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return false
  if (Object.keys(totals as Record<string, unknown>).some((key) => !['localTokens', 'pricedTokens', 'unpricedTokens', 'lowerBoundTokens', 'overflowBuckets'].includes(key))) return false
  for (const value of Object.values(totals as Record<string, unknown>)) if (!isBoundedCount(value)) return false
  const reasons = record.reasonCounts
  if (!reasons || typeof reasons !== 'object' || Array.isArray(reasons)) return false
  if (Object.keys(reasons as Record<string, unknown>).some((key) => !['legacy_fallback', 'unknown_context', 'missing_model_or_alias', 'pre_effective_or_missing_rate', 'priceable'].includes(key))) return false
  for (const value of Object.values(reasons as Record<string, unknown>)) if (!isBoundedCount(value)) return false
  if (!Array.isArray(record.samples) || record.samples.length > MAX_SAMPLES) return false
  return record.samples.every((sample) => {
    if (!sample || typeof sample !== 'object' || Array.isArray(sample)) return false
    const row = sample as Record<string, unknown>
    if (Object.keys(row).some((key) => !['model', 'componentId', 'reason', 'context', 'serviceTier', 'tokens', 'lowerBound'].includes(key))) return false
    return isSafeLabel(row.model, 'model') &&
      (row.componentId === undefined || isSafeLabel(row.componentId, 'component')) &&
      (row.reason === 'legacy_fallback' || row.reason === 'unknown_context' || row.reason === 'missing_model_or_alias' || row.reason === 'pre_effective_or_missing_rate' || row.reason === 'priceable') &&
      (row.context === 'short' || row.context === 'long' || row.context === 'unknown') &&
      (row.serviceTier === 'standard' || row.serviceTier === 'fast' || row.serviceTier === 'unknown') &&
      isBoundedCount(row.tokens) &&
      typeof row.lowerBound === 'boolean'
  })
}

function isFiniteInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isBoundedCount(value: unknown): value is string {
  return typeof value === 'string' && ((/^\d+$/u.test(value) && value.length <= MAX_DECIMAL_DIGITS) || /^overflow#[0-9a-f]{16}$/u.test(value))
}

function isSignedCount(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+$/u.test(value) && value.replace(/^-?/u, '').length <= MAX_DECIMAL_DIGITS
}

function safeSignedCount(value: unknown): string {
  return isSignedCount(value) ? value : '0'
}

function safeRebuildMode(value: unknown): string {
  return value === 'background-replay' || value === 'incremental' || value === 'idle' || value === 'unknown'
    ? value
    : 'unknown'
}

function isSafeFailureDiagnostic(value: unknown): value is string {
  return value === 'raw-missing' || value === 'raw-invalid' || value === 'raw-unstable' || value === 'raw-read-failed'
}

function safeFailureDiagnostics(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isSafeFailureDiagnostic).slice(0, 32) : []
}

function isSafeDigestOrNull(value: unknown): boolean {
  return value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/iu.test(value))
}

function isSafeLabel(value: unknown, kind: 'model' | 'component'): boolean {
  if (typeof value !== 'string' || value.length > MAX_STRING_LENGTH) return false
  return new RegExp(`^(?:${kind}#[0-9a-f]{16}|[a-z0-9._-]{1,${MAX_STRING_LENGTH}})$`, 'iu').test(value)
}

function isSourceKindOrMixed(value: unknown): value is PricingDiagnosticSourceKind {
  return value === 'mixed' || value === 'unknown' || isSourceKind(value)
}

async function writeAtomically(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`
  try {
    await writeDurably(temporary, content)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

async function writeDurably(path: string, content: string): Promise<void> {
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

interface BucketClassification {
  reason: PricingDiagnosticReason
  priced: boolean
  lowerBound: boolean
  pricedTokens: bigint
  unpricedTokens: bigint
  componentId?: string
  modelLabel: string
}

function classifyBucket(input: {
  book: StoredPriceBook
  ledger: PersistentState['pricingLedger']
  model: string
  context: 'short' | 'long' | 'unknown'
  serviceTier: ServiceTier
  eventAt: string
  legacy: boolean
  tokens: ReturnType<typeof deserializeTokens>
}): BucketClassification {
  const effective = resolveEffectiveModelPricing(input.book, input.model, input.eventAt, input.ledger)
  const currentSupported = findSupportedModelPrice(input.book, input.model)
  const resolvedKey = effective.resolvedKey ?? currentSupported?.key
  const resolvedPrice = effective.price ?? currentSupported?.price
  const modelLabel = opaqueLabel('model', resolvedKey ?? input.model)
  if (input.legacy) return { reason: 'legacy_fallback', priced: false, lowerBound: true, pricedTokens: 0n, unpricedTokens: input.tokens.total, modelLabel }
  if (!resolvedKey) return { reason: 'missing_model_or_alias', priced: false, lowerBound: true, pricedTokens: 0n, unpricedTokens: input.tokens.total, modelLabel }
  const price = resolvedPrice
  if (input.context === 'unknown') {
    return {
      reason: 'unknown_context',
      priced: false,
      lowerBound: true,
      pricedTokens: 0n,
      unpricedTokens: input.tokens.total,
      componentId: price?.base?.componentId,
      modelLabel
    }
  }
  if (!effective.price || !effective.hasEffectiveBase || (input.context === 'long' && !effective.hasEffectiveLong)) {
    return {
      reason: 'pre_effective_or_missing_rate',
      priced: false,
      lowerBound: true,
      pricedTokens: 0n,
      unpricedTokens: input.tokens.total,
      componentId: input.context === 'long' ? price?.longComponent?.componentId ?? price?.base?.componentId : price?.base?.componentId,
      modelLabel
    }
  }
  const detailed = calculateModelCostDetailed(
    input.context === 'short'
      ? { short: input.tokens, long: zeroTokens() }
      : { short: zeroTokens(), long: input.tokens },
    effective.price,
    { fast: input.serviceTier === 'fast', fastFact: effective.fastFact }
  )
  const pricedTokens = detailed.pricedTokens > input.tokens.total ? input.tokens.total : detailed.pricedTokens
  const lowerBound = input.serviceTier === 'unknown' || (input.serviceTier === 'fast' && !effective.fastFact) || detailed.lowerBound === true
  return {
    reason: 'priceable',
    priced: true,
    lowerBound,
    pricedTokens,
    unpricedTokens: input.tokens.total - pricedTokens,
    componentId: input.context === 'long' ? price?.longComponent?.componentId ?? price?.base?.componentId : price?.base?.componentId,
    modelLabel
  }
}

function findSupportedModelPrice(book: StoredPriceBook, model: string): ReturnType<typeof resolveCanonicalModelPrice> {
  return resolveCanonicalModelPrice(book, model)
}

function safeComponentLabel(componentId: string): string {
  return opaqueLabel('component', componentId)
}

function sourceKindForBook(book: StoredPriceBook): PricingDiagnosticSourceKind {
  const kinds = new Set<PricingSource>()
  for (const price of Object.values(book.models)) {
    for (const component of [price.base, price.longComponent]) {
      if (component && isSourceKind(component.source)) kinds.add(component.source)
    }
  }
  if (kinds.size === 1) return [...kinds][0]!
  if (kinds.size > 1) return 'mixed'
  return isSourceKind(book.sourceQuality) ? book.sourceQuality : 'unknown'
}

function isSourceKind(value: unknown): value is PricingSource {
  return value === 'litellm' || value === 'models.dev' || value === 'live-models.dev' || value === 'embedded' || value === 'legacy' || value === 'official'
}

function safeQuality(value: unknown): PricingQuality | 'unknown' {
  return value === 'verified' || value === 'observed' || value === 'embedded' || value === 'stale' || value === 'unverified' || value === 'legacy'
    ? value
    : 'unknown'
}

function safeRebuildState(value: unknown): string {
  return value === 'idle' || value === 'queued' || value === 'indexing' || value === 'validating' || value === 'complete' || value === 'partial' || value === 'blocked' || value === 'aborted'
    ? value
    : 'unknown'
}

function safeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function safeDigest(value: unknown): string | null {
  if (value === null || value === undefined) return null
  const text = typeof value === 'string' ? value : String(value)
  return /^[0-9a-f]{64}$/iu.test(text) ? text.toLowerCase() : sha256(text.slice(0, MAX_HASH_INPUT_LENGTH))
}

function safeTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/iu.test(value)) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function opaqueLabel(kind: string, value: string): string {
  return `${kind}#${sha256(value.slice(0, MAX_HASH_INPUT_LENGTH)).slice(0, 16)}`
}

function collectSessionSegments(session: StoredSessionState): StoredSegment[] {
  const result: StoredSegment[] = []
  for (const daily of Object.values(session.legacyDaily ?? {})) {
    for (const [model, aggregate] of Object.entries(daily.models ?? {})) result.push({ model, aggregate, legacy: true })
  }
  if (!session.legacyDaily && session.legacyUnpriced === true) {
    for (const daily of Object.values(session.daily ?? {})) {
      for (const [model, aggregate] of Object.entries(daily.models ?? {})) result.push({ model, aggregate, legacy: true })
    }
  } else {
    for (const daily of Object.values(session.daily ?? {})) {
      for (const [model, aggregate] of Object.entries(daily.models ?? {})) result.push({ model, aggregate, legacy: false })
    }
  }
  return result
}

function collectSpeedBuckets(aggregate: StoredModelAggregate): Array<[ServiceTier, StoredSpeedAggregate]> {
  const entries = Object.entries(aggregate.bySpeed ?? {})
    .filter((entry): entry is [ServiceTier, StoredSpeedAggregate] => isServiceTier(entry[0]) && Boolean(entry[1]))
  if (entries.length > 0) return entries
  return [['standard', {
    short: aggregate.short,
    long: aggregate.long,
    unknown: aggregate.unknown,
    eventCount: aggregate.eventCount,
    firstEventAt: aggregate.firstEventAt,
    lastEventAt: aggregate.lastEventAt
  }]]
}

function serializeZero() {
  return { input: '0', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '0' }
}

function readDiagnosticTokens(value: unknown): { tokens: ReturnType<typeof deserializeTokens>; overflow: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { tokens: deserializeTokens(serializeZero()), overflow: true }
  const record = value as Record<string, unknown>
  const fields = ['input', 'cachedInput', 'cacheWriteInput', 'output', 'reasoningOutput', 'total'] as const
  const normalized = serializeZero() as TokenBreakdown
  for (const field of fields) {
    const raw = record[field]
    if (raw === undefined) continue
    if (typeof raw !== 'string' || !/^\d+$/u.test(raw) || raw.length > MAX_DECIMAL_DIGITS) {
      return { tokens: deserializeTokens(serializeZero()), overflow: true }
    }
    normalized[field] = raw
  }
  return { tokens: deserializeTokens(normalized), overflow: false }
}

function boundedDecimal(value: bigint): string {
  const text = value.toString()
  return text.length <= MAX_DECIMAL_DIGITS ? text : `overflow#${sha256(text).slice(0, 16)}`
}

function serializeReasonCounts(value: Record<PricingDiagnosticReason, bigint>): Record<PricingDiagnosticReason, string> {
  return Object.fromEntries(Object.entries(value).map(([key, count]) => [key, boundedDecimal(count)])) as Record<PricingDiagnosticReason, string>
}

function sampleKey(sample: SampleCandidate): string {
  return `${sample.model}|${sample.componentId ?? ''}|${sample.reason}|${sample.context}|${sample.serviceTier}|${sample.lowerBound}`
}

function hasSummaryHash(lines: string[], hash: string): boolean {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line) continue
    try {
      const value = JSON.parse(line) as { event?: unknown; summaryHash?: unknown }
      if (value.event === PRICING_DIAGNOSTIC_EVENT && value.summaryHash === hash) return true
    } catch {
      // Ignore a partial trailing line; the next write repairs the file.
    }
  }
  return false
}

function isServiceTier(value: string): value is ServiceTier {
  return value === 'standard' || value === 'fast' || value === 'unknown'
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export const pricingDiagnosticsConstants = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_ENTRIES,
  MAX_FILE_BYTES,
  MAX_ENTRIES,
  MAX_STRING_LENGTH,
  MAX_DECIMAL_DIGITS,
  MAX_SAMPLES,
  PRICING_DIAGNOSTIC_EVENT
}
