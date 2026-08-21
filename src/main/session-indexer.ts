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
  type StoredDailyAggregate,
  type StoredModelAggregate,
  type StoredSpeedAggregate,
  type StoredSessionState,
  type ServiceTier,
  type ContextClass,
  type PersistentState,
  STATE_INDEX_REVISION,
  ATTRIBUTION_REVISION
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
type ScanTrigger = 'initial' | 'periodic' | 'manual' | 'pricing' | 'follow-up'

export class SessionIndexer {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private rerunRequested = false
  private stopped = false
  /** Full revision replay is built off to the side and cut over once. */
  private workingState: PersistentState | null = null
  private replayBaseline: PersistentState | null = null
  private readonly replayFailures = new Set<string>()
  private readonly replayedSessionIds = new Set<string>()
  private readonly retainedSessionIds = new Set<string>()
  private readonly replayReplacementBaselines = new Map<string, StoredSessionState>()
  private readonly failedReplaySessionIds = new Set<string>()
  private fullReplayActive = false
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
    const initial = this.scan('initial')
    this.timer = setInterval(() => void this.scan('periodic'), INDEX_INTERVAL_MS)
    return initial
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    if (this.running) await this.running
  }

  scan(trigger: ScanTrigger = 'manual'): Promise<void> {
    if (this.running) {
      // A periodic tick is only an observation; it must not turn a busy scan
      // into an unbounded chain of follow-up work. Manual/pricing requests
      // coalesce into at most one convergence pass.
      if (trigger !== 'periodic') this.rerunRequested = true
      return this.running
    }
    const run = this.performScan(trigger)
    this.running = run.finally(() => {
      if (this.rerunRequested && !this.stopped) {
        this.rerunRequested = false
        this.running = null
        return this.scan('follow-up')
      }
      this.rerunRequested = false
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
      for (const cycle of Object.values({ ...session.legacyCycles, ...session.cycles })) {
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

  private currentState(): PersistentState {
    return this.workingState ?? this.store.get()
  }

  private updateState(mutator: (state: PersistentState) => void): void {
    if (this.workingState) mutator(this.workingState)
    else this.store.update(mutator)
  }

  private async commitWorkingProjection(): Promise<void> {
    const working = this.workingState
    if (!working) return
    // Copy only projection/rebuild fields. Settings, account, rate limits,
    // and the current pricing ledger may have changed while raw files were
    // being read and must remain live at the cutover.
    const projection = {
      sessions: working.sessions,
      pendingPricingQueue: working.pendingPricingQueue,
      unreconciledSessions: working.unreconciledSessions,
      rebuild: working.rebuild,
      localIndexedAt: working.localIndexedAt,
      indexRevision: working.indexRevision,
      attributionRevision: working.attributionRevision
    }
    this.workingState = null
    await this.store.replaceStateAtomically((state) => {
      state.sessions = projection.sessions
      state.pendingPricingQueue = projection.pendingPricingQueue
      state.unreconciledSessions = projection.unreconciledSessions
      state.rebuild = projection.rebuild
      state.localIndexedAt = projection.localIndexedAt
      state.indexRevision = projection.indexRevision
      state.attributionRevision = projection.attributionRevision
    })
  }

  private recordReplayFailure(code: 'raw-missing' | 'raw-invalid' | 'raw-unstable' | 'raw-read-failed'): void {
    this.replayFailures.add(code)
  }

  private async performScan(trigger: ScanTrigger): Promise<void> {
    this.setProgress({ state: 'indexing', indexedFiles: 0, totalFiles: 0, message: null })
    const liveState = this.store.get()
    const fullReplay = liveState.indexRevision < STATE_INDEX_REVISION || liveState.attributionRevision < ATTRIBUTION_REVISION
    this.workingState = fullReplay ? clonePersistentState(liveState) : null
    this.replayBaseline = fullReplay ? clonePersistentState(liveState) : null
    this.fullReplayActive = fullReplay
    this.replayFailures.clear()
    this.replayedSessionIds.clear()
    this.retainedSessionIds.clear()
    this.replayReplacementBaselines.clear()
    this.failedReplaySessionIds.clear()
    this.updateState((state) => {
      if (state.rebuild.state === 'queued') state.rebuild.state = 'indexing'
      if (fullReplay) {
        state.rebuild.mode = 'background-replay'
        state.rebuild.replayedSessions = 0
        state.rebuild.retainedLegacySessions = 0
        state.rebuild.rawTokenDelta = '0'
        state.rebuild.failureDiagnostics = []
      } else {
        state.rebuild.mode = 'incremental'
      }
    })
    try {
      const files = await this.listCandidateFiles()
      this.progress.totalFiles = files.length
      this.onChanged(this.getProgress())

      const seenSessions = new Set(files.map((file) => file.sessionId))
      let actionableFiles: CandidateFile[] = []
      this.updateState((state) => {
        // Processing is an in-memory lease. A restart turns it back into a
        // retryable pending item; stale mtimes are superseded below.
        for (const entry of state.pendingPricingQueue) {
          if (entry.status === 'processing') entry.status = 'pending'
        }
        for (const [sessionId, session] of Object.entries(state.sessions)) {
          if (seenSessions.has(sessionId)) continue
          for (const entry of state.pendingPricingQueue) {
            if (entry.sessionId === sessionId && (entry.status === 'pending' || entry.status === 'processing')) {
              entry.status = 'aborted'
              entry.error = 'Raw session file unavailable.'
            }
          }
          session.legacyUnpriced = true
          session.unreconciled = true
          session.missingRaw = true
          if (fullReplay) {
            this.recordReplayFailure('raw-missing')
            this.retainedSessionIds.add(sessionId)
            session.fullRawReplayPending = true
          }
          if (!state.unreconciledSessions.includes(sessionId)) state.unreconciledSessions.push(sessionId)
        }
        actionableFiles = files.filter((candidate) => isActionableCandidate(state, candidate, trigger))
        for (const candidate of actionableFiles) enqueueQueueEntry(state, candidate)
      })

      let cursor = 0
      let firstWorkerError: unknown = null
      const workers = Array.from({ length: Math.min(4, actionableFiles.length) }, async () => {
        try {
          while (!this.stopped) {
            if (firstWorkerError) break
            const index = cursor++
            const candidate = actionableFiles[index]
            if (!candidate) break
            try {
              await this.processFile(candidate)
            } catch (error) {
              // Stop assigning new candidates on the first failure, but let
              // all workers already inside processFile settle before the
              // outer error path runs. Full replay keeps its detached state;
              // incremental mode preserves its live backup/retry semantics.
              firstWorkerError ??= error
              break
            }
            this.progress.indexedFiles += 1
            if (this.progress.indexedFiles % 10 === 0) this.onChanged(this.getProgress())
          }
        } catch (error) {
          firstWorkerError ??= error
        }
      })
      await Promise.all(workers)
      if (firstWorkerError) throw firstWorkerError

      this.updateState((state) => {
        state.localIndexedAt = new Date().toISOString()
        // Terminal queue records are audit noise, not actionable work. Drop
        // both completed and superseded entries after each convergence pass.
        state.pendingPricingQueue = state.pendingPricingQueue.filter((entry) => entry.status !== 'complete' && entry.status !== 'aborted')
        state.unreconciledSessions = Object.entries(state.sessions)
          .filter(([, session]) => session.unreconciled === true)
          .map(([sessionId]) => sessionId)
        const pending = state.pendingPricingQueue.filter((entry) => entry.status === 'pending' || entry.status === 'processing').length
        const unreconciled = state.unreconciledSessions.length
        const complete = pending === 0 && unreconciled === 0
        state.rebuild.state = complete ? 'complete' : 'partial'
        state.rebuild.totalFiles = files.length
        state.rebuild.processedFiles = Math.max(0, actionableFiles.length - pending)
        state.rebuild.pending = pending
        state.rebuild.message = complete
          ? null
          : `Rebuild incomplete: ${pending} pending file(s), ${unreconciled} unreconciled session(s).`
        // The projection revision is a durable migration marker, not a
        // promise that every raw file exists. Mark it after one convergence
        // pass so a permanently missing raw file does not enqueue the same
        // full rebuild on every restart. Pending queue entries and the
        // partial rebuild status still make retryable work visible.
        state.indexRevision = STATE_INDEX_REVISION
        state.attributionRevision = ATTRIBUTION_REVISION
        if (fullReplay) applyReplayProvenance(state, this.replayBaseline, this.replayFailures, this.replayedSessionIds, this.retainedSessionIds, this.replayReplacementBaselines)
        else if (this.replayedSessionIds.size > 0 || this.retainedSessionIds.size > 0) applyReplayProvenance(state, null, this.replayFailures, this.replayedSessionIds, this.retainedSessionIds, this.replayReplacementBaselines)
        else if (this.replayFailures.size > 0) state.rebuild.failureDiagnostics = [...this.replayFailures].sort()
      })
      if (fullReplay) await this.commitWorkingProjection()
      this.replayBaseline = null
      this.fullReplayActive = false
      await this.store.save()
      this.setProgress({
        state: 'idle',
        indexedFiles: actionableFiles.length,
        totalFiles: files.length,
        message: null
      })
    } catch (error) {
      const hadWorkingState = this.workingState !== null
      this.workingState = null
      this.replayBaseline = null
      this.fullReplayActive = false
      this.store.update((state) => {
        for (const sessionId of this.failedReplaySessionIds) {
          const session = state.sessions[sessionId]
          if (!session) continue
          session.fullRawReplayPending = true
          session.legacyUnpriced = true
          session.unreconciled = true
          session.missingRaw = false
          this.retainedSessionIds.add(sessionId)
        }
        state.pendingPricingQueue = state.pendingPricingQueue.filter((entry) => entry.status !== 'complete' && entry.status !== 'aborted')
        state.unreconciledSessions = [...new Set([
          ...state.unreconciledSessions,
          ...Object.entries(state.sessions).filter(([, session]) => session.unreconciled === true).map(([sessionId]) => sessionId)
        ])]
        const pending = state.pendingPricingQueue.filter((entry) => entry.status === 'pending' || entry.status === 'processing').length
        const unresolved = state.unreconciledSessions.length
        state.rebuild.state = 'partial'
        state.rebuild.totalFiles = this.progress.totalFiles
        state.rebuild.processedFiles = Math.max(0, this.progress.indexedFiles - pending)
        state.rebuild.pending = pending
        state.rebuild.message = `Rebuild incomplete: ${pending} pending file(s), ${unresolved} unreconciled session(s).`
        if (hadWorkingState) {
          state.rebuild.mode = 'background-replay'
          state.rebuild.failureDiagnostics = ['raw-read-failed']
          state.rebuild.replayedSessions = 0
          state.rebuild.retainedLegacySessions = this.retainedSessionIds.size
          state.rebuild.rawTokenDelta = '0'
        }
      })
      await this.store.save()
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
          const existingState = this.currentState().sessions[sessionId]
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
    const state = this.currentState()
    const stored = state.sessions[candidate.sessionId]
    const replayForRevision = state.indexRevision < STATE_INDEX_REVISION || state.attributionRevision < ATTRIBUTION_REVISION
    const replayForPricing = shouldReplayForPricing(stored, state.priceBook.payloadSha256 ?? null)
    const hasReplayFloor = Boolean(stored && (stored.baselineOffset !== undefined || ((stored.legacyDaily || stored.legacyCycles) && stored.legacyUnpriced === false)))
    const pathChanged = Boolean(stored && stored.path !== candidate.path)
    const replayFromIntent = stored?.fullRawReplayPending === true
    // A revision migration is a full raw-authority cutover, even when an
    // older ambiguous-rewrite floor was persisted. Pricing-only replays keep
    // the immutable legacy floor and classify future appends from it.
    const replayFromFloor = Boolean(hasReplayFloor && !pathChanged && !replayForRevision && !replayFromIntent && (replayForPricing || stored?.missingRaw))
    const forceReplay = replayFromIntent || replayFromFloor || replayForRevision || replayForPricing || pathChanged || Boolean(stored?.missingRaw && stored.legacyUnpriced)
    let sameSizeRewrite = false
    if (!forceReplay && stored && !stored.fingerprintBootstrapPending && stored.offset > 0 && (stored.offset < candidate.size || stored.modifiedAtMs !== candidate.modifiedAtMs || stored.fileSize !== candidate.size)) {
      const prefix = await fingerprintFilePrefix(candidate.path, stored.offset)
      if (!stored.prefixFingerprint || prefix !== stored.prefixFingerprint) sameSizeRewrite = true
    }
    if (
      !forceReplay &&
      stored &&
      stored.fileSize === candidate.size &&
      stored.offset === candidate.size &&
      !stored.fingerprintBootstrapPending &&
      !(stored.legacyUnpriced && !stored.unreconciled)
    ) {
      const fingerprint = await fingerprintFile(candidate.path)
      if (stored.contentFingerprint && stored.contentFingerprint === fingerprint) {
        stored.pricingSemanticHash = state.priceBook.payloadSha256 ?? stored.pricingSemanticHash ?? null
        stored.pricingIndexRevision = STATE_INDEX_REVISION
        this.completeQueueEntry(queueIdentity(candidate))
        return
      }
      sameSizeRewrite = true
    }

    const backup = stored ? cloneSessionState(stored) : null
    try {
      await this.processFileStage(candidate, sameSizeRewrite, forceReplay, replayFromFloor)
    } catch (error) {
      if (this.fullReplayActive) {
        this.failedReplaySessionIds.add(candidate.sessionId)
        this.recordReplayFailure('raw-read-failed')
      }
      if (backup) this.currentState().sessions[candidate.sessionId] = backup
      else delete this.currentState().sessions[candidate.sessionId]
      const queueId = queueIdentity(candidate)
      this.updateState((state) => {
        const entry = state.pendingPricingQueue.find((item) => item.id === queueId)
        if (entry) {
          entry.status = 'pending'
          entry.error = error instanceof Error ? error.message : 'Session read failed'
        }
      })
      throw error
    }
  }

  private async processFileStage(candidate: CandidateFile, sameSizeRewrite: boolean, forceReplay: boolean, replayFromFloor: boolean): Promise<void> {
    const stored = this.currentState().sessions[candidate.sessionId]

    const replayFromRaw = forceReplay && !replayFromFloor
    const replayFuture = replayFromFloor && Boolean(stored)
    const replayFromIntent = stored?.fullRawReplayPending === true
    if (replayFromRaw && replayFromIntent && stored && !this.replayReplacementBaselines.has(candidate.sessionId)) {
      this.replayReplacementBaselines.set(candidate.sessionId, cloneSessionState(stored))
    }
    let session: StoredSessionState
    if (replayFuture) session = createFutureReplaySession(candidate, stored!)
    else if (replayFromRaw) session = createSessionState(candidate)
    else session = stored ? cloneSessionState(stored) : createSessionState(candidate)
    const queueId = queueIdentity(candidate)
    this.updateState((state) => {
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
    if (!replayFromRaw && stored && hasPersistedReplayFloor(stored) && !(await verifyBaselinePrefix(candidate.path, stored))) {
      const rebaselined = await rebaselineSession(candidate, stored, this.currentState().priceBook.payloadSha256 ?? null)
      this.currentState().sessions[candidate.sessionId] = rebaselined
      this.updateState((state) => {
        if (rebaselined.unreconciled) {
          if (!state.unreconciledSessions.includes(candidate.sessionId)) state.unreconciledSessions.push(candidate.sessionId)
        } else {
          state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
        }
      })
      this.completeQueueEntry(queueId)
      return
    }
    if (!replayFromRaw && !replayFuture && session.fingerprintBootstrapPending) {
      const bootstrapped = await bootstrapSessionMetadata(candidate.path, session)
      if (!bootstrapped) {
        const captured = await captureTailBaseline(candidate)
        const baseline = captured.baseline
        if (baseline) {
          stashCurrentAggregates(session)
          session.offset = captured.offset
          session.fileSize = candidate.size
          session.modifiedAtMs = candidate.modifiedAtMs
          session.lastCumulative = baseline.cumulative
          session.currentModel = baseline.model
          session.lastEventModel = baseline.model
          session.currentServiceTier = baseline.serviceTier
          session.lastEventServiceTier = baseline.serviceTier
          session.prefixFingerprint = captured.prefixFingerprint
          session.contentFingerprint = captured.contentFingerprint
          session.fingerprintBootstrapPending = false
          session.legacyUnpriced = false
          session.unreconciled = false
          session.missingRaw = false
          session.baselineOffset = captured.offset
          session.baselinePrefixFingerprint = captured.prefixFingerprint
          session.baselineCumulative = baseline.cumulative
          session.baselineModel = baseline.model
          session.baselineServiceTier = baseline.serviceTier
          session.pricingSemanticHash = this.currentState().priceBook.payloadSha256 ?? null
          session.pricingIndexRevision = STATE_INDEX_REVISION
          this.currentState().sessions[candidate.sessionId] = session
          this.updateState((state) => {
            state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
          })
        } else {
          // Keep the aggregate in a dedicated fallback slice and leave the
          // session actionable for a later complete raw read. This prevents
          // a transient read failure from tainting future appends forever.
          stashCurrentAggregates(session)
          session.legacyUnpriced = true
          session.unreconciled = true
          session.missingRaw = true
          session.pricingSemanticHash = null
          session.pricingIndexRevision = 0
          this.currentState().sessions[candidate.sessionId] = session
          this.updateState((state) => {
            if (!state.unreconciledSessions.includes(candidate.sessionId)) state.unreconciledSessions.push(candidate.sessionId)
          })
        }
        this.completeQueueEntry(queueId)
        return
      }
      session = bootstrapped
    }
    if (!replayFromRaw && !replayFuture && (candidate.size < session.offset || sameSizeRewrite)) {
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
        const captured = await captureTailBaseline(candidate)
        session.offset = captured.offset
        session.fileSize = candidate.size
        session.modifiedAtMs = candidate.modifiedAtMs
        const rewriteBaseline = captured.baseline
        session.lastCumulative = rewriteBaseline?.cumulative ?? recovered.lastCumulative
        stashCurrentAggregates(session)
        session.legacyUnpriced = false
        // Ambiguous rewrites are resolved by the documented fallback policy:
        // retain the old aggregate, baseline at the current tail, and price
        // only future appends.
        session.unreconciled = false
        session.missingRaw = false
        session.baselineOffset = captured.offset
        session.baselinePrefixFingerprint = captured.prefixFingerprint
        session.baselineCumulative = rewriteBaseline?.cumulative ?? recovered.lastCumulative ?? undefined
        session.baselineModel = rewriteBaseline?.model ?? session.lastEventModel ?? session.currentModel
        session.baselineServiceTier = rewriteBaseline?.serviceTier ?? session.lastEventServiceTier ?? session.currentServiceTier
        session.prefixFingerprint = captured.prefixFingerprint
        session.contentFingerprint = captured.contentFingerprint
        this.currentState().sessions[candidate.sessionId] = session
        this.updateState((state) => {
          state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
        })
        this.completeQueueEntry(queueId)
        return
      }
    }
    session.path = candidate.path

    const completeEnd = await findLastCompleteLineEnd(candidate.path, session.offset, candidate.size)
    if (completeEnd <= session.offset) {
      if (replayFromRaw && completeEnd <= 0) {
        const fallback = preserveLegacyFallback(candidate, stored ?? session)
        this.recordReplayFailure(candidate.size === 0 ? 'raw-invalid' : 'raw-read-failed')
        this.retainLegacyProjection(candidate, fallback)
        this.completeQueueEntry(queueId)
        return
      }
      session.fileSize = candidate.size
      session.modifiedAtMs = candidate.modifiedAtMs
      session.prefixFingerprint = await fingerprintFilePrefix(candidate.path, session.offset)
      session.contentFingerprint = await fingerprintFile(candidate.path)
      if (!session.unreconciled) {
        session.legacyUnpriced = false
        session.missingRaw = false
        this.updateState((state) => {
          state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
        })
      }
      session.pricingSemanticHash = this.currentState().priceBook.payloadSha256 ?? null
      session.pricingIndexRevision = STATE_INDEX_REVISION
      this.currentState().sessions[candidate.sessionId] = session
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
    if (replayFromRaw && !(await isStableCandidate(candidate))) {
      const fallback = preserveLegacyFallback(candidate, stored ?? session)
      this.recordReplayFailure('raw-unstable')
      this.retainLegacyProjection(candidate, fallback)
      this.completeQueueEntry(queueId)
      return
    }
    if (replayFromRaw && !session.lastCumulative) {
      const fallback = preserveLegacyFallback(candidate, stored ?? session)
      this.recordReplayFailure('raw-invalid')
      this.retainLegacyProjection(candidate, fallback)
      this.completeQueueEntry(queueId)
      return
    }
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
      this.updateState((state) => {
        state.unreconciledSessions = state.unreconciledSessions.filter((sessionId) => sessionId !== candidate.sessionId)
      })
    }
    if (replayFromRaw) {
      delete session.legacyDaily
      delete session.legacyCycles
      delete session.legacyEventCount
      delete session.baselineOffset
      delete session.baselinePrefixFingerprint
      delete session.baselineCumulative
      delete session.baselineModel
      delete session.baselineServiceTier
      session.legacyUnpriced = false
      session.unreconciled = false
      session.missingRaw = false
      delete session.fullRawReplayPending
      if (this.fullReplayActive || replayFromIntent) this.replayedSessionIds.add(candidate.sessionId)
    }
    if (replayFuture) {
      // Reclassification after a pricing update only rebuilds the segment
      // after the immutable fallback floor; legacy history stays unpriced.
      session.legacyUnpriced = false
      session.unreconciled = false
      session.missingRaw = false
    }
    session.pricingSemanticHash = this.currentState().priceBook.payloadSha256 ?? null
    session.pricingIndexRevision = STATE_INDEX_REVISION
    this.currentState().sessions[candidate.sessionId] = session
    this.completeQueueEntry(queueId)
  }

  private retainLegacyProjection(candidate: CandidateFile, session: StoredSessionState): void {
    const retainFullReplayIntent = this.fullReplayActive || session.fullRawReplayPending === true
    session.legacyUnpriced = true
    session.unreconciled = true
    session.missingRaw = false
    session.pricingSemanticHash = null
    session.pricingIndexRevision = 0
    if (retainFullReplayIntent) {
      session.fullRawReplayPending = true
      this.retainedSessionIds.add(candidate.sessionId)
    }
    this.currentState().sessions[candidate.sessionId] = session
    this.updateState((state) => {
      if (!state.unreconciledSessions.includes(candidate.sessionId)) state.unreconciledSessions.push(candidate.sessionId)
    })
  }

  private completeQueueEntry(queueId: string): void {
    const entry = this.currentState().pendingPricingQueue.find((candidate) => candidate.id === queueId)
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
      applyAttribution(session, payload)
      return
    }

    if (isSettings) {
      applyAttribution(session, payload)
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

    const timestampMs = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : Number.NaN
    if (!Number.isFinite(timestampMs)) {
      session.parseErrors += 1
      return
    }
    // A cumulative snapshot with no valid event timestamp is not a usable raw
    // replay anchor; do not let it make an otherwise invalid file appear
    // readable during the raw-authority cutover.
    session.lastCumulative = serializeTokens(totalUsage)

    const attribution = applyAttribution(session, payload, info)
    const model = attribution.model
    const eventTier = attribution.serviceTier
    const eventAt = new Date(timestampMs).toISOString()
    const effectivePricing = resolveEffectiveModelPricing(
      this.currentState().priceBook,
      model,
      eventAt,
      this.currentState().pricingLedger
    )
    const contextInput = extractRequestInput(payload, info, delta)
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

function clonePersistentState(state: PersistentState): PersistentState {
  return JSON.parse(JSON.stringify(state)) as PersistentState
}

function applyReplayProvenance(
  state: PersistentState,
  baseline: PersistentState | null,
  failures: Set<string>,
  replayedSessionIds: Set<string>,
  retainedSessionIds: Set<string>,
  replacementBaselines: Map<string, StoredSessionState>
): void {
  let rawTokenDelta = 0n
  for (const sessionId of replayedSessionIds) {
    const session = state.sessions[sessionId]
    if (!session) continue
    rawTokenDelta += sumDailyTokens(session.daily) - legacyProjectionTotal(replacementBaselines.get(sessionId) ?? baseline?.sessions[sessionId])
  }
  state.rebuild.replayedSessions = replayedSessionIds.size
  state.rebuild.retainedLegacySessions = retainedSessionIds.size
  state.rebuild.rawTokenDelta = rawTokenDelta.toString()
  state.rebuild.failureDiagnostics = [...failures].sort()
}

function legacyProjectionTotal(session: StoredSessionState | undefined): bigint {
  if (!session) return 0n
  return sumDailyTokens(session.legacyDaily) + sumDailyTokens(session.daily)
}

function sumDailyTokens(daily: Record<string, StoredDailyAggregate> | undefined): bigint {
  let total = 0n
  for (const value of Object.values(daily ?? {})) {
    for (const model of Object.values(value.models ?? {})) {
      total += deserializeTokens(model.short ?? serializeTokens(zeroTokens())).total
      total += deserializeTokens(model.long ?? serializeTokens(zeroTokens())).total
      total += deserializeTokens(model.unknown ?? serializeTokens(zeroTokens())).total
    }
  }
  return total
}

function createSessionState(candidate: CandidateFile): StoredSessionState {
  const session: StoredSessionState = {
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
    parseErrors: 0,
    pricingSemanticHash: null,
    pricingIndexRevision: 0
  }
  return session
}

function createFutureReplaySession(candidate: CandidateFile, stored: StoredSessionState): StoredSessionState {
  const session = cloneSessionState(stored)
  const floor = stored.baselineOffset ?? stored.offset
  session.path = candidate.path
  session.offset = floor
  session.fileSize = 0
  session.modifiedAtMs = 0
  session.daily = {}
  session.cycles = {}
  session.eventCount = 0
  session.parseErrors = 0
  session.lastCumulative = stored.baselineCumulative ?? stored.lastCumulative
  session.currentModel = stored.baselineModel ?? stored.currentModel
  session.currentServiceTier = stored.baselineServiceTier ?? stored.currentServiceTier ?? 'unknown'
  session.lastEventModel = stored.baselineModel
  session.lastEventServiceTier = stored.baselineServiceTier
  session.legacyUnpriced = false
  session.unreconciled = false
  session.missingRaw = false
  session.pricingSemanticHash = null
  session.pricingIndexRevision = 0
  return session
}

function cloneSessionState(session: StoredSessionState): StoredSessionState {
  return JSON.parse(JSON.stringify(session)) as StoredSessionState
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function queueIdentity(candidate: CandidateFile): string {
  return `${candidate.sessionId}:${candidate.path}:${candidate.size}:${candidate.modifiedAtMs}`
}

function isActionableCandidate(state: PersistentState, candidate: CandidateFile, trigger: ScanTrigger = 'manual'): boolean {
  const session = state.sessions[candidate.sessionId]
  const queue = state.pendingPricingQueue.find((entry) => entry.sessionId === candidate.sessionId && (entry.status === 'pending' || entry.status === 'processing'))
  if (queue) return true
  if (!session) return true
  if (state.indexRevision < STATE_INDEX_REVISION || state.attributionRevision < ATTRIBUTION_REVISION) return true
  if (session.missingRaw) return true
  if (session.fullRawReplayPending) {
    // A failed full migration is retryable on demand or when the raw
    // identity changes, but a stable periodic tick must not reread it.
    return trigger !== 'periodic' || session.path !== candidate.path || session.fileSize !== candidate.size || session.modifiedAtMs !== candidate.modifiedAtMs
  }
  if (session.fingerprintBootstrapPending) return true
  if (session.unreconciled || session.legacyUnpriced) {
    // A stable invalid/retained raw projection is not actionable on every
    // periodic tick. Revisit it only when the file reappears or its metadata
    // changes (an explicit manual scan still has the same convergence path).
    return trigger !== 'periodic' || session.path !== candidate.path || session.fileSize !== candidate.size || session.modifiedAtMs !== candidate.modifiedAtMs
  }
  if (shouldReplayForPricing(session, state.priceBook.payloadSha256 ?? null)) return true
  if (session.path !== candidate.path || session.fileSize !== candidate.size || session.offset < candidate.size || session.modifiedAtMs !== candidate.modifiedAtMs) return true
  return session.offset === 0 && candidate.size > 0
}

function enqueueQueueEntry(state: ReturnType<StateStore['get']>, candidate: CandidateFile): void {
  const id = queueIdentity(candidate)
  for (const entry of state.pendingPricingQueue) {
    if (entry.sessionId !== candidate.sessionId || entry.id === id) continue
    if (entry.status === 'pending' || entry.status === 'processing') {
      entry.status = 'aborted'
      entry.error = 'Superseded by a newer file snapshot.'
    }
  }
  const existing = state.pendingPricingQueue.find((entry) => entry.id === id)
  if (existing) {
    if (existing.status === 'aborted') existing.status = 'pending'
    existing.filePath = candidate.path
    existing.capturedSize = candidate.size
    existing.capturedOffset = state.sessions[candidate.sessionId]?.offset ?? 0
    existing.error = null
    return
  }
  state.pendingPricingQueue.push({
    id,
    sessionId: candidate.sessionId,
    filePath: candidate.path,
    capturedSize: candidate.size,
    capturedOffset: state.sessions[candidate.sessionId]?.offset ?? 0,
    queuedAt: new Date().toISOString(),
    status: 'pending',
    error: null
  })
}

function shouldReplayForPricing(session: StoredSessionState | undefined, currentHash: string | null): boolean {
  if (!session) return false
  if (!session.pricingSemanticHash || session.pricingIndexRevision !== STATE_INDEX_REVISION || !currentHash) return true
  // Any semantic pricing change can alter short/long classification in either
  // direction, so replay every raw-backed session rather than only unknown
  // buckets.
  return session.pricingSemanticHash !== currentHash
}

function hasPersistedReplayFloor(session: StoredSessionState): boolean {
  return session.baselineOffset !== undefined || Boolean((session.legacyDaily || session.legacyCycles) && session.legacyUnpriced === false)
}

async function verifyBaselinePrefix(path: string, session: StoredSessionState): Promise<boolean> {
  const offset = session.baselineOffset ?? session.offset
  if (!Number.isSafeInteger(offset) || offset < 0 || !session.baselinePrefixFingerprint || !session.baselineCumulative) return false
  if (offset === 0 && session.baselineCumulative.total !== '0') return false
  try {
    return await fingerprintFilePrefix(path, offset) === session.baselinePrefixFingerprint
  } catch {
    return false
  }
}

async function rebaselineSession(
  candidate: CandidateFile,
  stored: StoredSessionState,
  pricingHash: string | null
): Promise<StoredSessionState> {
  const session = cloneSessionState(stored)
  const captured = await captureTailBaseline(candidate)
  stashCurrentAggregates(session)
  session.path = candidate.path
  session.offset = captured.offset
  session.fileSize = candidate.size
  session.modifiedAtMs = candidate.modifiedAtMs
  session.prefixFingerprint = captured.prefixFingerprint
  session.contentFingerprint = captured.contentFingerprint
  session.baselineOffset = captured.offset
  session.baselinePrefixFingerprint = captured.prefixFingerprint
  session.baselineCumulative = captured.baseline?.cumulative
  session.baselineModel = captured.baseline?.model ?? session.currentModel
  session.baselineServiceTier = captured.baseline?.serviceTier ?? session.currentServiceTier
  session.recoveryAnchor = undefined
  if (captured.baseline) {
    session.lastCumulative = captured.baseline.cumulative
    session.currentModel = captured.baseline.model
    session.lastEventModel = captured.baseline.model
    session.currentServiceTier = captured.baseline.serviceTier
    session.lastEventServiceTier = captured.baseline.serviceTier
    session.legacyUnpriced = false
    session.unreconciled = false
    session.missingRaw = false
    session.pricingSemanticHash = pricingHash
    session.pricingIndexRevision = STATE_INDEX_REVISION
  } else {
    session.lastCumulative = null
    session.legacyUnpriced = true
    session.unreconciled = true
    session.missingRaw = true
    session.pricingSemanticHash = null
    session.pricingIndexRevision = 0
  }
  return session
}

function preserveLegacyFallback(candidate: CandidateFile, previous: StoredSessionState): StoredSessionState {
  // Preserve the complete pre-migration composite. In particular, a v0.1.4
  // session can contain both legacy and current slices; collapsing either
  // pair here would lose tokens/cycles or double-count on the next retry.
  const fallback = cloneSessionState(previous)
  fallback.path = candidate.path
  fallback.offset = 0
  // Retain the observed raw identity so a stable invalid projection does not
  // become an immortal periodic retry. A new/changed file remains actionable.
  fallback.fileSize = candidate.size
  fallback.modifiedAtMs = candidate.modifiedAtMs
  fallback.contentFingerprint = undefined
  fallback.prefixFingerprint = undefined
  fallback.recoveryAnchor = undefined
  fallback.fingerprintBootstrapPending = false
  fallback.lastCumulative = previous.lastCumulative
  fallback.currentModel = previous.currentModel
  fallback.currentServiceTier = previous.currentServiceTier
  fallback.lastEventModel = previous.lastEventModel
  fallback.lastEventServiceTier = previous.lastEventServiceTier
  fallback.legacyUnpriced = true
  fallback.unreconciled = true
  fallback.missingRaw = false
  fallback.pricingSemanticHash = null
  fallback.pricingIndexRevision = 0
  return fallback
}

function stashCurrentAggregates(session: StoredSessionState): void {
  if (Object.keys(session.daily).length > 0) {
    const target = (session.legacyDaily ??= {})
    mergeDailyRecords(target, session.daily)
  }
  if (Object.keys(session.cycles).length > 0) {
    const target = (session.legacyCycles ??= {})
    mergeCycleRecords(target, session.cycles)
  }
  session.legacyEventCount = (session.legacyEventCount ?? 0) + session.eventCount
  session.daily = {}
  session.cycles = {}
  session.eventCount = 0
}

function mergeDailyRecords(target: Record<string, StoredDailyAggregate>, source: Record<string, StoredDailyAggregate>): void {
  for (const [date, daily] of Object.entries(source)) {
    const destination = (target[date] ??= { models: {} })
    for (const [model, aggregate] of Object.entries(daily.models ?? {})) {
      const current = destination.models[model]
      destination.models[model] = current ? mergeModelAggregates(current, aggregate) : cloneJson(aggregate)
    }
  }
}

function mergeCycleRecords(target: Record<string, StoredCycleAggregate>, source: Record<string, StoredCycleAggregate>): void {
  for (const [key, cycle] of Object.entries(source)) {
    const current = target[key]
    if (!current) {
      target[key] = cloneJson(cycle)
      continue
    }
    for (const [model, aggregate] of Object.entries(cycle.models ?? {})) {
      const existing = current.models[model]
      current.models[model] = existing ? mergeModelAggregates(existing, aggregate) : cloneJson(aggregate)
    }
    current.usedPercents = [...new Set([...current.usedPercents, ...cycle.usedPercents])].sort((left, right) => left - right)
    current.firstSampleAt = minIso(current.firstSampleAt, cycle.firstSampleAt) ?? current.firstSampleAt
    current.lastSampleAt = maxIso(current.lastSampleAt, cycle.lastSampleAt) ?? current.lastSampleAt
  }
}

function mergeModelAggregates(target: StoredModelAggregate, source: StoredModelAggregate): StoredModelAggregate {
  const result = cloneJson(target)
  for (const context of ['short', 'long', 'unknown'] as const) {
    result[context] = serializeTokens(addTokens(
      deserializeTokens(result[context] ?? serializeTokens(zeroTokens())),
      deserializeTokens(source[context] ?? serializeTokens(zeroTokens()))
    ))
  }
  result.eventCount += source.eventCount
  result.firstEventAt = minIso(result.firstEventAt, source.firstEventAt)
  result.lastEventAt = maxIso(result.lastEventAt, source.lastEventAt)
  const bySpeed = (result.bySpeed ??= {})
  for (const [tier, speed] of Object.entries(source.bySpeed ?? {})) {
    if (!speed) continue
    const current = bySpeed[tier as ServiceTier]
    bySpeed[tier as ServiceTier] = current ? mergeSpeedAggregates(current, speed) : cloneJson(speed)
  }
  return result
}

function mergeSpeedAggregates(target: StoredSpeedAggregate, source: StoredSpeedAggregate): StoredSpeedAggregate {
  const result = cloneJson(target)
  for (const context of ['short', 'long', 'unknown'] as const) {
    result[context] = serializeTokens(addTokens(
      deserializeTokens(result[context] ?? serializeTokens(zeroTokens())),
      deserializeTokens(source[context] ?? serializeTokens(zeroTokens()))
    ))
  }
  result.eventCount += source.eventCount
  result.lowerBound ||= source.lowerBound === true
  result.firstEventAt = minIso(result.firstEventAt, source.firstEventAt)
  result.lastEventAt = maxIso(result.lastEventAt, source.lastEventAt)
  return result
}

function minIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return left < right ? left : right
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

async function fingerprintFile(path: string): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content).digest('hex')
}

async function fingerprintFilePrefix(path: string, offset: number): Promise<string> {
  const content = await readFile(path)
  return createHash('sha256').update(content.subarray(0, Math.min(offset, content.byteLength))).digest('hex')
}

async function isStableCandidate(candidate: CandidateFile): Promise<boolean> {
  try {
    const details = await stat(candidate.path)
    return details.size === candidate.size && details.mtimeMs === candidate.modifiedAtMs
  } catch {
    return false
  }
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

interface EventAttribution {
  model: string | null
  modelPresent: boolean
  serviceTier: ServiceTier
  serviceTierPresent: boolean
}

type AttributionState = Pick<StoredSessionState, 'currentModel' | 'currentServiceTier'>

interface PresentValue {
  present: boolean
  value: unknown
}

function firstPresent(...candidates: PresentValue[]): PresentValue {
  return candidates.find((candidate) => candidate.present) ?? { present: false, value: undefined }
}

function property(value: Record<string, unknown>, key: string): PresentValue {
  return { present: Object.prototype.hasOwnProperty.call(value, key), value: value[key] }
}

function extractServiceTier(value: Record<string, unknown>): ServiceTier | null {
  const candidate = extractTierPresence(value)
  if (!candidate.present) return null
  return normalizeServiceTier(candidate.value)
}

function extractModelPresence(value: Record<string, unknown>, info?: Record<string, unknown>): PresentValue {
  const threadSettings = isRecord(value.thread_settings) ? value.thread_settings : null
  const settings = isRecord(value.settings) ? value.settings : null
  const eventInfo = info ?? (isRecord(value.info) ? value.info : null)
  return firstPresent(
    property(value, 'model'),
    property(value, 'model_name'),
    ...(threadSettings ? [property(threadSettings, 'model'), property(threadSettings, 'model_name')] : []),
    ...(settings ? [property(settings, 'model'), property(settings, 'model_name')] : []),
    ...(eventInfo ? [property(eventInfo, 'model'), property(eventInfo, 'model_name')] : [])
  )
}

function extractAttribution(payload: Record<string, unknown>, info?: Record<string, unknown>): EventAttribution {
  const modelCandidate = extractModelPresence(payload, info)
  const tierCandidate = extractTierPresence(payload, info)
  const model = modelCandidate.present && typeof modelCandidate.value === 'string' && modelCandidate.value.trim()
    ? modelCandidate.value.trim()
    : modelCandidate.present
      ? 'unknown'
      : null
  const serviceTier = tierCandidate.present ? normalizeServiceTier(tierCandidate.value) : 'unknown'
  return {
    model,
    modelPresent: modelCandidate.present,
    serviceTier,
    serviceTierPresent: tierCandidate.present
  }
}

/**
 * Runtime envelopes use `thread_settings`, while older logs used `settings`.
 * Keep the precedence explicit: direct payload, thread settings, settings,
 * then token-event info. Presence is significant, so an explicit null or
 * unsupported value clears inherited attribution to `unknown`.
 */
function extractTierPresence(value: Record<string, unknown>, info?: Record<string, unknown>): PresentValue {
  const threadSettings = isRecord(value.thread_settings) ? value.thread_settings : null
  const settings = isRecord(value.settings) ? value.settings : null
  const eventInfo = info ?? (isRecord(value.info) ? value.info : null)
  return firstPresent(
    property(value, 'service_tier'),
    property(value, 'serviceTier'),
    ...(threadSettings ? [property(threadSettings, 'service_tier'), property(threadSettings, 'serviceTier')] : []),
    ...(settings ? [property(settings, 'service_tier'), property(settings, 'serviceTier')] : []),
    ...(eventInfo ? [property(eventInfo, 'service_tier'), property(eventInfo, 'serviceTier')] : [])
  )
}

function normalizeServiceTier(value: unknown): ServiceTier {
  if (typeof value !== 'string') return 'unknown'
  const normalized = value.trim().toLowerCase()
  if (normalized === 'default' || normalized === 'standard') return 'standard'
  if (normalized === 'priority' || normalized === 'fast') return 'fast'
  return 'unknown'
}

function applyAttribution(
  session: AttributionState,
  payload: Record<string, unknown>,
  info?: Record<string, unknown>
): { model: string; serviceTier: ServiceTier } {
  const attribution = extractAttribution(payload, info)
  if (attribution.modelPresent) session.currentModel = attribution.model ?? 'unknown'
  if (attribution.serviceTierPresent) session.currentServiceTier = attribution.serviceTier
  return {
    model: session.currentModel || 'unknown',
    serviceTier: session.currentServiceTier ?? 'unknown'
  }
}

function extractEventModel(payload: Record<string, unknown>, info: Record<string, unknown>): string | null {
  const model = extractAttribution(payload, info)
  return model.modelPresent && model.model !== 'unknown' ? model.model : null
}

function extractRequestInput(
  payload: Record<string, unknown>,
  info: Record<string, unknown>,
  delta: BigTokenBreakdown
): bigint {
  const candidates: unknown[] = [
    info.last_token_usage,
    info.request_token_usage,
    info.input_token_usage,
    payload.last_token_usage,
    payload.request_token_usage,
    payload.input_token_usage
  ]
  for (const candidate of candidates) {
    const usage = fromUnknownTokenUsage(candidate)
    if (usage) return usage.input
  }
  return delta.input
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
      const info = isRecord(payload.info) ? payload.info : undefined
      const metadataSession: AttributionState = {
        currentModel,
        currentServiceTier
      }
      if (row.type === 'turn_context' || payload.type === 'thread_settings_applied' || row.type === 'thread_settings_applied') {
        const attribution = applyAttribution(metadataSession, payload)
        currentModel = metadataSession.currentModel
        currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
        lastEventModel = attribution.model
        lastEventServiceTier = attribution.serviceTier
      }
      if (payload.type !== 'token_count' || !isRecord(payload.info)) continue
      const usage = fromUnknownTokenUsage(payload.info.total_token_usage)
      if (!usage) continue
      latestCumulative = serializeTokens(usage)
      const attribution = applyAttribution(metadataSession, payload, info)
      currentModel = metadataSession.currentModel
      currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
      lastEventModel = attribution.model
      lastEventServiceTier = attribution.serviceTier
    } catch {
      return null
    }
  }
  if (session.lastCumulative && latestCumulative && JSON.stringify(session.lastCumulative) !== JSON.stringify(latestCumulative)) return null
  if (session.lastCumulative && !latestCumulative) return null
  // Metadata can legally trail the latest token_count. The final attribution
  // state is the one needed to resume a metadata-free append after bootstrap.
  if (latestCumulative) {
    lastEventModel = currentModel
    lastEventServiceTier = currentServiceTier
  }
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

async function readLatestBaseline(path: string, capturedEnd?: number): Promise<{ cumulative: TokenBreakdown; model: string; serviceTier: ServiceTier } | null> {
  let content: Buffer
  try {
    content = await readFile(path)
  } catch {
    return null
  }
  const end = capturedEnd === undefined ? content.byteLength : Math.max(0, Math.min(capturedEnd, content.byteLength))
  let currentModel = 'unknown'
  let currentServiceTier: ServiceTier = 'unknown'
  let latest: { cumulative: TokenBreakdown; model: string; serviceTier: ServiceTier } | null = null
  for (const line of content.subarray(0, end).toString('utf8').split(/\n/)) {
    if (!line.trim()) continue
    try {
      const row = JSON.parse(line) as unknown
      if (!isRecord(row) || !isRecord(row.payload)) continue
      const payload = row.payload
      const metadataSession: AttributionState = { currentModel, currentServiceTier }
      if (row.type === 'turn_context' || payload.type === 'thread_settings_applied' || row.type === 'thread_settings_applied') {
        applyAttribution(metadataSession, payload)
        currentModel = metadataSession.currentModel
        currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
      }
      if (payload.type !== 'token_count' || !isRecord(payload.info)) continue
      const usage = fromUnknownTokenUsage(payload.info.total_token_usage)
      if (!usage) continue
      const attribution = applyAttribution(metadataSession, payload, payload.info)
      currentModel = metadataSession.currentModel
      currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
      const model = attribution.model
      const serviceTier = attribution.serviceTier
      latest = { cumulative: serializeTokens(usage), model, serviceTier }
    } catch {
      // A trailing partial line does not invalidate the last complete
      // cumulative baseline; the normal stream boundary handles it later.
      continue
    }
  }
  if (latest) {
    // A trailing turn_context/thread_settings_applied after the last token
    // changes the inherited metadata for the next append and must be part of
    // the captured baseline.
    latest = {
      ...latest,
      model: currentModel,
      serviceTier: currentServiceTier
    }
  }
  return latest
}

interface CapturedTailBaseline {
  offset: number
  prefixFingerprint: string
  contentFingerprint: string
  baseline: { cumulative: TokenBreakdown; model: string; serviceTier: ServiceTier } | null
}

async function captureTailBaseline(candidate: CandidateFile): Promise<CapturedTailBaseline> {
  let offset = await findLastCompleteLineEnd(candidate.path, 0, candidate.size)
  // Only parse records through the exact newline boundary. A syntactically
  // valid newline-less tail is deliberately excluded until its newline is
  // observed, keeping cumulative, fingerprint, and offset aligned.
  const baseline = await readLatestBaseline(candidate.path, offset)
  const [prefixFingerprint, contentFingerprint] = await Promise.all([
    fingerprintFilePrefix(candidate.path, offset),
    fingerprintFile(candidate.path)
  ])
  return { offset, prefixFingerprint, contentFingerprint, baseline }
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
      const metadataSession: AttributionState = { currentModel, currentServiceTier }
      if (row.type === 'turn_context' || payload.type === 'thread_settings_applied' || row.type === 'thread_settings_applied') {
        applyAttribution(metadataSession, payload)
        currentModel = metadataSession.currentModel
        currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
      }
      if (payload.type === 'token_count' && isRecord(payload.info)) {
        const usage = fromUnknownTokenUsage(payload.info.total_token_usage)
        if (usage) {
          lastCumulative = serializeTokens(usage)
          if (JSON.stringify(serializeTokens(usage)) === JSON.stringify(target)) {
            cumulativeMatches += 1
            const info = payload.info
            const attribution = applyAttribution(metadataSession, payload, info)
            currentModel = metadataSession.currentModel
            currentServiceTier = metadataSession.currentServiceTier ?? 'unknown'
            const eventModel = attribution.model
            const eventTier = attribution.serviceTier
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
  extractAttribution,
  extractRequestInput,
  readLatestBaseline,
  captureTailBaseline,
  recoverRewrittenSession
}
