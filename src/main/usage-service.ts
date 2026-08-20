import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import { net } from 'electron'
import type { DashboardSnapshot, OverlaySettings, RateLimitBucket } from '../shared/contracts.js'
import { buildDashboardSnapshot, type SnapshotRuntimeStatus } from './aggregation.js'
import { AppServerClient } from './app-server-client.js'
import { findCodexExecutable } from './codex-executable.js'
import { PricingService } from './pricing.js'
import { PricingDiagnostics } from './pricing-diagnostics.js'
import { SessionIndexer, type IndexerProgress } from './session-indexer.js'
import { StateStore } from './state.js'
import { startOfHongKongMonth } from './time.js'

const RATE_LIMIT_POLL_MS = 60_000
const ACCOUNT_USAGE_POLL_MS = 15 * 60_000
const DEFAULT_BACKFILL_MS = 63 * 24 * 60 * 60 * 1_000
const DIAGNOSTICS_FLUSH_TIMEOUT_MS = 2_000

export class UsageService extends EventEmitter {
  readonly store: StateStore
  private appServer: AppServerClient | null = null
  private indexer: SessionIndexer | null = null
  private pricing: PricingService
  private readonly diagnostics: PricingDiagnostics
  private rateTimer: NodeJS.Timeout | null = null
  private usageTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private reconnectAttempt = 0
  private starting: Promise<void> | null = null
  private stopped = false
  private snapshotTimer: NodeJS.Timeout | null = null
  private runtime: SnapshotRuntimeStatus = {
    appServer: 'connecting',
    appServerMessage: null,
    indexing: 'idle',
    indexedFiles: 0,
    totalFiles: 0
  }

  constructor(
    userDataPath: string,
    logsPath = join(userDataPath, 'logs'),
    diagnostics: PricingDiagnostics = new PricingDiagnostics(logsPath),
    private readonly diagnosticsFlushTimeoutMs = DIAGNOSTICS_FLUSH_TIMEOUT_MS
  ) {
    super()
    this.store = new StateStore(join(userDataPath, 'usage-state.json'))
    this.diagnostics = diagnostics
    this.pricing = new PricingService(
      () => this.store.get().priceBook,
      (priceBook) => this.store.update((state) => {
        const previousHash = state.priceBook.payloadSha256 ?? null
        state.priceBook = priceBook
        if (priceBook.payloadSha256 && priceBook.payloadSha256 !== previousHash) {
          state.pricingLedger.push({
            id: `${priceBook.payloadSha256}:${priceBook.updatedAt}`,
            effectiveAt: priceBook.sourceEffectiveAt ?? priceBook.updatedAt,
            observedAt: priceBook.observedAt ?? priceBook.checkedAt ?? priceBook.updatedAt,
            source: priceBook.sourceUrl,
            sourceSha256: priceBook.sourceSha256 ?? null,
            semanticHash: priceBook.payloadSha256,
            models: priceBook.models as Record<string, unknown>
          })
        }
      }),
      () => {
        this.emitSnapshot()
        void this.diagnostics.emit(this.store.get())
        // A semantic pricing change invalidates unknown-context sessions;
        // scanning here converges the projection without waiting for the
        // periodic index interval. Startup creates the indexer after the
        // initial pricing refresh, so it cannot replay against an invalid
        // legacy book.
        void this.indexer?.scan()
      },
      (input, init) => net.fetch(input, init)
    )
  }

  async start(): Promise<void> {
    await this.store.load()
    this.stopped = false
    await this.pricing.refreshIfDue()
    void this.diagnostics.emit(this.store.get())
    this.pricing.start(false)
    this.rateTimer = setInterval(() => void this.syncRateLimits(), RATE_LIMIT_POLL_MS)
    this.usageTimer = setInterval(() => void this.syncAccountUsage(), ACCOUNT_USAGE_POLL_MS)
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.rateTimer) clearInterval(this.rateTimer)
    if (this.usageTimer) clearInterval(this.usageTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.rateTimer = null
    this.usageTimer = null
    this.reconnectTimer = null
    this.snapshotTimer = null
    this.pricing.stop()
    await this.indexer?.stop()
    this.indexer = null
    await this.appServer?.stop()
    this.appServer = null
    await flushDiagnosticsWithTimeout(this.diagnostics, this.diagnosticsFlushTimeoutMs)
    await this.store.save()
  }

  getSnapshot(): DashboardSnapshot {
    return buildDashboardSnapshot(
      this.store.get(),
      this.runtime,
      this.indexer?.getFallbackRateLimit() ?? null
    )
  }

  getPricingDiagnosticsPath(): string {
    return this.diagnostics.filePath
  }

  async refresh(): Promise<DashboardSnapshot> {
    await Promise.allSettled([
      this.ensureConnected(),
      this.syncRateLimits(),
      this.syncAccountUsage(),
      this.indexer?.scan() ?? Promise.resolve(),
      this.pricing.refreshIfDue(true)
    ])
    this.emitSnapshot()
    return this.getSnapshot()
  }

  updateSettings(patch: Partial<OverlaySettings>): DashboardSnapshot {
    this.store.update((state) => {
      state.settings = { ...state.settings, ...patch }
    })
    this.emitSnapshot()
    return this.getSnapshot()
  }

  private connect(): Promise<void> {
    if (this.starting) return this.starting
    this.starting = this.performConnect().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private async performConnect(): Promise<void> {
    this.runtime.appServer = 'connecting'
    this.runtime.appServerMessage = null
    this.emitSnapshot()

    const executable = await findCodexExecutable()
    if (!executable) {
      this.markOffline('Codex executable was not found. Showing local session data only.')
      await this.ensureIndexer(defaultCodexHome(), this.computeScanStart())
      return
    }

    const client = new AppServerClient(executable)
    client.on('rateLimitsUpdated', () => void this.syncRateLimits())
    client.on('disconnected', (error: Error) => {
      if (this.appServer === client) this.appServer = null
      this.markOffline(error.message)
      this.scheduleReconnect()
    })

    try {
      const { codexHome } = await client.start()
      if (this.stopped) {
        await client.stop()
        return
      }
      await this.appServer?.stop()
      this.appServer = client
      this.runtime.appServer = 'online'
      this.runtime.appServerMessage = null
      this.reconnectAttempt = 0
      await Promise.allSettled([this.syncRateLimits(), this.syncAccountUsage()])
      await this.ensureIndexer(codexHome, this.computeScanStart())
      this.emitSnapshot()
    } catch (error) {
      await client.stop()
      this.markOffline(error instanceof Error ? error.message : 'Unable to start Codex App Server')
      await this.ensureIndexer(defaultCodexHome(), this.computeScanStart())
      this.scheduleReconnect()
    }
  }

  private ensureConnected(): Promise<void> {
    return this.appServer ? Promise.resolve() : this.connect()
  }

  private async syncRateLimits(): Promise<void> {
    const client = this.appServer
    if (!client) return
    try {
      const buckets = await client.readRateLimits()
      const now = new Date().toISOString()
      this.store.update((state) => {
        state.rateLimits = buckets
        state.rateLimitsSyncedAt = now
      })
      this.runtime.appServer = 'online'
      this.runtime.appServerMessage = null
      this.emitSnapshot()
    } catch (error) {
      this.runtime.appServerMessage = error instanceof Error ? error.message : 'Rate-limit sync failed'
      this.emitSnapshot()
    }
  }

  private async syncAccountUsage(): Promise<void> {
    const client = this.appServer
    if (!client) return
    try {
      const usage = await client.readAccountUsage()
      const now = new Date().toISOString()
      this.store.update((state) => {
        state.account = { ...usage, syncedAt: now }
      })
      this.runtime.appServer = 'online'
      this.runtime.appServerMessage = null
      this.emitSnapshot()
    } catch (error) {
      this.runtime.appServerMessage = error instanceof Error ? error.message : 'Account usage sync failed'
      this.emitSnapshot()
    }
  }

  private async ensureIndexer(codexHome: string, scanStartMs: number): Promise<void> {
    if (this.indexer) return
    const onChanged = (progress: IndexerProgress): void => {
      this.runtime.indexing = progress.state
      this.runtime.indexedFiles = progress.indexedFiles
      this.runtime.totalFiles = progress.totalFiles
      if (progress.message) this.runtime.appServerMessage ??= progress.message
      this.emitSnapshot()
      void this.diagnostics.emit(this.store.get())
    }
    this.indexer = new SessionIndexer(codexHome, this.store, scanStartMs, onChanged)
    void this.indexer.start()
  }

  private computeScanStart(nowMs = Date.now()): number {
    const monthStart = startOfHongKongMonth(nowMs)
    const main = this.store
      .get()
      .rateLimits.find((bucket) => bucket.limitId === 'codex' && bucket.primary)?.primary
    if (!main) return Math.min(monthStart, nowMs - DEFAULT_BACKFILL_MS)
    const resetStart = main.resetsAt * 1_000 - main.windowDurationMins * 60 * 1_000
    const historicalStart = resetStart - 8 * main.windowDurationMins * 60 * 1_000
    return Math.min(monthStart, historicalStart)
  }

  private markOffline(message: string): void {
    this.runtime.appServer = 'offline'
    this.runtime.appServerMessage = message
    this.emitSnapshot()
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return
    const delay = Math.min(60_000, 2_000 * 2 ** this.reconnectAttempt++)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      void this.connect()
    }, delay)
  }

  private emitSnapshot(): void {
    if (this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      this.emit('snapshot', this.getSnapshot())
    }, 100)
  }
}

function defaultCodexHome(): string {
  return join(process.env.USERPROFILE ?? process.cwd(), '.codex')
}

export const usageServiceConstants = {
  RATE_LIMIT_POLL_MS,
  ACCOUNT_USAGE_POLL_MS,
  DEFAULT_BACKFILL_MS,
  DIAGNOSTICS_FLUSH_TIMEOUT_MS
}

async function flushDiagnosticsWithTimeout(diagnostics: PricingDiagnostics, timeoutMs: number): Promise<void> {
  const flush = Promise.resolve().then(() => diagnostics.flush()).catch(() => undefined)
  let timeoutHandle: NodeJS.Timeout | null = null
  const timeout = new Promise<void>((resolve) => {
    timeoutHandle = setTimeout(resolve, Math.max(0, timeoutMs))
  })
  await Promise.race([flush, timeout])
  if (timeoutHandle) clearTimeout(timeoutHandle)
}
