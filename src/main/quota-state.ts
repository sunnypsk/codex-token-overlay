import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { OverlaySettings, RateLimitBucket } from '../shared/contracts.js'
import { parseRateLimitBuckets } from './app-server-client.js'
import { StateStore } from './state.js'

export interface QuotaState {
  version: 1
  settings: OverlaySettings
  window: { x: number | null; y: number | null }
  rateLimits: RateLimitBucket[]
  rateLimitsSyncedAt: string | null
}

export function createDefaultQuotaState(): QuotaState {
  return {
    version: 1,
    settings: { alwaysOnTop: true, startAtLogin: true, expanded: false },
    window: { x: null, y: null },
    rateLimits: [],
    rateLimitsSyncedAt: null
  }
}

/** Keeps the old usage state read-only so an older installer can still use it. */
export class QuotaStateStore {
  private state = createDefaultQuotaState()
  private saveTimer: NodeJS.Timeout | null = null
  private saving: Promise<void> | null = null
  private revision = 0
  private savedRevision = -1

  constructor(
    private readonly filePath: string,
    private readonly legacyFilePath: string
  ) {}

  async load(): Promise<QuotaState> {
    try {
      const parsed = normalizeQuotaState(JSON.parse(await readFile(this.filePath, 'utf8')))
      if (parsed) {
        this.state = parsed
        this.savedRevision = this.revision
        return this.state
      }
      console.warn('Invalid quota state; trying legacy settings')
    } catch (error) {
      if (!isMissingFile(error)) console.warn('Unable to load quota state:', error)
    }

    const legacy = await new StateStore(this.legacyFilePath).load()
    this.state = {
      version: 1,
      settings: { ...legacy.settings },
      window: { ...legacy.window },
      rateLimits: normalizeRateLimits(legacy.rateLimits),
      rateLimitsSyncedAt: validTimestamp(legacy.rateLimitsSyncedAt)
    }
    await this.save()
    return this.state
  }

  get(): QuotaState {
    return this.state
  }

  update(mutator: (state: QuotaState) => void, saveImmediately = false): void {
    mutator(this.state)
    this.revision += 1
    if (saveImmediately) void this.save().catch((error) => console.error('Unable to save quota state:', error))
    else this.scheduleSave()
  }

  private scheduleSave(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      void this.save().catch((error) => console.error('Unable to save quota state:', error))
    }, 750)
  }

  async save(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    while (this.savedRevision < this.revision) {
      if (this.saving) {
        await this.saving
        continue
      }
      const revision = this.revision
      const contents = `${JSON.stringify(this.state)}\n`
      this.saving = (async () => {
        await mkdir(dirname(this.filePath), { recursive: true })
        const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`
        try {
          await writeFile(temporaryPath, contents, 'utf8')
          await rename(temporaryPath, this.filePath)
          this.savedRevision = revision
        } catch (error) {
          await rm(temporaryPath, { force: true }).catch(() => undefined)
          throw error
        }
      })().finally(() => {
        this.saving = null
      })
      await this.saving
    }
  }
}

function normalizeQuotaState(value: unknown): QuotaState | null {
  if (!isRecord(value) || value.version !== 1 || !isRecord(value.settings) || !isRecord(value.window)) return null
  const settings = value.settings
  const window = value.window
  if (
    typeof settings.alwaysOnTop !== 'boolean' ||
    typeof settings.startAtLogin !== 'boolean' ||
    typeof settings.expanded !== 'boolean' ||
    !validCoordinate(window.x) || !validCoordinate(window.y) ||
    !Array.isArray(value.rateLimits)
  ) return null
  return {
    version: 1,
    settings: {
      alwaysOnTop: settings.alwaysOnTop,
      startAtLogin: settings.startAtLogin,
      expanded: settings.expanded
    },
    window: { x: window.x as number | null, y: window.y as number | null },
    rateLimits: normalizeRateLimits(value.rateLimits),
    rateLimitsSyncedAt: validTimestamp(value.rateLimitsSyncedAt)
  }
}

function normalizeRateLimits(value: unknown): RateLimitBucket[] {
  if (!Array.isArray(value)) return []
  return parseRateLimitBuckets({ rateLimitsByLimitId: Object.fromEntries(value.map((bucket, index) => [index, bucket])) })
}

function validCoordinate(value: unknown): boolean {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function validTimestamp(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}
