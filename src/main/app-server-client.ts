import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { createInterface, type Interface } from 'node:readline'
import type { RateLimitBucket, RateLimitWindow } from '../shared/contracts.js'
import { isRecord } from './token-math.js'

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export interface AccountUsageResult {
  lifetimeTokens: string | null
  peakDailyTokens: string | null
  dailyUsageBuckets: Record<string, string>
}

export interface AppServerStarted {
  codexHome: string
}

export class AppServerClient extends EventEmitter {
  private process: ChildProcessWithoutNullStreams | null = null
  private reader: Interface | null = null
  private nextRequestId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private stopping = false
  private stderrTail = ''

  constructor(private readonly executable: string) {
    super()
  }

  async start(): Promise<AppServerStarted> {
    if (this.process) throw new Error('Codex App Server is already running')
    this.stopping = false
    this.stderrTail = ''

    const child = spawn(this.executable, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env
    })
    this.process = child
    child.once('error', (error) => this.handleExit(error))
    child.once('exit', (code, signal) => {
      const detail = signal ? `signal ${signal}` : `code ${String(code)}`
      this.handleExit(new Error(`Codex App Server exited with ${detail}`))
    })
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = `${this.stderrTail}${chunk.toString('utf8')}`.slice(-4_000)
    })

    this.reader = createInterface({ input: child.stdout })
    this.reader.on('line', (line) => this.handleLine(line))

    const initialized = await this.request('initialize', {
      clientInfo: {
        name: 'codex_token_overlay',
        title: 'Codex Token Overlay',
        version: '0.1.0'
      },
      capabilities: {
        optOutNotificationMethods: [
          'thread/started',
          'item/started',
          'item/completed',
          'item/agentMessage/delta'
        ]
      }
    })
    if (!isRecord(initialized) || typeof initialized.codexHome !== 'string') {
      throw new Error('Codex App Server initialize response did not include codexHome')
    }
    this.notify('initialized', {})
    return { codexHome: initialized.codexHome }
  }

  async readRateLimits(): Promise<RateLimitBucket[]> {
    const result = await this.request('account/rateLimits/read')
    return parseRateLimitBuckets(result)
  }

  async readAccountUsage(): Promise<AccountUsageResult> {
    const result = await this.request('account/usage/read')
    if (!isRecord(result)) throw new Error('Invalid account/usage/read response')
    const summary = isRecord(result.summary) ? result.summary : {}
    const buckets: Record<string, string> = {}
    if (Array.isArray(result.dailyUsageBuckets)) {
      for (const rawBucket of result.dailyUsageBuckets) {
        if (!isRecord(rawBucket) || typeof rawBucket.startDate !== 'string') continue
        const tokens = tokenNumberToString(rawBucket.tokens)
        if (tokens !== null) buckets[rawBucket.startDate] = tokens
      }
    }

    return {
      lifetimeTokens: tokenNumberToString(summary.lifetimeTokens),
      peakDailyTokens: tokenNumberToString(summary.peakDailyTokens),
      dailyUsageBuckets: buckets
    }
  }

  async stop(): Promise<void> {
    this.stopping = true
    const child = this.process
    this.process = null
    this.reader?.close()
    this.reader = null
    this.rejectPending(new Error('Codex App Server stopped'))
    if (!child || child.exitCode !== null) return

    child.stdin.end()
    const exited = once(child, 'exit').then(() => true)
    const timedOut = new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000))
    if (!(await Promise.race([exited, timedOut])) && child.exitCode === null) {
      child.kill()
      await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1_000))])
    }
  }

  private request(method: string, params?: unknown, timeoutMs = 15_000): Promise<unknown> {
    const child = this.process
    if (!child || child.exitCode !== null) {
      return Promise.reject(new Error('Codex App Server is not running'))
    }
    const id = this.nextRequestId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`${method} timed out`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.write({ method, id, ...(params === undefined ? {} : { params }) })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.write({ method, ...(params === undefined ? {} : { params }) })
  }

  private write(message: unknown): void {
    const child = this.process
    if (!child || child.exitCode !== null) throw new Error('Codex App Server is not running')
    child.stdin.write(`${JSON.stringify(message)}\n`)
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    if (!isRecord(message)) return

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer)
      this.pending.delete(message.id)
      if (isRecord(message.error)) {
        pending.reject(new Error(String(message.error.message ?? 'Codex App Server request failed')))
      } else {
        pending.resolve(message.result)
      }
      return
    }

    if (message.method === 'account/rateLimits/updated') {
      this.emit('rateLimitsUpdated')
    }
  }

  private handleExit(error: Error): void {
    if (!this.process && this.stopping) return
    this.process = null
    this.reader?.close()
    this.reader = null
    this.rejectPending(error)
    if (!this.stopping) {
      const suffix = this.stderrTail.trim() ? `: ${this.stderrTail.trim()}` : ''
      this.emit('disconnected', new Error(`${error.message}${suffix}`))
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export function parseRateLimitBuckets(result: unknown): RateLimitBucket[] {
  if (!isRecord(result)) return []
  const buckets: RateLimitBucket[] = []
  if (isRecord(result.rateLimitsByLimitId)) {
    for (const raw of Object.values(result.rateLimitsByLimitId)) {
      const parsed = parseRateLimitBucket(raw)
      if (parsed) buckets.push(parsed)
    }
  }
  if (buckets.length === 0) {
    const parsed = parseRateLimitBucket(result.rateLimits)
    if (parsed) buckets.push(parsed)
  }
  return buckets.sort((left, right) => {
    if (left.limitId === 'codex') return -1
    if (right.limitId === 'codex') return 1
    return left.limitId.localeCompare(right.limitId)
  })
}

function parseRateLimitBucket(value: unknown): RateLimitBucket | null {
  if (!isRecord(value) || typeof value.limitId !== 'string') return null
  return {
    limitId: value.limitId,
    limitName: typeof value.limitName === 'string' ? value.limitName : null,
    primary: parseRateWindow(value.primary),
    secondary: parseRateWindow(value.secondary),
    planType: typeof value.planType === 'string' ? value.planType : null,
    rateLimitReachedType:
      typeof value.rateLimitReachedType === 'string' ? value.rateLimitReachedType : null
  }
}

function parseRateWindow(value: unknown): RateLimitWindow | null {
  if (!isRecord(value)) return null
  const usedPercent = finiteNumber(value.usedPercent)
  const windowDurationMins = finiteNumber(value.windowDurationMins)
  const resetsAt = finiteNumber(value.resetsAt)
  if (usedPercent === null || windowDurationMins === null || resetsAt === null) return null
  return { usedPercent, windowDurationMins, resetsAt }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function tokenNumberToString(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return String(value)
  }
  if (typeof value === 'string' && /^\d+$/u.test(value)) return value
  return null
}
