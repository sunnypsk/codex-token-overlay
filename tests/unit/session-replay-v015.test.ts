import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionIndexer, type SessionReadStreamFactory } from '../../src/main/session-indexer.js'
import { ATTRIBUTION_REVISION, createDefaultState, createEmptyStoredModelAggregate, STATE_INDEX_REVISION, StateStore } from '../../src/main/state.js'
import { buildPeriod } from '../../src/main/aggregation.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('v0.1.5 raw replay and attribution', () => {
  it('uses the real thread_settings envelope, raw-wins unequal legacy totals, and does not double-count appends', async () => {
    const { root, file, sessionId } = await makeLegacySession(100)
    await writeFile(file, `${settingsLine('priority')}${tokenLine(200)}\n`, 'utf8')
    const statePath = join(root, 'usage-state.json')
    const store = new StateStore(statePath)
    await store.load()
    const observedBeforeCutover: string[] = []
    const indexer = new SessionIndexer(root, store, 0, (progress) => {
      if (progress.totalFiles === 1 && progress.indexedFiles === 0) {
        observedBeforeCutover.push(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total ?? 'missing')
      }
    })

    await indexer.scan()
    const replayed = store.get().sessions[sessionId]!
    expect(observedBeforeCutover).toContain('100')
    expect(replayed.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(replayed.legacyDaily).toBeUndefined()
    expect(store.get().rebuild.replayedSessions).toBe(1)
    expect(store.get().rebuild.retainedLegacySessions).toBe(0)
    expect(store.get().rebuild.rawTokenDelta).toBe('100')
    expect(store.get().rebuild.mode).toBe('background-replay')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00.000Z'), Date.parse('2026-08-19T04:00:00.000Z'), store.get())
    expect(period.cost.fastRateCoveragePercent).toBe(100)

    await appendFile(file, `${tokenLine(250)}\n`, 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('250')
    await indexer.scan('periodic')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
  })

  it('retains a legacy projection when the raw file has no valid cumulative token event', async () => {
    const { root, file, sessionId } = await makeLegacySession(100)
    await writeFile(file, `${JSON.stringify({ timestamp: '2026-08-19T02:00:00.000Z', type: 'event_msg', payload: { type: 'turn_context', payload: {} } })}\n`, 'utf8')
    const store = new StateStore(join(root, 'usage-state.json'))
    await store.load()
    const raw = await readFile(file, 'utf8')
    let readCalls = 0
    const indexer = new SessionIndexer(root, store, 0, () => undefined, (() => {
      readCalls += 1
      return Readable.from([raw])
    }))
    await indexer.scan()
    const retained = store.get().sessions[sessionId]!
    expect(retained.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(retained.legacyDaily).toBeUndefined()
    expect(retained.legacyUnpriced).toBe(true)
    expect(store.get().rebuild.retainedLegacySessions).toBe(1)
    expect(store.get().rebuild.failureDiagnostics).toContain('raw-invalid')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
    const callsAfterReplay = readCalls
    await indexer.scan('periodic')
    expect(readCalls).toBe(callsAfterReplay)
    expect(store.get().pendingPricingQueue).toHaveLength(0)
  })

  it('retains an exact split legacy/current composite when raw replay is invalid or missing', async () => {
    const first = await makeSplitLegacySession()
    const firstStore = new StateStore(join(first.root, 'usage-state.json'))
    await firstStore.load()
    await writeFile(first.file, `${settingsLine('priority')}not-a-token\n`, 'utf8')
    await new SessionIndexer(first.root, firstStore, 0, () => undefined).scan()
    const invalid = firstStore.get().sessions[first.sessionId]!
    expect(invalid.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(invalid.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('25')
    expect(invalid.legacyCycles?.legacy?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(invalid.cycles.current?.models['gpt-5.6-sol']?.short.total).toBe('25')
    expect(invalid.legacyEventCount).toBe(3)
    expect(invalid.eventCount).toBe(2)
    expect(firstStore.get().rebuild.replayedSessions).toBe(0)
    expect(firstStore.get().rebuild.retainedLegacySessions).toBe(1)

    const second = await makeSplitLegacySession()
    const secondStore = new StateStore(join(second.root, 'usage-state.json'))
    await secondStore.load()
    await rm(second.file)
    await new SessionIndexer(second.root, secondStore, 0, () => undefined).scan()
    const missing = secondStore.get().sessions[second.sessionId]!
    expect(missing.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(missing.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('25')
    expect(missing.legacyEventCount).toBe(3)
    expect(missing.eventCount).toBe(2)
    expect(secondStore.get().rebuild.replayedSessions).toBe(0)
    expect(secondStore.get().rebuild.retainedLegacySessions).toBe(1)
  })

  it('ignores a mismatched persisted replay floor during full revision raw replay', async () => {
    const { root, file, sessionId } = await makeLegacySession(100)
    await writeFile(file, `${settingsLine('priority')}${tokenLine(200)}\n`, 'utf8')
    const store = new StateStore(join(root, 'usage-state.json'))
    await store.load()
    store.get().sessions[sessionId]!.baselineOffset = 1
    store.get().sessions[sessionId]!.baselinePrefixFingerprint = 'mismatched-floor'
    store.get().sessions[sessionId]!.baselineCumulative = { input: '1', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '1' }
    store.get().sessions[sessionId]!.baselineModel = 'wrong-model'
    store.get().sessions[sessionId]!.baselineServiceTier = 'unknown'
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const replayed = store.get().sessions[sessionId]!
    expect(replayed.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(replayed.legacyDaily).toBeUndefined()
    expect(store.get().rebuild.replayedSessions).toBe(1)
    expect(store.get().rebuild.rawTokenDelta).toBe('100')
  })

  it('retains the same split composite across two unstable raw attempts', async () => {
    const { root, file, sessionId } = await makeSplitLegacySession()
    await writeFile(file, `${settingsLine('priority')}${tokenLine(200)}\n`, 'utf8')
    const store = new StateStore(join(root, 'usage-state.json'))
    await store.load()
    const unstableFactory = ((path: string) => Readable.from((async function* () {
      const current = await readFile(path, 'utf8')
      await writeFile(path, `${current} `, 'utf8')
      yield current
    })())) as SessionReadStreamFactory
    const indexer = new SessionIndexer(root, store, 0, () => undefined, unstableFactory)
    await indexer.scan()
    const first = store.get().sessions[sessionId]!
    expect(first.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('25')
    expect(first.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(first.fullRawReplayPending).toBe(true)
    expect(store.get().rebuild.replayedSessions).toBe(0)
    expect(store.get().rebuild.failureDiagnostics).toContain('raw-unstable')

    await indexer.scan('manual')
    const second = store.get().sessions[sessionId]!
    expect(second.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('25')
    expect(second.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(second.eventCount).toBe(2)
    expect(second.legacyEventCount).toBe(3)
    expect(second.fullRawReplayPending).toBe(true)
  })

  it('discards a full sidecar only after all concurrent workers settle', async () => {
    const first = await makeLegacySession(100)
    const secondId = '01a00000-0000-7000-8000-000000000116'
    const secondFile = join(first.root, 'sessions', '2026', '08', '19', `rollout-${secondId}.jsonl`)
    await writeFile(first.file, `${settingsLine('priority')}${tokenLine(200)}\n`, 'utf8')
    await writeFile(secondFile, `${settingsLine('priority')}${tokenLine(300)}\n`, 'utf8')
    const statePath = join(first.root, 'usage-state.json')
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    persisted.sessions[secondId] = { ...persisted.sessions[first.sessionId], sessionId: secondId, path: secondFile }
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`, 'utf8')
    const store = new StateStore(statePath)
    await store.load()
    const projection = (session: Record<string, any>) => JSON.stringify({
      daily: session.daily,
      legacyDaily: session.legacyDaily,
      cycles: session.cycles,
      legacyCycles: session.legacyCycles,
      eventCount: session.eventCount,
      legacyEventCount: session.legacyEventCount
    })
    const before = Object.fromEntries(Object.entries(store.get().sessions).map(([id, session]) => [id, projection(session as Record<string, any>)]))
    const failingAndDelayed = ((path: string) => {
      if (path === first.file) return Readable.from((async function* () { throw new Error('early worker failure') })())
      return Readable.from((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 80))
        yield await readFile(path, 'utf8')
      })())
    }) as SessionReadStreamFactory
    const indexer = new SessionIndexer(first.root, store, 0, () => undefined, failingAndDelayed)
    await indexer.scan()
    const after = Object.fromEntries(Object.entries(store.get().sessions).map(([id, session]) => [id, projection(session as Record<string, any>)]))
    expect(after).toEqual(before)
    await new Promise((resolve) => setTimeout(resolve, 120))
    await store.save()
    const afterDelayedSave = Object.fromEntries(Object.entries(store.get().sessions).map(([id, session]) => [id, projection(session as Record<string, any>)]))
    expect(afterDelayedSave).toEqual(before)
  })

  it('barriers incremental failure before stop or a next scan can complete', async () => {
    const first = await makeLegacySession(100)
    const secondId = '01a00000-0000-7000-8000-000000000117'
    const secondFile = join(first.root, 'sessions', '2026', '08', '19', `rollout-${secondId}.jsonl`)
    await writeFile(first.file, `${settingsLine('standard')}${tokenLine(200)}\n`, 'utf8')
    await writeFile(secondFile, `${settingsLine('standard')}${tokenLine(300)}\n`, 'utf8')
    const statePath = join(first.root, 'usage-state.json')
    const persisted = JSON.parse(await readFile(statePath, 'utf8')) as Record<string, any>
    persisted.sessions[secondId] = { ...persisted.sessions[first.sessionId], sessionId: secondId, path: secondFile }
    await writeFile(statePath, `${JSON.stringify(persisted)}\n`, 'utf8')
    const store = new StateStore(statePath)
    await store.load()
    await new SessionIndexer(first.root, store, 0, () => undefined).scan()
    await appendFile(first.file, `${tokenLine(250)}\n`, 'utf8')
    await appendFile(secondFile, `${tokenLine(350)}\n`, 'utf8')
    const failingAndDelayed = ((path: string) => {
      if (path === first.file) return Readable.from((async function* () { throw new Error('incremental early failure') })())
      return Readable.from((async function* () {
        await new Promise((resolve) => setTimeout(resolve, 120))
        yield await readFile(path, 'utf8')
      })())
    }) as SessionReadStreamFactory
    const failing = new SessionIndexer(first.root, store, 0, () => undefined, failingAndDelayed)
    let settled = false
    const startedAt = Date.now()
    const scan = failing.scan()
    void scan.then(() => { settled = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(settled).toBe(false)
    const overlap = failing.scan('manual')
    expect(overlap).toBe(scan)
    let stopped = false
    const stop = failing.stop().then(() => { stopped = true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(stopped).toBe(false)
    await Promise.all([scan, stop])
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(100)
    expect(store.get().sessions[first.sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(store.get().sessions[secondId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('350')
    expect(store.get().sessions[secondId]?.eventCount).toBe(2)
    expect(store.get().pendingPricingQueue.some((entry) => entry.sessionId === first.sessionId && entry.status === 'pending')).toBe(true)
    const after = JSON.stringify({
      first: store.get().sessions[first.sessionId]?.daily,
      second: store.get().sessions[secondId]?.daily
    })
    await new Promise((resolve) => setTimeout(resolve, 150))
    await store.save()
    expect(JSON.stringify({
      first: store.get().sessions[first.sessionId]?.daily,
      second: store.get().sessions[secondId]?.daily
    })).toBe(after)
  })

  it('replays a missingRaw candidate that reappears on periodic scan with identical metadata', async () => {
    const { root, file, sessionId } = await makeSplitLegacySession()
    const raw = `${settingsLine('priority')}${tokenLine(200)}\n`
    await writeFile(file, raw, 'utf8')
    const initialStats = await stat(file)
    await utimes(file, initialStats.atime, new Date(Math.trunc(initialStats.mtimeMs)))
    const originalStats = await stat(file)
    const store = new StateStore(join(root, 'usage-state.json'))
    await store.load()
    const session = store.get().sessions[sessionId]!
    session.fileSize = originalStats.size
    session.modifiedAtMs = originalStats.mtimeMs
    session.offset = originalStats.size
    session.missingRaw = true
    session.fullRawReplayPending = true
    session.legacyUnpriced = true
    session.unreconciled = true
    await rm(file)
    let readCalls = 0
    const factory = (() => {
      readCalls += 1
      return Readable.from([raw])
    }) as SessionReadStreamFactory
    const indexer = new SessionIndexer(root, store, 0, () => undefined, factory)
    await indexer.scan('periodic')
    expect(readCalls).toBe(0)

    await writeFile(file, raw, 'utf8')
    await utimes(file, originalStats.atime, originalStats.mtime)
    const recreatedStats = await stat(file)
    expect(recreatedStats.size).toBe(originalStats.size)
    expect(recreatedStats.mtimeMs).toBe(originalStats.mtimeMs)
    await indexer.scan('periodic')
    const replayed = store.get().sessions[sessionId]!
    expect(readCalls).toBe(1)
    expect(replayed.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(replayed.legacyDaily).toBeUndefined()
    expect(replayed.fullRawReplayPending).toBeUndefined()
    expect(replayed.missingRaw).toBe(false)
    expect(store.get().rebuild.replayedSessions).toBe(1)
  })

  it('retries a failed split migration from byte zero and replaces the composite on stable valid raw', async () => {
    const { root, file, sessionId } = await makeSplitLegacySession()
    await writeFile(file, `${settingsLine('priority')}not-a-token\n`, 'utf8')
    const store = new StateStore(join(root, 'usage-state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.fullRawReplayPending).toBe(true)
    expect(store.get().indexRevision).toBe(STATE_INDEX_REVISION)
    expect(store.get().rebuild.replayedSessions).toBe(0)

    const restarted = new StateStore(join(root, 'usage-state.json'))
    await restarted.load()
    expect(restarted.get().sessions[sessionId]?.fullRawReplayPending).toBe(true)
    await writeFile(file, `${settingsLine('priority')}${tokenLine(200)}\n`, 'utf8')
    await new SessionIndexer(root, restarted, 0, () => undefined).scan('manual')
    const replayed = restarted.get().sessions[sessionId]!
    expect(replayed.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(replayed.legacyDaily).toBeUndefined()
    expect(replayed.legacyCycles).toBeUndefined()
    expect(replayed.fullRawReplayPending).toBeUndefined()
    expect(restarted.get().rebuild.replayedSessions).toBe(1)
    expect(restarted.get().rebuild.retainedLegacySessions).toBe(0)
    expect(restarted.get().rebuild.rawTokenDelta).toBe('75')
  })

  it('normalizes direct, thread-settings, settings, and info precedence with explicit unknown clearing', async () => {
    const { sessionIndexerInternals } = await import('../../src/main/session-indexer.js')
    expect(sessionIndexerInternals.extractAttribution({ model: 'direct', thread_settings: { model: 'thread', service_tier: 'priority' }, settings: { model: 'settings', service_tier: 'standard' }, info: { model: 'info', service_tier: 'fast' } })).toMatchObject({ model: 'direct', serviceTier: 'fast', modelPresent: true, serviceTierPresent: true })
    expect(sessionIndexerInternals.extractAttribution({ thread_settings: { model: 'thread', service_tier: null }, settings: { model: 'settings', service_tier: 'priority' } })).toMatchObject({ model: 'thread', serviceTier: 'unknown' })
    expect(sessionIndexerInternals.extractAttribution({ settings: { model: 'settings', service_tier: 'standard' }, info: { model: 'info', service_tier: 'priority' } })).toMatchObject({ model: 'settings', serviceTier: 'standard' })
  })
})

async function makeLegacySession(total: number): Promise<{ root: string; file: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-v015-replay-'))
  roots.push(root)
  const sessionDir = join(root, 'sessions', '2026', '08', '19')
  await mkdir(sessionDir, { recursive: true })
  const sessionId = '01a00000-0000-7000-8000-000000000115'
  const file = join(sessionDir, `rollout-${sessionId}.jsonl`)
  const aggregate = createEmptyStoredModelAggregate()
  aggregate.short = { input: String(total), cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: String(total) }
  const state = createDefaultState()
  state.indexRevision = STATE_INDEX_REVISION - 1
  state.attributionRevision = ATTRIBUTION_REVISION - 1
  state.sessions[sessionId] = {
    sessionId,
    path: file,
    offset: 0,
    fileSize: 0,
    modifiedAtMs: 0,
    currentModel: 'gpt-5.6-sol',
    currentServiceTier: 'standard',
    lastCumulative: null,
    daily: { '2026-08-19': { models: { 'gpt-5.6-sol': aggregate } } },
    cycles: {},
    eventCount: 1,
    parseErrors: 0
  }
  await writeFile(join(root, 'usage-state.json'), `${JSON.stringify(state)}\n`, 'utf8')
  await writeFile(file, '', 'utf8')
  return { root, file, sessionId }
}

async function makeSplitLegacySession(): Promise<{ root: string; file: string; sessionId: string }> {
  const result = await makeLegacySession(100)
  const content = JSON.parse(await readFile(join(result.root, 'usage-state.json'), 'utf8')) as Record<string, any>
  const session = content.sessions[result.sessionId] as Record<string, any>
  const current = createEmptyStoredModelAggregate()
  current.short = { input: '25', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '25' }
  const cycle = (total: string) => ({ limitId: 'codex', resetsAt: 1_800_000_000, windowDurationMins: 10080, models: { 'gpt-5.6-sol': { ...createEmptyStoredModelAggregate(), short: { input: total, cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total } } }, usedPercents: [1], firstSampleAt: '2026-08-19T02:00:00.000Z', lastSampleAt: '2026-08-19T02:00:00.000Z' })
  session.legacyDaily = JSON.parse(JSON.stringify(session.daily))
  session.legacyCycles = { legacy: cycle('100') }
  session.legacyEventCount = 3
  session.daily = { '2026-08-19': { models: { 'gpt-5.6-sol': current } } }
  session.cycles = { current: cycle('25') }
  session.eventCount = 2
  session.currentModel = 'gpt-5.6-sol'
  session.currentServiceTier = 'standard'
  session.baselineOffset = 1
  session.baselinePrefixFingerprint = 'persisted-v014-floor'
  session.baselineCumulative = { input: '1', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '1' }
  session.baselineModel = 'gpt-5.6-sol'
  session.baselineServiceTier = 'standard'
  session.legacyUnpriced = false
  session.unreconciled = false
  await writeFile(join(result.root, 'usage-state.json'), `${JSON.stringify(content)}\n`, 'utf8')
  return result
}

function settingsLine(serviceTier: string): string {
  return `${JSON.stringify({ timestamp: '2026-08-19T02:00:00.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', thread_settings: { model: 'gpt-5.6-sol', service_tier: serviceTier } } })}\n`
}

function tokenLine(total: number): string {
  return JSON.stringify({
    timestamp: '2026-08-19T02:00:01.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: total, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: total, cached_input_tokens: 0, output_tokens: 0, total_tokens: total }
      }
    }
  })
}
