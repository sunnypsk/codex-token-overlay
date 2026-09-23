import { EventEmitter } from 'node:events'
import { join } from 'node:path'
import type { OverlaySettings, QuotaSnapshot, RateLimitBucket } from '../shared/contracts.js'
import { AppServerClient } from './app-server-client.js'
import { findCodexExecutable } from './codex-executable.js'
import { buildQuotaSnapshot, type QuotaRuntimeStatus } from './quota-snapshot.js'
import { QuotaStateStore } from './quota-state.js'

const RATE_LIMIT_POLL_MS = 60_000

interface RateLimitClient {
  on(event: 'rateLimitsUpdated', listener: () => void): unknown
  on(event: 'disconnected', listener: (error: Error) => void): unknown
  start(): Promise<{ codexHome: string }>
  stop(): Promise<void>
  readRateLimits(): Promise<RateLimitBucket[]>
}

export interface QuotaServiceOptions {
  findExecutable?: () => Promise<string | null>
  createClient?: (executable: string) => RateLimitClient
}

export class QuotaService extends EventEmitter {
  readonly store: QuotaStateStore
  private appServer: RateLimitClient | null = null
  private rateTimer: NodeJS.Timeout | null = null
  private reconnectTimer: NodeJS.Timeout | null = null
  private snapshotTimer: NodeJS.Timeout | null = null
  private starting: Promise<void> | null = null
  private syncing: Promise<void> | null = null
  private reconnectAttempt = 0
  private stopped = false
  private runtime: QuotaRuntimeStatus = { appServer: 'connecting', message: null }
  private readonly findExecutable: () => Promise<string | null>
  private readonly createClient: (executable: string) => RateLimitClient

  constructor(userDataPath: string, options: QuotaServiceOptions = {}) {
    super()
    this.store = new QuotaStateStore(join(userDataPath, 'quota-state.json'), join(userDataPath, 'usage-state.json'))
    this.findExecutable = options.findExecutable ?? findCodexExecutable
    this.createClient = options.createClient ?? ((executable) => new AppServerClient(executable))
  }

  async start(): Promise<void> {
    await this.store.load()
    this.stopped = false
    this.rateTimer = setInterval(() => void this.syncRateLimits(), RATE_LIMIT_POLL_MS)
    void this.connect()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.rateTimer) clearInterval(this.rateTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer)
    this.rateTimer = null
    this.reconnectTimer = null
    this.snapshotTimer = null
    await this.appServer?.stop()
    this.appServer = null
    await this.store.save()
  }

  getSnapshot(): QuotaSnapshot {
    return buildQuotaSnapshot(this.store.get(), this.runtime)
  }

  async refresh(): Promise<QuotaSnapshot> {
    await this.ensureConnected()
    await this.syncRateLimits()
    await this.store.save()
    this.emitSnapshot()
    return this.getSnapshot()
  }

  updateSettings(patch: Partial<OverlaySettings>): QuotaSnapshot {
    this.store.update((state) => {
      state.settings = { ...state.settings, ...patch }
    }, true)
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
    this.runtime = { appServer: 'connecting', message: null }
    this.emitSnapshot()
    try {
      const executable = await this.findExecutable()
      if (!executable) {
        this.markOffline('Codex executable was not found.')
        this.scheduleReconnect()
        return
      }
      const client = this.createClient(executable)
      client.on('rateLimitsUpdated', () => void this.syncRateLimits())
      client.on('disconnected', (error: Error) => {
        if (this.stopped || this.appServer !== client) return
        this.appServer = null
        this.markOffline(error.message)
        this.scheduleReconnect()
      })
      try {
        await client.start()
        if (this.stopped) {
          await client.stop()
          return
        }
        await this.appServer?.stop()
        this.appServer = client
        this.reconnectAttempt = 0
        await this.syncRateLimits()
      } catch (error) {
        if (this.appServer === client) this.appServer = null
        await client.stop()
        this.markOffline(error instanceof Error ? error.message : 'Unable to start Codex App Server')
        this.scheduleReconnect()
      }
    } catch (error) {
      this.markOffline(error instanceof Error ? error.message : 'Unable to find Codex executable')
      this.scheduleReconnect()
    }
  }

  private ensureConnected(): Promise<void> {
    return this.appServer ? Promise.resolve() : this.connect()
  }

  private syncRateLimits(): Promise<void> {
    if (this.syncing) return this.syncing
    this.syncing = this.performRateLimitSync().finally(() => {
      this.syncing = null
    })
    return this.syncing
  }

  private async performRateLimitSync(): Promise<void> {
    const client = this.appServer
    if (!client || this.stopped) return
    try {
      const buckets = await client.readRateLimits()
      if (this.stopped || this.appServer !== client) return
      this.store.update((state) => {
        state.rateLimits = buckets
        state.rateLimitsSyncedAt = new Date().toISOString()
      })
      this.runtime = { appServer: 'online', message: null }
      this.emitSnapshot()
    } catch (error) {
      this.markOffline(error instanceof Error ? error.message : 'Rate-limit sync failed')
    }
  }

  private markOffline(message: string): void {
    if (this.stopped) return
    this.runtime = { appServer: 'offline', message }
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
    if (this.stopped || this.snapshotTimer) return
    this.snapshotTimer = setTimeout(() => {
      this.snapshotTimer = null
      if (!this.stopped) this.emit('snapshot', this.getSnapshot())
    }, 100)
  }
}

export const quotaServiceConstants = { RATE_LIMIT_POLL_MS }
