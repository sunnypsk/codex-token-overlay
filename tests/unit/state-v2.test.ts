import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionIndexer } from '../../src/main/session-indexer.js'
import { ATTRIBUTION_REVISION, createDefaultState, createEmptyStoredModelAggregate, migrateLegacyState, STATE_INDEX_REVISION, StateStore } from '../../src/main/state.js'

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

  it('persists the attribution migration marker once and keeps a missing-raw legacy floor across restart', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-attribution-rebuild-v2-'))
    roots.push(root)
    const file = join(root, 'usage-state.json')
    const aggregate = createEmptyStoredModelAggregate()
    aggregate.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    await writeFile(file, `${JSON.stringify({
      ...createDefaultState(),
      indexRevision: STATE_INDEX_REVISION,
      attributionRevision: 2,
      sessions: {
        missing: {
          sessionId: 'missing', path: join(root, 'sessions', 'missing.jsonl'), offset: 0, fileSize: 0, modifiedAtMs: 0,
          currentModel: 'gpt-5.6-sol', lastCumulative: null,
          daily: { '2026-08-19': { models: { 'gpt-5.6-sol': aggregate } } },
          cycles: {}, eventCount: 1, parseErrors: 0
        }
      }
    })}\n`, 'utf8')
    const store = new StateStore(file)
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    expect(store.get().indexRevision).toBe(STATE_INDEX_REVISION)
    expect(store.get().attributionRevision).toBe(ATTRIBUTION_REVISION)
    expect(store.get().rebuild.state).toBe('partial')
    expect(store.get().sessions.missing?.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')

    const restarted = new StateStore(file)
    await restarted.load()
    expect(restarted.get().indexRevision).toBe(STATE_INDEX_REVISION)
    expect(restarted.get().attributionRevision).toBe(ATTRIBUTION_REVISION)
    expect(restarted.get().rebuild.state).toBe('partial')
    await new SessionIndexer(root, restarted, 0, () => undefined).scan()
    expect(restarted.get().sessions.missing?.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
  })

  it('replays a v2 revision-2 unknown-context projection once without double-counting', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-attribution-revision-3-v2-'))
    roots.push(root)
    const file = join(root, 'usage-state.json')
    const sessionId = '01a00000-0000-7000-8000-000000000090'
    const sessionPath = join(root, 'sessions', '2026', '08', '19', `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
    await mkdir(join(root, 'sessions', '2026', '08', '19'), { recursive: true })
    const legacyAggregate = createEmptyStoredModelAggregate()
    legacyAggregate.unknown = { input: '999', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '999' }
    await writeFile(sessionPath, `${tokenLineForTest(100)}\n${tokenLineForTest(150)}\n`, 'utf8')
    await writeFile(file, `${JSON.stringify({
      ...createDefaultState(),
      indexRevision: STATE_INDEX_REVISION,
      attributionRevision: 2,
      sessions: {
        [sessionId]: {
          sessionId,
          path: sessionPath,
          offset: 0,
          fileSize: 0,
          modifiedAtMs: 0,
          currentModel: 'unknown',
          lastCumulative: null,
          daily: { '2026-08-19': { models: { unknown: legacyAggregate } } },
          cycles: {},
          eventCount: 1,
          parseErrors: 0
        }
      }
    })}\n`, 'utf8')

    const store = new StateStore(file)
    await store.load()
    expect(store.get().attributionRevision).toBe(2)
    expect(store.get().rebuild.state).toBe('queued')
    expect(store.get().rebuild.pending).toBe(1)
    expect(store.get().sessions[sessionId]?.legacyDaily?.['2026-08-19']?.models.unknown?.unknown?.total).toBe('999')

    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const converged = store.get().sessions[sessionId]!
    expect(store.get().attributionRevision).toBe(ATTRIBUTION_REVISION)
    expect(store.get().rebuild.state).toBe('complete')
    expect(converged.daily['2026-08-19']?.models.unknown?.unknown?.total).toBe('150')

    await new SessionIndexer(root, store, 0, () => undefined).scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models.unknown?.unknown?.total).toBe('150')
  })
})

function tokenLineForTest(total: number): string {
  return JSON.stringify({
    timestamp: '2026-08-19T02:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total }
      }
    }
  })
}
