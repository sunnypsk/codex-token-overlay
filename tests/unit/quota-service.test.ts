import { EventEmitter } from 'node:events'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { QuotaService } from '../../src/main/quota-service.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('percentage-only quota service', () => {
  it('requests rate limits on connect, notification, and manual refresh without tracking usage or prices', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-quota-service-'))
    roots.push(root)
    const now = Date.now()
    const client = Object.assign(new EventEmitter(), {
      start: vi.fn(async () => ({ codexHome: root })),
      stop: vi.fn(async () => undefined),
      readRateLimits: vi.fn(async () => [{
        limitId: 'codex', limitName: 'Codex', planType: null, rateLimitReachedType: null,
        primary: { usedPercent: 25, windowDurationMins: 10_080, resetsAt: Math.floor((now + 24 * 60 * 60_000) / 1_000) },
        secondary: null
      }]),
      readAccountUsage: vi.fn()
    })
    const service = new QuotaService(root, {
      findExecutable: async () => 'codex.exe',
      createClient: () => client
    })
    try {
      await service.start()
      await vi.waitFor(() => expect(service.getSnapshot().connection).toBe('online'))
      expect(service.getSnapshot().reset.usedPercent).toBe(25)
      expect(service.getSnapshot().reset.observations).toHaveLength(1)
      expect(client.readRateLimits).toHaveBeenCalledTimes(1)

      client.emit('rateLimitsUpdated')
      await vi.waitFor(() => expect(client.readRateLimits).toHaveBeenCalledTimes(2))
      await service.refresh()
      expect(client.readRateLimits).toHaveBeenCalledTimes(3)
      expect(service.getSnapshot().reset.observations.length).toBeGreaterThanOrEqual(1)
      expect(client.readAccountUsage).not.toHaveBeenCalled()
      expect((await readdir(root)).sort()).toEqual(['quota-state.json'])
    } finally {
      await service.stop()
    }
    expect(client.stop).toHaveBeenCalledTimes(1)
  })
})
