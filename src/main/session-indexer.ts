import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { glob, open, readFile, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { createInterface } from 'node:readline'
import type { RateLimitBucket, TokenBreakdown } from '../shared/contracts.js'
import {
  addTokens,
  deserializeTokens,
  fromUnknownTokenUsage,
  isRecord,
  serializeTokens,
  subtractCumulativeTokens,
  zeroTokens,
  type BigTokenBreakdown
} from './token-math.js'
import { hongKongDateKey } from './time.js'
import { resolveEffectiveModelPricing } from './pricing.js'
import {
  createEmptyStoredModelAggregate,
  createEmptyStoredSpeedAggregate,
  type StateStore,
  type StoredCycleAggregate,
  type StoredModelAggregate,
  type StoredSessionState,
  type ServiceTier,
  type ContextClass
} from './state.js'

export interface IndexerProgress {
  state: 'idle' | 'indexing' | 'error'
  indexedFiles: number
  totalFiles: number
  message: string | null
}

interface CandidateFile {
  path: string
  sessionId: string
  size: number
  modifiedAtMs: number
}

export type SessionReadStreamFactory = (
  path: string,
  options: { encoding: 'utf8'; start: number; end: number }
) => NodeJS.ReadableStream

const INDEX_INTERVAL_MS = 15_000

export class SessionIndexer {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private stopped = false
  private progress: IndexerProgress = {
    state: 'idle',
    indexedFiles: 0,
    totalFiles: 0,
    message: null
  }

  constructor(
    private readonly codexHome: string,
    private readonly store: StateStore,
    private readonly scanStartMs: number,
    private readonly onChanged: (progress: IndexerProgress) => void,
    private readonly readStreamFactory: SessionReadStreamFactory = createReadStream
  ) {}

  start(): Promise<void> {
    this.stopped = false
    const initial = this.scan()
    this.timer = setInterval(() => void this.scan(), INDEX_INTERVAL_MS)
    return initial
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) await this.running
  }

  scan(): Promise<void> {
    if (this.running) return this.running
    this.running = this.performScan().finally(() => {
      this.running = null
    })
    return this.running
  }

  getProgress(): IndexerProgress {
    return { ...this.progress }
  }

  getFallbackRateLimit(): RateLimitBucket | null {
    const nowSeconds = Math.floor(Date.now() / 1_000)
    let latest: StoredCycleAggregate | null = null
    for (const session of Object.values(this.store.get().sessions)) {
      for (const cycle of Object.values(session.cycles)) {
        if (cycle.limitId !== 'codex' || cycle.resetsAt <= nowSeconds) continue
        if (!latest || Date.parse(cycle.lastSampleAt) > Date.parse(latest.lastSampleAt)) latest = cycle
      }
    }
    if (!latest) return null
    return {
      limitId: latest.limitId,
      limitName: null,
      primary: {
        usedPercent: Math.max(0, ...latest.usedPercents),
        windowDurationMins: latest.windowDurationMins,
        resetsAt: latest.resetsAt
      },
      secondary: null,
      planType: null,
      rateLimitReachedType: null
    }
  }

  private async performScan(): Promise<void> {
    this.setProgress({ state: 'indexing', indexedFiles: 0, totalFiles: 0, message: null })
    this.store.update((state) => {
      if (state.rebuild.state === 'queued') state.rebuild.state = 'indexing'
    })
    try {
      const files = await this.listCandidateFiles()
      this.progress.totalFiles = files.length
      this.onChanged(this.getProgress())

      const seenSessions = new Set(files.map((file) => file.sessionId))
      this.store.update((state) => {
        for (const [sessionId, session] of Object.entries(state.sessions)) {
          if (seenSessions.has(sessionId)) continue
          session.legacyUnpriced = true
          session.unreconciled = true
          session.missingRaw = true
          if (!state.unreconciledSessions.includes(sessionId)) state.unreconciledSessions.push(sessionId)
        }
        for (const candidate of files) {
          const existing = state.pendingPricingQueue.find((entry) => entry.sessionId === candidate.sessionId && entry.capturedSize === candidate.size && entry.filePath === candidate.path)
          if (existing) continue
          state.pendingPricingQueue.push({
            id: `${candidate.sessionId}:${candidate.size}:${candidate.modifiedAtMs}`,
            sessionId: candidate.sessionId,
            filePath: candidate.path,
            capturedSize: candidate.size,
            capturedOffset: state.sessions[candidate.sessionId]?.offset ?? 0,
            queuedAt: new Date().toISOString(),
            status: 'pending',
            error: null
          })
        }
      })

      let cursor = 0
      const workers = Array.from({ length: Math.min(4, files.length) }, async () => {
        while (!this.stopped) {
          const index = cursor++
          const candidate = files[index]
          if (!candidate) break
          await this.processFile(candidate)
          this.progress.indexedFiles += 1
          if (this.progress.indexedFiles % 10 === 0) this.onChanged(this.getProgress())
        }
      })
      await Promise.all(workers)

      this.store.update((state) => {
        state.localIndexedAt = new Date().toISOString()
        state.pendingPricingQueue = state.pendingPricingQueue.filter((entry) => entry.status !== 'complete')
        state.unreconciledSessions = [...new Set(state.unreconciledSessions.filter((sessionId) => state.sessions[sessionId]?.unreconciled === true))]
        const pending = state.pendingPricingQueue.filter((entry) => entry.status === 'pending' || entry.status === 'processing').length
        const unreconciled = state.unreconciledSessions.length
        if (state.rebuild.state === 'indexing' || state.rebuild.state === 'validating' || state.rebuild.state === 'partial') {
          state.rebuild.state = pending === 0 && unreconciled === 0 ? 'complete' : 'partial'
          state.rebuild.totalFiles = files.length
          state.rebuild.processedFiles = files.length - pending
          state.rebuild.pending = pending
          state.rebuild.message = pending === 0 && unreconciled === 0
            ? null
            : `Rebuild incomplete: ${pending} pending file(s), ${unreconciled} unreconciled session(s).`
        }
      })
      await this.store.save()
      this.setProgress({
        state: 'idle',
        indexedFiles: files.length,
        totalFiles: files.length,
        message: null
      })
    } catch (error) {
      this.setProgress({
        state: 'error',
        indexedFiles: this.progress.indexedFiles,
        totalFiles: this.progress.totalFiles,
        message: error instanceof Error ? error.message : 'Local session indexing failed'
      })
    }
  }

  private async listCandidateFiles(): Promise<CandidateFile[]> {
    const patterns = [
      join(this.codexHome, 'sessions', '**', '*.jsonl').replaceAll('\\', '/'),
      join(this.codexHome, 'archived_sessions', '**', '*.jsonl').replaceAll('\\', '/')
    ]
    const bySession = new Map<string, CandidateFile>()

    for (const pattern of patterns) {
      try {
        for await (const path of glob(pattern)) {
          let details
          try {
            details = await stat(path)
          } catch {
            continue
          }
          const sessionId = sessionIdFromPath(path)
          const existingState = this.store.get().sessions[sessionId]
          if (!existingState && details.mtimeMs < this.scanStartMs) continue
          const candidate = {
            path,
            sessionId,
            size: details.size,
            modifiedAtMs: details.mtimeMs
          }
          const existing = bySession.get(sessionId)
          if (!existing || candidate.modifiedAtMs >= existing.modifiedAtMs) {
            bySession.set(sessionId, candidate)
          }
        }
      } catch {
        // Missing active or archived directories are valid on a new Codex install.
      }
    }

    return [...bySession.values()].sort((left, right) => left.modifiedAtMs - right.modifiedAtMs)
  }

  private async processFile(candidate: CandidateFile): Promise<void> {
    const stored = this.store.get().sessions[candidate.sessionId]
    let sameSizeRewrite = false
    if (stored && !stored.fingerprintBootstrapPending && stored.offset > 0 && (stored.offset < candidate.size || stored.modifiedAtMs !== candidate.modifiedAtMs || stored.fileSize !== candidate.size)) {
      const prefix = await fingerprintFilePrefix(candidate.path, stored.offset)
      if (!stored.prefixFingerprint || prefix !== stored.prefixFingerprint) sameSizeRewrite = true
    }
    if (
      stored &&
      stored.fileSize === candidate.size &&
      stored.offset === candidate.size &&
      !stored.fingerprintBootstrapPending &&
      !(stored.legacyUnpriced && !stored.unreconciled)
    ) {
      const fingerprint = await fingerprintFile(candidate.path)
      if (stored.contentFingerprint && stored.contentFingerprint === fingerprint) {
        this.completeQueueEntry(`${candidate.sessionId}:${candidate.size}:${candidate.modifiedAtMs}`)
        return
      }
      sameSizeRewrite = true
    }

    const backup = stored ? cloneSessionState(stored) : null
    try {
      await this.processFileStage(candidate, sameSizeRewrite)
    } catch (error) {
      if (backup) this.store.get().sessions[candidate.sessionId] = backup
      else delete this.store.get().sessions[candidate.sessionId]
      const queueId = `${candidate.sessionId}:${candidate.size}:${candidate.modifiedAtMs}`
      this.store.update((state) => {
        const entry = state.pendingPricingQueue.find((item) => item.id === queueId)
        if (entry) {
          entry.status = 'pending'
          entry.error = error instanceof Error ? error.message : 'Session read failed'
        }
      })
      throw error
    }
  }

  private async processFileStage(candidate: CandidateFile, sameSizeRewrite: boolean): Promise<void> {
    const stored = this.store.get().sessions[candidate.sessionId]

    let session = stored && stored.legacyUnpriced && stored.missingRaw
      ? createSessionState(candidate)
      : stored ? cloneSessionState(stored) : createSessionState(candidate)
    const queueId = `${candidate.sessionId}:${candidate.size}:${candidate.modifiedAtMs}`
    this.store.update((state) => {
      const existing = state.pendingPricingQueue.find((entry) => entry.id === queueId)
      if (existing) existing.status = 'processing'
      else state.pendingPricingQueue.push({
        id: queueId,
        sessionId: candidate.sessionId,
        filePath: candidate.path,
        capturedSize: candidate.size,
        capturedOffset: session.offset,
        queuedAt: new Date().toISOString(),
        status: 'processing',
        error: null
      })
    })
    if (session.fingerprintBootstrapPending) {
      const bootstrapped = await bootstrapSessionMetadata(candidate.path, session)
      if (!bootstrapped) {
        session.legacyUnpriced = true
        session.unreconciled = true
        session.missingRaw = false
        this.store.get().sessions[candidate.sessionId] = session
        this.store.update((state) => {
          if (!state.unreconciledSessions.includes(candidate.sessionId)) state.unreconciledSessions.push(candidate.sessionId)
        })
        this.completeQueueEntry(queueId)
        return
      }
      session = bootstrapped
    }
    if (candidate.size < session.offset || sameSizeRewrite) {
      const recovered = await recoverRewrittenSession(candidate.path, session)
      if (recovered.kind === 'unique') {
        session = {
          ...session,
          path: candidate.path,
          offset: recovered.offset,
          fileSize: 0,
          modifiedAtMs: 0,
          legacyUnpriced: false,
          unreconciled: false,
          missingRaw: false
        }
      } else {
        session.path = candidate.path
        session.offset = candidate.size
        session.fileSize = candidate.size
        session.modifiedAtMs = candidate.modifiedAtMs
        session.lastCumulative = recovered.lastCumulative
        session.legacyUnpriced = true
        session.unreconciled = true
        session.missingRaw = false
        session.prefixFingerprint = await fingerprintFilePrefix(candidate.path, candidate.size)
        session.contentFingerprint = await fingerprintFile(candidate.path)
        this.store.get().sessions[candidate.sessionId] = session
        this.store.update((state) => {
          if (!state.unreconciledSessions.includes(candidate.sessionId)) state.unreconciledSessions.push(candidate.sessionId)
        })
        this.completeQueueEntry(queueId)
        return
      }
    }
    session.path = candidate.path

    const completeEnd = await findLastCompleteLineEnd(candidate.path, session.offset, candidate.size)
    if (completeEnd <= session.offset) {
      session.fileSize = candidate.size
      session.modifiedAtMs = candidate.modifiedAtMs
      session.prefixFingerprint = await fingerprintFilePrefix(candidate.path, session.offset)
      session.contentFingerprint = await fingerprintFile(candidate.path)
      if (!session.unreconciled) {
        session.legacyUnpriced = false
        session.missingRaw = false
        this.store.update((state) => {
          state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
        })
      }
      this.store.get().sessions[candidate.sessionId] = session
      this.completeQueueEntry(queueId)
      return
    }

    const stream = this.readStreamFactory(candidate.path, {
      encoding: 'utf8',
      start: session.offset,
      end: completeEnd - 1
    })
    const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
    for await (const line of reader) this.processLine(session, line)

    session.offset = completeEnd
    session.fileSize = candidate.size
    session.modifiedAtMs = candidate.modifiedAtMs
    session.prefixFingerprint = await fingerprintFilePrefix(candidate.path, completeEnd)
    session.contentFingerprint = await fingerprintFile(candidate.path)
    if (session.lastCumulative && session.lastEventModel && session.lastEventServiceTier && session.prefixFingerprint) {
      session.recoveryAnchor = {
        cumulative: session.lastCumulative,
        offset: completeEnd,
        prefixFingerprint: session.prefixFingerprint,
        model: session.lastEventModel,
        serviceTier: session.lastEventServiceTier
      }
    }
    if (!session.unreconciled) {
      session.legacyUnpriced = false
      session.missingRaw = false
      this.store.update((state) => {
        state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
      })
    }
    this.store.get().sessions[candidate.sessionId] = session
    this.completeQueueEntry(queueId)
  }

  private completeQueueEntry(queueId: string): void {
    const entry = this.store.get().pendingPricingQueue.find((candidate) => candidate.id === queueId)
    if (entry) entry.status = 'complete'
  }

  private processLine(session: StoredSessionState, line: string): void {
    let row: unknown
    try {
      row = JSON.parse(line)
    } catch {
      session.parseErrors += 1
      return
    }
    if (!isRecord(row) || !isRecord(row.payload)) return

    const payload = row.payload
    const rowType = typeof row.type === 'string' ? row.type : ''
    const payloadType = typeof payload.type === 'string' ? payload.type : ''
    const isTurnContext = rowType === 'turn_context'
    const isSettings = payloadType === 'thread_settings_applied' || rowType === 'thread_settings_applied'
    const isTokenCount = payloadType === 'token_count'

    if (isTurnContext) {
      if (typeof payload.model === 'string') session.currentModel = payload.model
      return
    }

    if (isSettings) {
      const tier = extractServiceTier(payload)
      if (tier) session.currentServiceTier = tier
      return
    }

    if (!isTokenCount || !isRecord(payload.info)) return
    const info = payload.info
    const totalUsage = fromUnknownTokenUsage(info.total_token_usage)
    if (!totalUsage) return
    const previous = session.lastCumulative
      ? deserializeTokens(session.lastCumulative)
      : null
    const delta = subtractCumulativeTokens(totalUsage, previous)
    session.lastCumulative = serializeTokens(totalUsage)

    const timestampMs = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isFinite(timestampMs)) {
      session.parseErrors += 1
      return
    }

    const model = extractEventModel(payload, info) ?? (session.currentModel || 'unknown')
    const eventTier = extractServiceTier(payload) ?? session.currentServiceTier ?? 'unknown'
    const eventAt = new Date(timestampMs).toISOString()
    const effectivePricing = resolveEffectiveModelPricing(
      this.store.get().priceBook,
      model,
      eventAt,
      this.store.get().pricingLedger
    )
    const lastUsage = fromUnknownTokenUsage(info.last_token_usage)
    const contextInput = lastUsage?.input ?? delta.input
    const contextClass: ContextClass = effectivePricing.longContextThreshold === null
      ? 'unknown'
      : contextInput > effectivePricing.longContextThreshold
        ? 'long'
        : 'short'
    session.lastEventModel = model
    session.lastEventServiceTier = eventTier
    if (delta.total <= 0n) return
    const day = hongKongDateKey(timestampMs)
    const daily = (session.daily[day] ??= { models: {} })
    const dailyModel = (daily.models[model] ??= createEmptyStoredModelAggregate())
    addToStoredModel(dailyModel, contextClass, eventTier, delta, eventAt)

    const rateLimits = isRecord(payload.rate_limits) ? payload.rate_limits : null
    const limitId = typeof rateLimits?.limit_id === 'string' ? rateLimits.limit_id : null
    const primary = isRecord(rateLimits?.primary) ? rateLimits.primary : null
    const usedPercent = finiteNumber(primary?.used_percent)
    const windowDurationMins = finiteNumber(primary?.window_minutes)
    const resetsAt = finiteNumber(primary?.resets_at)

    if (limitId && usedPercent !== null && windowDurationMins !== null && resetsAt !== null) {
      const cycleKey = `${limitId}:${Math.trunc(resetsAt)}`
      const cycle = (session.cycles[cycleKey] ??= {
        limitId,
        resetsAt: Math.trunc(resetsAt),
        windowDurationMins,
        models: {},
        usedPercents: [],
        firstSampleAt: new Date(timestampMs).toISOString(),
        lastSampleAt: new Date(timestampMs).toISOString()
      })
      cycle.lastSampleAt = new Date(timestampMs).toISOString()
      if (!cycle.usedPercents.includes(usedPercent)) {
        cycle.usedPercents.push(usedPercent)
        cycle.usedPercents.sort((left, right) => left - right)
      }
      const cycleModel = (cycle.models[model] ??= createEmptyStoredModelAggregate())
      addToStoredModel(cycleModel, contextClass, eventTier, delta, eventAt)
    }

    if (delta.total > 0n) session.eventCount += 1
  }

  private setProgress(progress: IndexerProgress): void {
    this.progress = progress
    this.onChanged(this.getProgress())
  }
}

function createSessionState(candidate: CandidateFile): StoredSessionState {
  return {
    sessionId: candidate.sessionId,
    path: candidate.path,
    offset: 0,
    fileSize: 0,
    modifiedAtMs: 0,
    currentModel: 'unknown',
    currentServiceTier: 'unknown',
    lastCumulative: null,
    daily: {},
    cycles: {},
    eventCount: 0,
    parseErrors: 0
  }
}

function cloneSessionState(session: StoredSessionState): StoredSessionState {
  return JSON.parse(JSON.stringify(session)) as StoredSessionState
}

async function fingerprintFile(path: string): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

async function fingerprintFilePrefix(path: string, offset: number): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content.subarray(0, Math.min(offset, content.byteLength))).digest('hex')
}

function addToStoredModel(
  aggregate: StoredModelAggregate,
  contextClass: ContextClass,
  serviceTier: ServiceTier,
  delta: BigTokenBreakdown,
  eventAt: string
): void {
  const current = deserializeTokens(aggregate[contextClass] ?? serializeTokens(zeroTokens()))
  aggregate[contextClass] = serializeTokens(addTokens(current, delta))
  aggregate.firstEventAt = aggregate.firstEventAt && aggregate.firstEventAt < eventAt ? aggregate.firstEventAt : eventAt
  aggregate.lastEventAt = aggregate.lastEventAt && aggregate.lastEventAt > eventAt ? aggregate.lastEventAt : eventAt
  const bySpeed = (aggregate.bySpeed ??= {})
  const speed = (bySpeed[serviceTier] ??= createEmptyStoredSpeedAggregate())
  const speedCurrent = deserializeTokens(speed[contextClass] ?? serializeTokens(zeroTokens()))
  speed[contextClass] = serializeTokens(addTokens(speedCurrent, delta))
  speed.eventCount += 1
  speed.firstEventAt = speed.firstEventAt && speed.firstEventAt < eventAt ? speed.firstEventAt : eventAt
  speed.lastEventAt = speed.lastEventAt && speed.lastEventAt > eventAt ? speed.lastEventAt : eventAt
  if (delta.total > 0n) aggregate.eventCount += 1
}

function extractServiceTier(value: Record<string, unknown>): ServiceTier | null {
  const candidates: unknown[] = [
    value.service_tier,
    value.serviceTier,
    isRecord(value.settings) ? value.settings.service_tier : undefined,
    isRecord(value.settings) ? value.settings.serviceTier : undefined,
    isRecord(value.info) ? value.info.service_tier : undefined
  ]
  const present = candidates.find((candidate) => candidate !== undefined)
  if (present === undefined) return null
  if (typeof present !== 'string') return 'unknown'
  const normalized = present.trim().toLowerCase()
  if (normalized === 'default' || normalized === 'standard') return 'standard'
  if (normalized === 'priority' || normalized === 'fast') return 'fast'
  return 'unknown'
}

function extractEventModel(payload: Record<string, unknown>, info: Record<string, unknown>): string | null {
  for (const value of [payload.model, payload.model_name, info.model, info.model_name]) {
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

async function bootstrapSessionMetadata(path: string, session: StoredSessionState): Promise<StoredSessionState | null> {
  let bytes: Buffer
  try {
    bytes = await readFile(path)
  } catch {
    return null
  }
  if (bytes.byteLength < session.offset) return null
  const prefix = bytes.subarray(0, session.offset)
  let currentModel = 'unknown'
  let currentServiceTier: ServiceTier = 'unknown'
  let lastEventModel: string | undefined
  let lastEventServiceTier: ServiceTier | undefined
  let latestCumulative: TokenBreakdown | null = null
  for (const line of prefix.toString('utf8').split(/\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as unknown
      if (!isRecord(row) || !isRecord(row.payload)) continue
      const payload = row.payload
      if (row.type === 'turn_context' && typeof payload.model === 'string') currentModel = payload.model
      if (payload.type === 'thread_settings_applied' || row.type === 'thread_settings_applied') currentServiceTier = extractServiceTier(payload) ?? currentServiceTier
      if (payload.type !== 'token_count' || !isRecord(payload.info)) continue
      const usage = fromUnknownTokenUsage(payload.info.total_token_usage)
      if (!usage) continue
      latestCumulative = serializeTokens(usage)
      lastEventModel = extractEventModel(payload, payload.info) ?? currentModel
      lastEventServiceTier = extractServiceTier(payload) ?? currentServiceTier
    } catch {
      return null
    }
  }
  if (session.lastCumulative && latestCumulative && JSON.stringify(session.lastCumulative) !== JSON.stringify(latestCumulative)) return null
  if (session.lastCumulative && !latestCumulative) return null
  if (latestCumulative && lastEventModel && lastEventServiceTier) {
    const persistedModel = session.currentModel || 'unknown'
    const persistedServiceTier = session.currentServiceTier ?? 'unknown'
    if (lastEventModel !== persistedModel || lastEventServiceTier !== persistedServiceTier) return null
  }
  const cumulative = session.lastCumulative ?? latestCumulative
  const prefixFingerprint = createHash('sha256').update(prefix).digest('hex')
  return {
    ...session,
    fingerprintBootstrapPending: false,
    prefixFingerprint,
    ...(cumulative && lastEventModel && lastEventServiceTier
      ? {
          recoveryAnchor: {
            cumulative,
            offset: session.offset,
            prefixFingerprint,
            model: lastEventModel,
            serviceTier: lastEventServiceTier
          },
          lastEventModel,
          lastEventServiceTier
        }
      : {})
  }
}

async function recoverRewrittenSession(
  path: string,
  session: StoredSessionState
): Promise<{ kind: 'unique'; offset: number } | { kind: 'ambiguous'; lastCumulative: TokenBreakdown | null }> {
  if (!session.lastCumulative || !session.recoveryAnchor) return { kind: 'ambiguous', lastCumulative: null }
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch {
    return { kind: 'ambiguous', lastCumulative: null }
  }
  const target = session.lastCumulative
  const lines = content.split(/\n/)
  let offset = 0
  let cumulativeMatches = 0
  const validMatches: number[] = []
  let lastCumulative: TokenBreakdown | null = null
  let currentModel = 'unknown'
  let currentServiceTier: ServiceTier = 'unknown'
  for (const line of lines) {
    const end = offset + Buffer.byteLength(line, 'utf8') + 1
    try {
      const row = JSON.parse(line) as unknown
      if (!isRecord(row) || !isRecord(row.payload)) {
        offset = end
        continue
      }
      const payload = row.payload
      if (row.type === 'turn_context' && typeof payload.model === 'string') currentModel = payload.model
      if (payload.type === 'thread_settings_applied' || row.type === 'thread_settings_applied') {
        currentServiceTier = extractServiceTier(payload) ?? currentServiceTier
      }
      if (payload.type === 'token_count' && isRecord(payload.info)) {
        const usage = fromUnknownTokenUsage(payload.info.total_token_usage)
        if (usage) {
          lastCumulative = serializeTokens(usage)
          if (JSON.stringify(serializeTokens(usage)) === JSON.stringify(target)) {
            cumulativeMatches += 1
            const info = payload.info
            const eventModel = extractEventModel(payload, info) ?? currentModel
            const eventTier = extractServiceTier(payload) ?? currentServiceTier
            const prefixFingerprint = createHash('sha256').update(Buffer.from(content, 'utf8').subarray(0, end)).digest('hex')
            if (
              JSON.stringify(session.recoveryAnchor.cumulative) === JSON.stringify(target) &&
              session.recoveryAnchor.prefixFingerprint === prefixFingerprint &&
              session.recoveryAnchor.model === eventModel &&
              session.recoveryAnchor.serviceTier === eventTier
            ) validMatches.push(end)
          }
        }
      }
    } catch {
      // Ignore partial/malformed rewrite lines; the normal parser will count them later.
    }
    offset = end
  }
  return cumulativeMatches === 1 && validMatches.length === 1
    ? { kind: 'unique', offset: validMatches[0]! }
    : { kind: 'ambiguous', lastCumulative }
}

async function findLastCompleteLineEnd(
  path: string,
  startOffset: number,
  fileSize: number
): Promise<number> {
  if (fileSize <= startOffset) return startOffset
  const handle = await open(path, 'r')
  try {
    let cursor = fileSize
    const chunkSize = 64 * 1_024
    while (cursor > startOffset) {
      const readStart = Math.max(startOffset, cursor - chunkSize)
      const buffer = Buffer.allocUnsafe(cursor - readStart)
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, readStart)
      const index = buffer.subarray(0, bytesRead).lastIndexOf(0x0a)
      if (index >= 0) return readStart + index + 1
      cursor = readStart
    }
    return startOffset
  } finally {
    await handle.close()
  }
}

function sessionIdFromPath(path: string): string {
  const name = basename(path)
  const match = name.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/iu)
  return match?.[1] ?? name.replace(/\.jsonl$/iu, '')
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export const sessionIndexerConstants = {
  INDEX_INTERVAL_MS
}

export const sessionIndexerInternals = {
  classifyServiceTier: extractServiceTier,
  extractEventModel,
  recoverRewrittenSession
}
