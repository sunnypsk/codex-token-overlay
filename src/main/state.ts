import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { OverlaySettings, RateLimitBucket, TokenBreakdown } from '../shared/contracts.js'
import { serializeTokens, zeroTokens } from './token-math.js'
import { createBundledPriceBook, type StoredPriceBook } from './pricing.js'

export type ServiceTier = 'standard' | 'fast' | 'unknown'
export type ContextClass = 'short' | 'long' | 'unknown'

export interface StoredContextUsage {
  short: TokenBreakdown
  long: TokenBreakdown
  unknown?: TokenBreakdown
}

export interface StoredSpeedAggregate extends StoredContextUsage {
  eventCount: number
  lowerBound?: boolean
  firstEventAt?: string
  lastEventAt?: string
}

export interface StoredModelAggregate extends StoredContextUsage {
  eventCount: number
  firstEventAt?: string
  lastEventAt?: string
  /** v2 dimension: standard, fast, and unknown are never merged. */
  bySpeed?: Partial<Record<ServiceTier, StoredSpeedAggregate>>
}

export interface StoredDailyAggregate {
  models: Record<string, StoredModelAggregate>
}

export interface StoredCycleAggregate {
  limitId: string
  resetsAt: number
  windowDurationMins: number
  models: Record<string, StoredModelAggregate>
  usedPercents: number[]
  firstSampleAt: string
  lastSampleAt: string
}

export interface StoredSessionState {
  sessionId: string
  path: string
  offset: number
  fileSize: number
  modifiedAtMs: number
  contentFingerprint?: string
  prefixFingerprint?: string
  recoveryAnchor?: {
    cumulative: TokenBreakdown
    offset: number
    prefixFingerprint: string
    model: string
    serviceTier: ServiceTier
  }
  currentModel: string
  lastEventModel?: string
  lastEventServiceTier?: ServiceTier
  currentServiceTier?: ServiceTier
  lastCumulative: TokenBreakdown | null
  daily: Record<string, StoredDailyAggregate>
  cycles: Record<string, StoredCycleAggregate>
  eventCount: number
  parseErrors: number
  /** Fallback aggregate retained when a legacy prefix cannot be proven. */
  legacyDaily?: Record<string, StoredDailyAggregate>
  legacyCycles?: Record<string, StoredCycleAggregate>
  legacyEventCount?: number
  /** Pricing identity used for the last complete raw replay. */
  pricingSemanticHash?: string | null
  pricingIndexRevision?: number
  /** Set when v1 state cannot be reconciled to a rewritten/missing raw file. */
  legacyUnpriced?: boolean
  unreconciled?: boolean
  missingRaw?: boolean
  /** Full byte-0 raw replay remains required after a failed migration. */
  fullRawReplayPending?: boolean
  fingerprintBootstrapPending?: boolean
  baselineOffset?: number
  baselinePrefixFingerprint?: string
  baselineCumulative?: TokenBreakdown
  baselineModel?: string
  baselineServiceTier?: ServiceTier
}

export interface StoredAccountUsage {
  lifetimeTokens: string | null
  peakDailyTokens: string | null
  dailyUsageBuckets: Record<string, string>
  syncedAt: string | null
}

export interface StoredWindowState {
  x: number | null
  y: number | null
}

export interface PricingLedgerEntry {
  id: string
  effectiveAt: string
  observedAt: string
  source: string
  sourceSha256: string | null
  semanticHash: string
  models: Record<string, unknown>
}

export interface PendingPricingQueueEntry {
  id: string
  sessionId: string
  filePath: string
  capturedSize: number
  capturedOffset: number
  queuedAt: string
  status: 'pending' | 'processing' | 'complete' | 'aborted'
  error?: string | null
}

export interface RebuildProgress {
  state: 'idle' | 'queued' | 'indexing' | 'validating' | 'complete' | 'partial' | 'blocked' | 'aborted'
  totalFiles: number
  processedFiles: number
  pending: number
  message: string | null
  /** Provenance for the latest rebuild; optional for old v2 state files. */
  mode?: string
  replayedSessions?: number
  retainedLegacySessions?: number
  rawTokenDelta?: string
  failureDiagnostics?: string[]
}

export interface PersistentState {
  version: 2
  settings: OverlaySettings
  window: StoredWindowState
  sessions: Record<string, StoredSessionState>
  account: StoredAccountUsage
  rateLimits: RateLimitBucket[]
  rateLimitsSyncedAt: string | null
  priceBook: StoredPriceBook
  localIndexedAt: string | null
  pricingLedger: PricingLedgerEntry[]
  pendingPricingQueue: PendingPricingQueueEntry[]
  unreconciledSessions: string[]
  rebuild: RebuildProgress
  /** Durable replay/migration revision for the indexed session projection. */
  indexRevision: number
  /** Explicit attribution/classification revision for persisted token buckets. */
  attributionRevision: number
}

export interface PricingManifestPointer {
  schemaVersion: 2
  active: { file: string; sha256: string }
  previous?: { file: string; sha256: string }
  updatedAt: string
}

export function createDefaultState(now = new Date().toISOString()): PersistentState {
  return {
    version: 2,
    settings: { alwaysOnTop: true, startAtLogin: true, expanded: false },
    window: { x: null, y: null },
    sessions: {},
    account: { lifetimeTokens: null, peakDailyTokens: null, dailyUsageBuckets: {}, syncedAt: null },
    rateLimits: [],
    rateLimitsSyncedAt: null,
    priceBook: createBundledPriceBook(now),
    localIndexedAt: null,
    pricingLedger: [],
    pendingPricingQueue: [],
    unreconciledSessions: [],
    rebuild: {
      state: 'idle',
      totalFiles: 0,
      processedFiles: 0,
      pending: 0,
      message: null,
      mode: 'idle',
      replayedSessions: 0,
      retainedLegacySessions: 0,
      rawTokenDelta: '0',
      failureDiagnostics: []
    },
    indexRevision: STATE_INDEX_REVISION,
    attributionRevision: ATTRIBUTION_REVISION
  }
}

export function createEmptyStoredModelAggregate(): StoredModelAggregate {
  const empty = serializeTokens(zeroTokens())
  return { short: { ...empty }, long: { ...empty }, unknown: { ...empty }, eventCount: 0, bySpeed: {} }
}

export function createEmptyStoredSpeedAggregate(): StoredSpeedAggregate {
  const empty = serializeTokens(zeroTokens())
  return { short: { ...empty }, long: { ...empty }, unknown: { ...empty }, eventCount: 0, lowerBound: false }
}

export interface StateStoreOptions {
  /** Optional deterministic generation directory for tests. */
  generationDirectory?: string
  /** Disable the direct legacy fallback only in tests that explicitly want it. */
  legacyFallback?: boolean
}

/** Bump when the persisted session projection or replay rules change. */
export const STATE_INDEX_REVISION = 5

/** Bump when model/context/tier attribution rules change. */
export const ATTRIBUTION_REVISION = 4

export class StateStore {
  private static readonly locks = new Map<string, Promise<void>>()
  private state: PersistentState = createDefaultState()
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | null = null
  private mutationRevision = 0
  private durableRevision = -1
  private durableStateFingerprint: string | null = null
  private readonly generationDirectory: string
  private readonly manifestPath: string
  private readonly legacyFallback: boolean

  constructor(private readonly filePath: string, options: StateStoreOptions = {}) {
    this.generationDirectory = options.generationDirectory ?? `${filePath}.generations`
    this.manifestPath = `${filePath}.manifest.json`
    this.legacyFallback = options.legacyFallback ?? true
  }

  async load(): Promise<PersistentState> {
    const candidates = await this.readManifestCandidates()
    for (const candidate of candidates) {
      const parsed = await this.readGeneration(candidate)
      if (parsed) {
        this.state = await mergeLegacyV1Fallback(parsed, this.filePath)
        this.resetDurabilityTracking(fingerprintDurableState(parsed))
        return this.state
      }
    }
    if (this.legacyFallback) {
      try {
        const raw = await readFile(this.filePath, 'utf8')
        const parsed = JSON.parse(raw) as unknown
        if (isStateLike(parsed)) {
          this.state = migrateLegacyState(parsed)
          this.resetDurabilityTracking()
          return this.state
        }
      } catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : ''
        if (code !== 'ENOENT') console.warn('Unable to load persisted state:', error)
      }
    }
    this.state = createDefaultState()
    this.resetDurabilityTracking()
    return this.state
  }

  get(): PersistentState {
    return this.state
  }

  update(mutator: (state: PersistentState) => void, saveImmediately = false): void {
    mutator(this.state)
    this.mutationRevision += 1
    if (saveImmediately) void this.save()
    else this.scheduleSave()
  }

  /**
   * Apply a projection cutover as one in-memory mutation and await its
   * durable generation write. The overload also accepts a complete state for
   * callers that already prepared an atomic replacement.
   */
  async replaceStateAtomically(next: PersistentState | ((state: PersistentState) => void)): Promise<void> {
    if (typeof next === 'function') this.update(next)
    else {
      this.state = { ...next, version: 2 }
      this.mutationRevision += 1
    }
    await this.save()
  }

  scheduleSave(delayMs = 750): void {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save()
    }, delayMs)
  }

  async save(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    while (this.durableRevision < this.mutationRevision || this.durableRevision < 0) {
      if (this.saving) {
        await this.saving
        continue
      }
      const targetRevision = this.mutationRevision
      const targetContent = `${JSON.stringify({ ...this.state, version: 2 })}\n`
      const targetFingerprint = fingerprintDurableState(this.state)
      if (targetFingerprint === this.durableStateFingerprint) {
        this.durableRevision = targetRevision
        continue
      }
      const previous = StateStore.locks.get(this.filePath) ?? Promise.resolve()
      const write = previous.catch(() => undefined).then(() => this.writeGenerationAtomically(targetContent))
      this.saving = write
      StateStore.locks.set(this.filePath, write)
      try {
        await write
        // If a mutation landed while the generation was being written, keep
        // the durable marker behind it so this same awaited save must create
        // and await a follow-up generation.
        this.durableRevision = targetRevision
        this.durableStateFingerprint = targetFingerprint
      } finally {
        if (StateStore.locks.get(this.filePath) === write) StateStore.locks.delete(this.filePath)
        if (this.saving === write) this.saving = null
      }
    }
  }

  private resetDurabilityTracking(durableStateFingerprint: string | null = null): void {
    this.mutationRevision = 0
    this.durableRevision = -1
    this.durableStateFingerprint = durableStateFingerprint
  }

  async readManifest(): Promise<PricingManifestPointer | null> {
    try {
      const value = JSON.parse(await readFile(this.manifestPath, 'utf8')) as unknown
      return isManifest(value) ? value : null
    } catch {
      return null
    }
  }

  private async readManifestCandidates(): Promise<PricingManifestPointer[]> {
    const manifest = await this.readManifest()
    if (!manifest) return []
    const ordered = [manifest.active, ...(manifest.previous ? [manifest.previous] : [])]
    return [{ ...manifest, active: ordered[0]!, ...(ordered[1] ? { previous: ordered[1] } : {}) }]
  }

  private async readGeneration(manifest: PricingManifestPointer): Promise<PersistentState | null> {
    const pointers = [manifest.active, ...(manifest.previous ? [manifest.previous] : [])]
    for (const pointer of pointers) {
      try {
        const path = join(this.generationDirectory, basename(pointer.file))
        const content = await readFile(path, 'utf8')
        if (sha256(content) !== pointer.sha256) continue
        const parsed = JSON.parse(content) as unknown
        if (isStateLike(parsed)) return migrateLegacyState(parsed)
      } catch {
        // Try the previous generation before falling back to the legacy file.
      }
    }
    return null
  }

  private async writeGenerationAtomically(content: string): Promise<void> {
    await mkdir(this.generationDirectory, { recursive: true })
    const file = `usage-state-v2-${Date.now()}-${randomUUID()}.json`
    const generationPath = join(this.generationDirectory, file)
    await writeDurably(generationPath, content)
    const digest = sha256(content)
    const previousManifest = await this.readManifest()
    const manifest: PricingManifestPointer = {
      schemaVersion: 2,
      active: { file, sha256: digest },
      ...(previousManifest?.active ? { previous: previousManifest.active } : {}),
      updatedAt: new Date().toISOString()
    }
    const temporaryManifest = `${this.manifestPath}.${randomUUID()}.tmp`
    await writeDurably(temporaryManifest, `${JSON.stringify(manifest)}\n`)
    await rename(temporaryManifest, this.manifestPath)
    await pruneObsoleteGenerations(this.generationDirectory, new Set([file, previousManifest?.active.file].filter((value): value is string => Boolean(value))))
  }
}

export function migrateLegacyState(value: unknown): PersistentState {
  const source = isRecord(value) ? value : {}
  const defaults = createDefaultState()
  const version = source.version
  if (version === 2 && isStateV2(source)) {
    const persistedRevision = numberOrZero(source.indexRevision)
    const persistedAttributionRevision = numberOrZero(source.attributionRevision)
    const needsReplay = persistedRevision < STATE_INDEX_REVISION || persistedAttributionRevision < ATTRIBUTION_REVISION
    const migratedSessions = normalizeV2Sessions(source.sessions)
    return {
      ...defaults,
      ...source,
      version: 2,
      indexRevision: persistedRevision,
      attributionRevision: persistedAttributionRevision,
      sessions: migratedSessions,
      priceBook: normalizeLegacyPriceBook(source.priceBook, defaults.priceBook),
      pricingLedger: Array.isArray(source.pricingLedger) ? source.pricingLedger as PricingLedgerEntry[] : [],
      pendingPricingQueue: normalizePricingQueue(source.pendingPricingQueue),
      unreconciledSessions: Array.isArray(source.unreconciledSessions) ? source.unreconciledSessions.filter((item): item is string => typeof item === 'string') : [],
      rebuild: needsReplay
        ? {
            state: 'queued',
            totalFiles: 0,
            processedFiles: 0,
            pending: Object.keys(migratedSessions).length,
            message: 'Indexed projection revision is old; awaiting atomic raw replay.',
            mode: 'background-replay',
            replayedSessions: 0,
            retainedLegacySessions: 0,
            rawTokenDelta: '0',
            failureDiagnostics: []
          }
        : isRecord(source.rebuild) ? normalizeRebuild(source.rebuild) : defaults.rebuild
    }
  }
  const sessions: Record<string, StoredSessionState> = {}
  if (isRecord(source.sessions)) {
    for (const [sessionId, raw] of Object.entries(source.sessions)) {
      if (!isRecord(raw)) continue
      sessions[sessionId] = prepareLegacySession({
        ...(raw as unknown as StoredSessionState),
        sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : sessionId,
        path: typeof raw.path === 'string' ? raw.path : '',
      })
    }
  }
  const account = isRecord(source.account) ? source.account : {}
  return {
    ...defaults,
    settings: isRecord(source.settings) ? { ...defaults.settings, ...(source.settings as Partial<OverlaySettings>) } : defaults.settings,
    window: isRecord(source.window) ? { ...defaults.window, ...(source.window as Partial<StoredWindowState>) } : defaults.window,
    sessions,
    account: {
      lifetimeTokens: typeof account.lifetimeTokens === 'string' ? account.lifetimeTokens : null,
      peakDailyTokens: typeof account.peakDailyTokens === 'string' ? account.peakDailyTokens : null,
      dailyUsageBuckets: isRecord(account.dailyUsageBuckets) ? Object.fromEntries(Object.entries(account.dailyUsageBuckets).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {},
      syncedAt: typeof account.syncedAt === 'string' ? account.syncedAt : null
    },
    rateLimits: Array.isArray(source.rateLimits) ? source.rateLimits as RateLimitBucket[] : [],
    rateLimitsSyncedAt: typeof source.rateLimitsSyncedAt === 'string' ? source.rateLimitsSyncedAt : null,
    priceBook: normalizeLegacyPriceBook(source.priceBook, defaults.priceBook),
    localIndexedAt: typeof source.localIndexedAt === 'string' ? source.localIndexedAt : null,
    pricingLedger: [],
    pendingPricingQueue: [],
    unreconciledSessions: Object.keys(sessions),
    rebuild: {
      state: 'queued',
      totalFiles: 0,
      processedFiles: 0,
      pending: Object.keys(sessions).length,
      message: 'Migrated from v1; awaiting background reconciliation.',
      mode: 'background-replay',
      replayedSessions: 0,
      retainedLegacySessions: 0,
      rawTokenDelta: '0',
      failureDiagnostics: []
    },
    indexRevision: 0,
    attributionRevision: 0
  }
}

function normalizeLegacyPriceBook(value: unknown, fallback: StoredPriceBook): StoredPriceBook {
  if (!isRecord(value) || !isRecord(value.models)) return fallback
  const models: Record<string, unknown> = value.models
  return {
    ...fallback,
    ...(value as Partial<StoredPriceBook>),
    schemaVersion: 2,
    normalizationRevision: typeof value.normalizationRevision === 'number' ? value.normalizationRevision : 0,
    models: Object.fromEntries(Object.entries(models).filter((entry) => isRecord(entry[1]))) as StoredPriceBook['models'],
    sourceQuality: value.sourceQuality === 'verified' || value.sourceQuality === 'observed' || value.sourceQuality === 'embedded' || value.sourceQuality === 'stale' || value.sourceQuality === 'unverified' ? value.sourceQuality : 'legacy',
    conflicts: Array.isArray(value.conflicts) ? value.conflicts : [],
    fastFacts: isRecord(value.fastFacts) ? value.fastFacts as StoredPriceBook['fastFacts'] : fallback.fastFacts,
    lastError: typeof value.lastError === 'string' ? value.lastError : null
  }
}

function normalizeRebuild(value: Record<string, unknown>): RebuildProgress {
  const states: RebuildProgress['state'][] = ['idle', 'queued', 'indexing', 'validating', 'complete', 'partial', 'blocked', 'aborted']
  const state = states.includes(value.state as RebuildProgress['state']) ? value.state as RebuildProgress['state'] : 'idle'
  return {
    state,
    totalFiles: numberOrZero(value.totalFiles),
    processedFiles: numberOrZero(value.processedFiles),
    pending: numberOrZero(value.pending),
    message: typeof value.message === 'string' ? value.message : null,
    mode: typeof value.mode === 'string' ? value.mode : undefined,
    replayedSessions: numberOrZero(value.replayedSessions),
    retainedLegacySessions: numberOrZero(value.retainedLegacySessions),
    rawTokenDelta: typeof value.rawTokenDelta === 'string' ? value.rawTokenDelta : '0',
    failureDiagnostics: Array.isArray(value.failureDiagnostics)
      ? value.failureDiagnostics.filter((item): item is string => typeof item === 'string').slice(0, 32)
      : []
  }
}

function normalizeV2Sessions(value: unknown): Record<string, StoredSessionState> {
  if (!isRecord(value)) return {}
  const sessions: Record<string, StoredSessionState> = {}
  for (const [sessionId, raw] of Object.entries(value)) {
    if (!isRecord(raw)) continue
    const session = raw as unknown as StoredSessionState
    const normalized: StoredSessionState = {
      ...session,
      sessionId: typeof session.sessionId === 'string' ? session.sessionId : sessionId,
      path: typeof session.path === 'string' ? session.path : '',
      daily: isRecord(session.daily) ? session.daily : {},
      cycles: isRecord(session.cycles) ? session.cycles : {},
      fingerprintBootstrapPending: !session.prefixFingerprint || !session.recoveryAnchor,
      pricingSemanticHash: typeof session.pricingSemanticHash === 'string' ? session.pricingSemanticHash : null,
      pricingIndexRevision: numberOrZero(session.pricingIndexRevision),
      fullRawReplayPending: session.fullRawReplayPending === true
    }
    // Keep both the v0.1.4 legacy fallback and the current split projection
    // during a revision migration. The sidecar replay decides atomically
    // whether raw replaces both; a failed/missing raw read must retain the
    // exact composite instead of silently dropping the current slice.
    sessions[sessionId] = normalized
  }
  return sessions
}

function normalizePricingQueue(value: unknown): PendingPricingQueueEntry[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((raw) => {
    if (!isRecord(raw)) return []
    if (raw.status === 'complete' || raw.status === 'aborted') return []
    const status = 'pending' as const
    if (typeof raw.id !== 'string' || typeof raw.sessionId !== 'string' || typeof raw.filePath !== 'string') return []
    return [{
      id: raw.id,
      sessionId: raw.sessionId,
      filePath: raw.filePath,
      capturedSize: numberOrZero(raw.capturedSize),
      capturedOffset: numberOrZero(raw.capturedOffset),
      queuedAt: typeof raw.queuedAt === 'string' ? raw.queuedAt : '',
      // A process crash must never leave an immortal processing item.
      status,
      error: typeof raw.error === 'string' ? raw.error : null
    } satisfies PendingPricingQueueEntry]
  })
}

function prepareLegacySession(session: StoredSessionState): StoredSessionState {
  const legacyDaily = session.legacyDaily ?? (Object.keys(session.daily ?? {}).length > 0 ? session.daily : undefined)
  const legacyCycles = session.legacyCycles ?? (Object.keys(session.cycles ?? {}).length > 0 ? session.cycles : undefined)
  const permanentFallback = Boolean((session.legacyDaily || session.legacyCycles) && session.legacyUnpriced === false)
  return {
    ...session,
    daily: {},
    cycles: {},
    legacyDaily,
    legacyCycles,
    legacyEventCount: session.legacyEventCount ?? session.eventCount ?? 0,
    eventCount: 0,
    legacyUnpriced: permanentFallback ? false : true,
    unreconciled: permanentFallback ? session.unreconciled === true : true,
    missingRaw: permanentFallback ? session.missingRaw === true : true,
    pricingSemanticHash: null,
    pricingIndexRevision: 0
  }
}

async function mergeLegacyV1Fallback(state: PersistentState, filePath: string): Promise<PersistentState> {
  if (state.indexRevision >= STATE_INDEX_REVISION && state.attributionRevision >= ATTRIBUTION_REVISION) return state
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return state
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return state
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isStateLike(parsed)) return state
  const legacy = migrateLegacyState(parsed)
  for (const [sessionId, session] of Object.entries(legacy.sessions)) {
    if (state.sessions[sessionId]) {
      const current = state.sessions[sessionId]!
      // The untouched v1 file is the authoritative legacy aggregate. Keep
      // active-v2 metadata/settings elsewhere, but do not add both copies.
      if (session.legacyDaily) current.legacyDaily = session.legacyDaily
      if (session.legacyCycles) current.legacyCycles = session.legacyCycles
      if (session.legacyEventCount !== undefined) current.legacyEventCount = session.legacyEventCount
      current.legacyUnpriced = true
      current.unreconciled = true
      current.missingRaw = true
      continue
    }
    state.sessions[sessionId] = session
    if (!state.unreconciledSessions.includes(sessionId)) state.unreconciledSessions.push(sessionId)
  }
  state.rebuild = {
    state: 'queued',
    totalFiles: 0,
    processedFiles: 0,
    pending: Object.keys(state.sessions).length,
    message: 'Indexed projection is old; v1 fallback and raw replay are pending.',
    mode: 'background-replay',
    replayedSessions: 0,
    retainedLegacySessions: 0,
    rawTokenDelta: '0',
    failureDiagnostics: []
  }
  return state
}

async function writeDurably(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const handle = await open(path, 'w')
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function fingerprintDurableState(state: PersistentState): string {
  // Successful polls and scans refresh these observation-only fields even when
  // the durable usage projection is unchanged. Excluding them prevents the
  // large generation file from being rewritten on every heartbeat. The latest
  // values still ride along with the next substantive durable state change.
  return sha256(JSON.stringify({
    ...state,
    account: { ...state.account, syncedAt: null },
    rateLimitsSyncedAt: null,
    localIndexedAt: null,
    rebuild: { ...state.rebuild, processedFiles: 0 }
  }))
}

async function pruneObsoleteGenerations(directory: string, keep: Set<string>): Promise<void> {
  try {
    for (const file of await readdir(directory)) {
      if (!/^usage-state-v2-[0-9a-f-]+\.json$/iu.test(file) || keep.has(file)) continue
      await rm(join(directory, file), { force: true })
    }
  } catch {
    // Rotation is best-effort; active/previous manifest integrity remains the
    // source of truth and legacy usage-state.json is never in this directory.
  }
}

function isStateLike(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && (value.version === 1 || value.version === 2) && isRecord(value.settings) && isRecord(value.sessions) && isRecord(value.account) && isRecord(value.priceBook)
}

function isStateV2(value: Record<string, unknown>): boolean {
  return value.version === 2 && isRecord(value.settings) && isRecord(value.sessions) && isRecord(value.account) && isRecord(value.priceBook)
}

function isManifest(value: unknown): value is PricingManifestPointer {
  if (!isRecord(value) || value.schemaVersion !== 2 || !isRecord(value.active)) return false
  const active = value.active
  return typeof active.file === 'string' && /^[0-9a-f]{64}$/iu.test(String(active.sha256))
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export const stateConstants = {
  STATE_VERSION: 2,
  INDEX_REVISION: STATE_INDEX_REVISION,
  ATTRIBUTION_REVISION,
  MANIFEST_SUFFIX: '.manifest.json',
  GENERATION_SUFFIX: '.generations',
  MAX_GENERATIONS_IN_MANIFEST: 2
}
