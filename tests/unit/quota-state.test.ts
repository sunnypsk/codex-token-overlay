import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { QuotaStateStore } from '../../src/main/quota-state.js'
import { StateStore } from '../../src/main/state.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('quota state migration', () => {
  it('imports preferences and limits without modifying the old usage state', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-quota-migration-'))
    roots.push(root)
    const legacyPath = join(root, 'usage-state.json')
    const quotaPath = join(root, 'quota-state.json')
    const legacy = new StateStore(legacyPath)
    await legacy.load()
    legacy.update((state) => {
      state.settings = { alwaysOnTop: false, startAtLogin: false, expanded: true }
      state.window = { x: 85, y: 120 }
      state.rateLimitsSyncedAt = '2026-09-23T12:00:00.000Z'
      state.rateLimits = [{
        limitId: 'codex', limitName: 'Codex', planType: null, rateLimitReachedType: null,
        primary: { usedPercent: 37, windowDurationMins: 10_080, resetsAt: 2_000_000_000 }, secondary: null
      }]
      state.account.lifetimeTokens = '123456'
    })
    await legacy.save()
    const manifestPath = `${legacyPath}.manifest.json`
    const beforeManifest = await readFile(manifestPath)
    const beforeGenerations = await readdir(`${legacyPath}.generations`)

    const quota = new QuotaStateStore(quotaPath, legacyPath)
    const imported = await quota.load()
    expect(imported.settings).toEqual({ alwaysOnTop: false, startAtLogin: false, expanded: true })
    expect(imported.window).toEqual({ x: 85, y: 120 })
    expect(imported.rateLimits[0]?.primary?.usedPercent).toBe(37)
    expect(imported.rateLimitsSyncedAt).toBe('2026-09-23T12:00:00.000Z')

    const saved = JSON.parse(await readFile(quotaPath, 'utf8')) as Record<string, unknown>
    expect(Object.keys(saved).sort()).toEqual(['rateLimits', 'rateLimitsSyncedAt', 'settings', 'version', 'window'])
    expect(JSON.stringify(saved)).not.toContain('123456')
    expect(await readFile(manifestPath)).toEqual(beforeManifest)
    expect(await readdir(`${legacyPath}.generations`)).toEqual(beforeGenerations)

    quota.update((state) => { state.settings.expanded = false }, true)
    await quota.save()
    const reloaded = new QuotaStateStore(quotaPath, legacyPath)
    expect((await reloaded.load()).settings.expanded).toBe(false)
    expect(await readFile(manifestPath)).toEqual(beforeManifest)
  })
})
