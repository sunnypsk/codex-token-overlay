import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createDefaultState, createEmptyStoredModelAggregate, migrateLegacyState, StateStore } from '../../src/main/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('state v2 generation persistence', () => {
  it('migrates v1 settings/account and marks old sessions legacy-unpriced', () => {
    const migrated = migrateLegacyState({
      version: 1,
      settings: { alwaysOnTop: false, startAtLogin: true, expanded: true },
      window: { x: 10, y: 20 },
      sessions: { session: { sessionId: 'session', path: 'missing.jsonl', daily: {}, cycles: {}, eventCount: 0, parseErrors: 0, offset: 0, fileSize: 0, modifiedAtMs: 0, currentModel: 'gpt-5.4', lastCumulative: null } },
      account: { lifetimeTokens: '5', peakDailyTokens: null, dailyUsageBuckets: {}, syncedAt: null },
      rateLimits: [],
      rateLimitsSyncedAt: null,
      priceBook: createDefaultState().priceBook,
      localIndexedAt: null
    })
    expect(migrated.version).toBe(2)
    expect(migrated.settings.expanded).toBe(true)
    expect(migrated.sessions.session?.legacyUnpriced).toBe(true)
    expect(migrated.unreconciledSessions).toContain('session')
  })

  it('loads the previous generation when the active checksum is corrupt', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-state-v2-'))
    roots.push(root)
    const file = join(root, 'usage-state.json')
    const first = new StateStore(file)
    await first.load()
    first.update((state) => { state.settings.expanded = true }, true)
    await first.save()
    first.update((state) => { state.settings.expanded = false }, true)
    await first.save()
    const manifestPath = `${file}.manifest.json`
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as { active: { file: string } }
    await writeFile(join(`${file}.generations`, manifest.active.file), 'corrupt\n', 'utf8')
    const recovered = new StateStore(file)
    await recovered.load()
    expect(recovered.get().version).toBe(2)
    expect(recovered.get().settings.expanded).toBe(true)
  })

  it('rotates obsolete v2 generations without touching the legacy file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-state-rotation-v2-'))
    roots.push(root)
    const file = join(root, 'usage-state.json')
    await writeFile(file, 'legacy-untouched\n', 'utf8')
    const store = new StateStore(file)
    await store.load()
    for (let index = 0; index < 5; index += 1) {
      store.update((state) => { state.settings.expanded = index % 2 === 0 }, true)
      await store.save()
    }
    const generations = (await readdir(`${file}.generations`)).filter((name) => name.endsWith('.json'))
    expect(generations.length).toBeLessThanOrEqual(2)
    expect(await readFile(file, 'utf8')).toBe('legacy-untouched\n')
  })

  it('normalizes persisted processing work back to pending after a restart', () => {
    const migrated = migrateLegacyState({
      ...createDefaultState(),
      indexRevision: 3,
      pendingPricingQueue: [
        { id: 'processing', sessionId: 'session', filePath: 'session.jsonl', capturedSize: 10, capturedOffset: 0, queuedAt: '', status: 'processing' },
        { id: 'complete', sessionId: 'session', filePath: 'session.jsonl', capturedSize: 10, capturedOffset: 0, queuedAt: '', status: 'complete' },
        { id: 'aborted', sessionId: 'session', filePath: 'session.jsonl', capturedSize: 10, capturedOffset: 0, queuedAt: '', status: 'aborted' }
      ]
    })
    expect(migrated.pendingPricingQueue).toHaveLength(1)
    expect(migrated.pendingPricingQueue[0]?.status).toBe('pending')
  })

  it('keeps active-v2 safe settings/account while preferring one untouched v1 aggregate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-state-v1-v2-'))
    roots.push(root)
    const file = join(root, 'usage-state.json')
    const writer = new StateStore(file)
    await writer.load()
    const activeAggregate = createEmptyStoredModelAggregate()
    activeAggregate.short = { input: '200', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '200' }
    writer.update((state) => {
      state.indexRevision = 0
      state.settings.expanded = true
      state.account.lifetimeTokens = 'active-account'
      state.sessions.session = {
        sessionId: 'session', path: 'session.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
        currentModel: 'gpt-5.6-sol', lastCumulative: null, daily: { '2026-08-19': { models: { 'gpt-5.6-sol': activeAggregate } } },
        cycles: {}, eventCount: 1, parseErrors: 0
      }
    })
    await writer.save()
    const legacyAggregate = createEmptyStoredModelAggregate()
    legacyAggregate.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    await writeFile(file, `${JSON.stringify({
      version: 1,
      settings: { alwaysOnTop: false, startAtLogin: false, expanded: false },
      window: { x: 1, y: 2 },
      sessions: {
        session: {
          sessionId: 'session', path: 'session.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
          currentModel: 'gpt-5.6-sol', lastCumulative: null, daily: { '2026-08-19': { models: { 'gpt-5.6-sol': legacyAggregate } } },
          cycles: {}, eventCount: 1, parseErrors: 0
        }
      },
      account: { lifetimeTokens: 'legacy-account', peakDailyTokens: null, dailyUsageBuckets: {}, syncedAt: null },
      rateLimits: [], rateLimitsSyncedAt: null, priceBook: createDefaultState().priceBook, localIndexedAt: null
    })}\n`, 'utf8')
    const recovered = new StateStore(file)
    await recovered.load()
    expect(recovered.get().settings.expanded).toBe(true)
    expect(recovered.get().account.lifetimeTokens).toBe('active-account')
    expect(recovered.get().sessions.session?.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(recovered.get().sessions.session?.daily['2026-08-19']?.models['gpt-5.6-sol']).toBeUndefined()
  })
})
