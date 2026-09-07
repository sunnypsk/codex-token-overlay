import { appendFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionIndexer, type SessionReadStreamFactory } from '../../src/main/session-indexer.js'
import { createDefaultState, createEmptyStoredModelAggregate, StateStore } from '../../src/main/state.js'
import { buildPeriod } from '../../src/main/aggregation.js'
import { canonicalPricingHash } from '../../src/main/pricing.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session reconciliation v2', () => {
  it('reconciles an old metadata-only fallback and counts a later first usage exactly once', async () => {
    const { file, root, sessionId } = await makeSession(JSON.stringify({ type: 'event_msg', payload: { type: 'token_count', info: null } }))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    store.update(state => {
      const session = state.sessions[sessionId]!
      session.fullRawReplayPending = true
      session.unreconciled = true
      session.legacyUnpriced = true
      session.offset = 0
      state.unreconciledSessions = [sessionId]
      state.rebuild.failureDiagnostics = ['raw-invalid']
    })
    await indexer.scan('initial')
    expect(store.get().rebuild.state).toBe('complete')
    expect(store.get().rebuild.failureDiagnostics).toEqual([])
    expect(store.get().unreconciledSessions).toEqual([])
    expect(store.get().sessions[sessionId]?.offset).toBe((await stat(file)).size)
    const reloaded = new StateStore(join(root, 'state.json'))
    await reloaded.load()
    const resumed = new SessionIndexer(root, reloaded, 0, () => undefined)
    await resumed.scan('initial') // One metadata bootstrap is allowed after reload.
    await resumed.scan('periodic')
    expect(reloaded.get().rebuild.processedFiles).toBe(0)
    await appendFile(file, `${tokenLine(100, 60, 10, 110)}\n`)
    await resumed.scan()
    await resumed.scan()
    expect(reloaded.get().sessions[sessionId]?.lastCumulative?.total).toBe('110')
    expect(reloaded.get().sessions[sessionId]?.eventCount).toBe(1)
  })

  it('retains historical usage when a full replay now contains only metadata', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const original = store.get().sessions[sessionId]!.daily
    await writeFile(file, `${JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })}\n`)
    store.update(state => { state.sessions[sessionId]!.fullRawReplayPending = true })
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily).toEqual(original)
    expect(store.get().rebuild.state).toBe('partial')
    expect(store.get().rebuild.failureDiagnostics).toContain('raw-invalid')
  })

  it('does not accept malformed JSON as a valid empty replay', async () => {
    const { root, sessionId } = await makeSession('{invalid}')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    store.update(state => { state.sessions[sessionId]!.fullRawReplayPending = true })
    await indexer.scan()
    expect(store.get().rebuild.state).toBe('partial')
    expect(store.get().rebuild.failureDiagnostics).toContain('raw-invalid')
  })

  it('replays an actual v1 baseline once, preserves the legacy file, and records the exact raw offset', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(76_240_615, 0, 0, 76_240_615), 'gpt-5.6-sol')
    const statePath = join(root, 'usage-state.json')
    const aggregate = createEmptyStoredModelAggregate()
    aggregate.short = { input: '76240615', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '76240615' }
    const v1 = {
      version: 1,
      settings: { alwaysOnTop: false, startAtLogin: true, expanded: true },
      window: { x: 11, y: 22 },
      sessions: {
        [sessionId]: {
          sessionId,
          path: file,
          offset: 0,
          fileSize: 0,
          modifiedAtMs: 0,
          currentModel: 'gpt-5.6-sol',
          lastCumulative: null,
          daily: { '2026-08-19': { models: { 'gpt-5.6-sol': aggregate } } },
          cycles: {},
          eventCount: 1,
          parseErrors: 0
        }
      },
      account: { lifetimeTokens: '76240615', peakDailyTokens: null, dailyUsageBuckets: {}, syncedAt: null },
      rateLimits: [],
      rateLimitsSyncedAt: null,
      priceBook: createDefaultState().priceBook,
      localIndexedAt: null
    }
    const legacyContent = `${JSON.stringify(v1)}\n`
    await writeFile(statePath, legacyContent, 'utf8')
    const store = new StateStore(statePath)
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const session = store.get().sessions[sessionId]!
    expect(session.daily['2026-08-19']?.models['gpt-5.6-sol']?.long.total).toBe('76240615')
    expect(session.legacyDaily).toBeUndefined()
    expect(session.offset).toBe((await stat(file)).size)
    expect(store.get().rebuild.state).toBe('complete')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
    await rm(file)
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    expect(store.get().rebuild.state).toBe('partial')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
    expect(await readFile(statePath, 'utf8')).toBe(legacyContent)
  })

  it('keeps a missing v1 raw session as an unpriced fallback without an immortal queue item', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-missing-v1-'))
    roots.push(root)
    const statePath = join(root, 'usage-state.json')
    const aggregate = createEmptyStoredModelAggregate()
    aggregate.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    await writeFile(statePath, `${JSON.stringify({
      version: 1,
      settings: { alwaysOnTop: true, startAtLogin: true, expanded: false },
      window: { x: null, y: null },
      sessions: {
        missing: {
          sessionId: 'missing', path: join(root, 'sessions', 'missing.jsonl'), offset: 0, fileSize: 0, modifiedAtMs: 0,
          currentModel: 'gpt-5.6-sol', lastCumulative: null, daily: { '2026-08-19': { models: { 'gpt-5.6-sol': aggregate } } },
          cycles: {}, eventCount: 1, parseErrors: 0
        }
      },
      account: { lifetimeTokens: null, peakDailyTokens: null, dailyUsageBuckets: {}, syncedAt: null },
      rateLimits: [], rateLimitsSyncedAt: null, priceBook: createDefaultState().priceBook, localIndexedAt: null
    })}\n`, 'utf8')
    const store = new StateStore(statePath)
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    expect(store.get().sessions.missing?.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('100')
    expect(store.get().pendingPricingQueue).toHaveLength(0)
    expect(store.get().rebuild.state).toBe('partial')
    expect(store.get().unreconciledSessions).toContain('missing')
  })

  it('reindexes unknown context after a semantic pricing update without changing totals', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(300_000, 0, 0, 300_000), 'gpt-5.4')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const oldBook = createDefaultState().priceBook
    oldBook.models['gpt-5.4'] = {
      ...oldBook.models['gpt-5.4']!,
      long: null,
      longContextThreshold: null,
      longComponent: undefined
    }
    oldBook.payloadSha256 = canonicalPricingHash(oldBook.models)
    store.update((state) => { state.priceBook = oldBook })
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const before = store.get().sessions[sessionId]!
    expect(before.daily['2026-08-19']?.models['gpt-5.4']?.unknown?.total).toBe('300000')
    const totalBefore = before.daily['2026-08-19']?.models['gpt-5.4']?.short.total
      ?? '0'
    const refreshed = createDefaultState().priceBook
    store.update((state) => { state.priceBook = refreshed })
    await indexer.scan()
    const after = store.get().sessions[sessionId]!
    expect(after.daily['2026-08-19']?.models['gpt-5.4']?.unknown?.total ?? '0').toBe('0')
    expect(after.daily['2026-08-19']?.models['gpt-5.4']?.long.total).toBe('300000')
    expect(after.daily['2026-08-19']?.models['gpt-5.4']?.short.total).toBe(totalBefore)
    expect(after.pricingSemanticHash).toBe(refreshed.payloadSha256)
    expect((after.daily['2026-08-19']?.models['gpt-5.4']?.long.total ?? '0')).toBe('300000')
    expect((await stat(file)).size).toBe(after.offset)
  })

  it('rebaselines a rewritten floor before pricing a later 540 cumulative append', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110), 'gpt-5.6-sol')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()

    const original = await readText(file)
    const firstRewrite = rewriteJsonlExact(original, (value) => {
      if (value.payload?.type === 'token_count') {
        value.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
        value.payload.info.last_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
      }
      return value
    })
    const beforeFirstRewrite = await stat(file)
    await writeFile(file, firstRewrite, 'utf8')
    await utimes(file, beforeFirstRewrite.atime, new Date(beforeFirstRewrite.mtimeMs + 1_000))
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.baselineCumulative?.total).toBe('220')

    await appendFile(file, tokenLine(480, 360, 20, 500) + '\n', 'utf8')
    await indexer.scan()
    const currentPrefix = rewriteJsonlExact(await readText(file), (value) => {
      if (value.type === 'turn_context') value.payload.model = 'gpt-5.6'
      return value
    })
    const beforeCurrentRewrite = await stat(file)
    await writeFile(file, currentPrefix, 'utf8')
    await utimes(file, beforeCurrentRewrite.atime, new Date(beforeCurrentRewrite.mtimeMs + 1_000))
    const changedPricing = createDefaultState().priceBook
    changedPricing.models['gpt-5.6'] = { ...changedPricing.models['gpt-5.6']!, longContextThreshold: '1' }
    changedPricing.payloadSha256 = canonicalPricingHash(changedPricing.models)
    store.update((state) => { state.priceBook = changedPricing })
    await indexer.scan()
    const rebaselined = store.get().sessions[sessionId]!
    expect(rebaselined.baselineCumulative?.total).toBe('500')
    expect(rebaselined.baselinePrefixFingerprint).toBeDefined()
    expect(rebaselined.daily['2026-08-19']?.models['gpt-5.6']).toBeUndefined()
    expect(rebaselined.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('390')

    await appendFile(file, tokenLine(520, 400, 20, 540) + '\n', 'utf8')
    await indexer.scan()
    const after = store.get().sessions[sessionId]!
    expect(after.daily['2026-08-19']?.models['gpt-5.6']?.long?.total).toBe('40')
    expect(after.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('390')
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), store.get())
    expect(period.tokens.total).toBe('430')
    expect(period.cost.pricedTokens).toBe('40')
    expect(period.cost.unpricedTokens).toBe('390')
  })

  it('excludes a valid newline-less token tail, then counts it once when newline arrives', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110), 'gpt-5.6-sol')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const rewritten = rewriteJsonlExact(await readText(file), (value) => {
      if (value.payload?.type === 'token_count') {
        value.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
        value.payload.info.last_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
      }
      return value
    })
    const beforeRewrite = await stat(file)
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, beforeRewrite.atime, new Date(beforeRewrite.mtimeMs + 1_000))
    await indexer.scan()
    const floorOffset = store.get().sessions[sessionId]?.baselineOffset
    expect(store.get().sessions[sessionId]?.baselineCumulative?.total).toBe('220')
    expect(floorOffset).toBe((await stat(file)).size)

    const future = tokenLine(480, 360, 20, 500)
    await appendFile(file, future, 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']).toBeUndefined()
    expect(store.get().sessions[sessionId]?.baselineOffset).toBe(floorOffset)

    await appendFile(file, '\n', 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('280')
    expect(store.get().sessions[sessionId]?.lastCumulative?.total).toBe('500')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('280')
  })

  it('detects a same-size content rewrite with changed metadata and fingerprint', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const before = store.get().sessions[sessionId]!
    const original = await readText(file)
    const rewritten = rewriteJsonlExact(original, (value) => {
      if (value.type === 'turn_context') value.payload.model = 'gpt-5.6-sol'
      if (value.payload?.type === 'thread_settings_applied') value.payload.settings.service_tier = 'priority'
      if (value.payload?.type === 'token_count') {
        value.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
        value.payload.info.last_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
      }
      return value
    })
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    expect(rewritten.split(/\n/).length).toBe(original.split(/\n/).length)
    const beforeRewrite = await stat(file)
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, beforeRewrite.atime, new Date(beforeRewrite.mtimeMs + 1_000))
    expect((await stat(file)).size).toBe(Buffer.byteLength(original))
    await indexer.scan()
    const after = store.get().sessions[sessionId]!
    expect(after.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe(before.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total)
    expect(after.daily['2026-08-19']?.models['gpt-5.6-sol']).toBeUndefined()
    expect(after.unreconciled).toBe(false)
    expect(after.legacyUnpriced).toBe(false)
    await appendFile(file, tokenLine(240, 120, 20, 260) + '\n', 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('110')
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('40')
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), store.get())
    expect(period.tokens.total).toBe('150')
    expect(period.cost.pricedTokens).toBe('40')
    expect(period.cost.unpricedTokens).toBe('110')
    const changedPricing = createDefaultState().priceBook
    changedPricing.models['gpt-5.6-sol'] = { ...changedPricing.models['gpt-5.6-sol']!, longContextThreshold: '1' }
    changedPricing.payloadSha256 = canonicalPricingHash(changedPricing.models)
    store.update((state) => { state.priceBook = changedPricing })
    await indexer.scan()
    const reclassified = store.get().sessions[sessionId]!
    expect(reclassified.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('110')
    expect(reclassified.daily['2026-08-19']?.models['gpt-5.6-sol']?.long.total).toBe('40')
    const afterPricing = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), store.get())
    expect(afterPricing.tokens.total).toBe('150')
    expect(afterPricing.cost.pricedTokens).toBe('40')
    expect(afterPricing.cost.unpricedTokens).toBe('110')
  })

  it('rejects a unique cumulative anchor when metadata before it changed', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110), 'gpt-5.6-sol')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const original = await readText(file)
    const rewritten = rewriteJsonlExact(original, (value) => {
      if (value.type === 'turn_context') value.payload.model = 'gpt-5.4-sol'
      if (value.payload?.type === 'thread_settings_applied') value.payload.settings.service_tier = 'priority'
      return value
    })
    expect(Buffer.byteLength(original)).toBe(Buffer.byteLength(rewritten))
    const beforeRewrite = await stat(file)
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, beforeRewrite.atime, new Date(beforeRewrite.mtimeMs + 1_000))
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.unreconciled).toBe(false)
    expect(store.get().sessions[sessionId]?.legacyUnpriced).toBe(false)
  })

  it('does not reconcile a trailing-partial file after its processed prefix changes', async () => {
    const { file, root, sessionId } = await makeSession(`${tokenLine(100, 60, 10, 110)}\npartial`, 'gpt-5.6-sol', true)
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const originalStats = await stat(file)
    const original = await readText(file)
    const rewritten = rewriteJsonlExact(original, (value) => {
      if (value.type === 'turn_context') value.timestamp = '2026-08-19T02:00:01.001Z'
      return value
    })
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, originalStats.atime, originalStats.mtime)
    const normalizedStats = await stat(file)
    const persisted = store.get().sessions[sessionId]!
    // Simulate the persisted v2 candidate metadata after filesystem
    // normalization while deliberately retaining the old prefix fingerprint.
    persisted.modifiedAtMs = normalizedStats.mtimeMs
    persisted.fileSize = normalizedStats.size
    expect(persisted.fileSize).toBe(normalizedStats.size)
    expect(persisted.modifiedAtMs).toBe(normalizedStats.mtimeMs)
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.unreconciled).toBe(false)
  })

  it('stages a failed file read and retries without double-counting', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const first = new SessionIndexer(root, store, 0, () => undefined)
    await first.scan()
    const before = store.get().sessions[sessionId]!
    await appendFile(file, tokenLine(180, 120, 20, 200) + '\n', 'utf8')
    const failingFactory = ((path) => {
      const lines = readFileSync(path, 'utf8').split(/\n/).filter(Boolean)
      return Readable.from((function* () {
        yield `${lines.at(-1)!}\n`
        throw new Error('injected mid-stream read failure')
      })())
    }) as SessionReadStreamFactory
    const failing = new SessionIndexer(root, store, 0, () => undefined, failingFactory)
    await failing.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe(before.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total)
    expect(store.get().pendingPricingQueue.some((entry) => entry.status === 'pending')).toBe(true)
    expect(store.get().rebuild.state).toBe('partial')
    const retry = new SessionIndexer(root, store, 0, () => undefined)
    await retry.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(store.get().pendingPricingQueue.some((entry) => entry.status === 'complete')).toBe(false)
  })

  it('bootstraps an older v2 session missing new fingerprints before counting an append', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const statePath = join(root, 'state.json')
    const store = new StateStore(statePath)
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const legacyV2 = JSON.parse(JSON.stringify(store.get())) as Record<string, any>
    delete legacyV2.sessions[sessionId].prefixFingerprint
    delete legacyV2.sessions[sessionId].recoveryAnchor
    delete legacyV2.sessions[sessionId].fingerprintBootstrapPending
    const legacyStatePath = join(root, 'legacy-v2.json')
    await writeFile(legacyStatePath, `${JSON.stringify(legacyV2)}\n`, 'utf8')
    const reloaded = new StateStore(legacyStatePath)
    await reloaded.load()
    expect(reloaded.get().sessions[sessionId]?.fingerprintBootstrapPending).toBe(true)
    await appendFile(file, tokenLine(180, 120, 20, 200) + '\n', 'utf8')
    await new SessionIndexer(root, reloaded, 0, () => undefined).scan()
    const recovered = reloaded.get().sessions[sessionId]!
    expect(recovered.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('200')
    expect(recovered.legacyUnpriced).not.toBe(true)
    expect(recovered.unreconciled).not.toBe(true)
  })

  it('rejects old-v2 bootstrap when the persisted model/tier no longer matches the prefix anchor', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const legacyV2 = JSON.parse(JSON.stringify(store.get())) as Record<string, any>
    delete legacyV2.sessions[sessionId].prefixFingerprint
    delete legacyV2.sessions[sessionId].recoveryAnchor
    delete legacyV2.sessions[sessionId].fingerprintBootstrapPending
    const legacyStatePath = join(root, 'legacy-v2-metadata.json')
    await writeFile(legacyStatePath, `${JSON.stringify(legacyV2)}\n`, 'utf8')
    const original = await readText(file)
    const rewritten = rewriteJsonlExact(original, (value) => {
      if (value.type === 'turn_context') value.payload.model = 'gpt-5.4-sol'
      if (value.payload?.type === 'thread_settings_applied') value.payload.settings.service_tier = 'priority'
      return value
    })
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    const beforeMetadataRewrite = await stat(file)
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, beforeMetadataRewrite.atime, new Date(beforeMetadataRewrite.mtimeMs + 1_000))
    const reloaded = new StateStore(legacyStatePath)
    await reloaded.load()
    expect(reloaded.get().sessions[sessionId]?.fingerprintBootstrapPending).toBe(true)
    await new SessionIndexer(root, reloaded, 0, () => undefined).scan()
    const rejected = reloaded.get().sessions[sessionId]!
    expect(rejected.legacyUnpriced).toBe(false)
    expect(rejected.unreconciled).toBe(false)
    expect(rejected.legacyDaily?.['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('110')
    await appendFile(file, tokenLine(180, 120, 20, 200) + '\n', 'utf8')
    await new SessionIndexer(root, reloaded, 0, () => undefined).scan()
    expect(reloaded.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.4-sol']?.unknown?.total).toBe('90')
  })

  it('keeps trailing rewrite attribution for the next metadata-free token event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rewrite-trailing-attribution-v2-'))
    roots.push(root)
    const sessions = join(root, 'sessions', '2026', '08', '19')
    await mkdir(sessions, { recursive: true })
    const sessionId = '01a00000-0000-7000-8000-000000000084'
    const file = join(sessions, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
    const trailingSettings = JSON.stringify({ timestamp: '2026-08-19T02:00:03.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', settings: { model: 'gpt-5.6-luna', service_tier: null } } })
    await writeFile(file, `${JSON.stringify({ timestamp: '2026-08-19T02:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.6-sol' } })}\n${JSON.stringify({ timestamp: '2026-08-19T02:00:01.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', settings: { service_tier: 'standard' } } })}\n${tokenLine(100, 60, 10, 110)}\n${trailingSettings}\n`, 'utf8')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const rewritten = rewriteJsonlExact(await readText(file), (value) => {
      if (value.payload?.type === 'token_count') {
        value.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
        value.payload.info.last_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
      }
      return value
    })
    const beforeTrailingRewrite = await stat(file)
    await writeFile(file, rewritten, 'utf8')
    await utimes(file, beforeTrailingRewrite.atime, new Date(beforeTrailingRewrite.mtimeMs + 1_000))
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.baselineModel).toBe('gpt-5.6-luna')
    expect(store.get().sessions[sessionId]?.baselineServiceTier).toBe('unknown')
    await appendFile(file, tokenLine(280, 240, 20, 300) + '\n', 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-luna']?.bySpeed?.unknown?.short.total).toBe('80')
  })
})

async function makeSession(token: string, model = 'gpt-5.6-sol', partial = false): Promise<{ root: string; file: string; sessionId: string }> {
  const root = await mkdtemp(join(tmpdir(), 'codex-reconcile-v2-'))
  roots.push(root)
  const sessions = join(root, 'sessions', '2026', '08', '19')
  await mkdir(sessions, { recursive: true })
  const sessionId = '01a00000-0000-7000-8000-000000000099'
  const file = join(sessions, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
  const body = partial ? token : token.endsWith('\n') ? token : `${token}\n`
  const settings = JSON.stringify({ timestamp: '2026-08-19T02:00:01.500Z', type: 'event_msg', payload: { type: 'thread_settings_applied', settings: { service_tier: 'standard' } } })
  await writeFile(file, `${JSON.stringify({ timestamp: '2026-08-19T02:00:01.000Z', type: 'turn_context', payload: { model } })}\n${settings}\n${body}`, 'utf8')
  return { root, file, sessionId }
}

async function readText(path: string): Promise<string> {
  const { readFile } = await import('node:fs/promises')
  return readFile(path, 'utf8')
}

function rewriteJsonlExact(original: string, mutate: (value: Record<string, any>) => Record<string, any>): string {
  return original.split('\n').map((line) => {
    if (!line.trim()) return line
    let value: Record<string, any>
    try {
      value = JSON.parse(line) as Record<string, any>
    } catch {
      return line
    }
    const rewritten = JSON.stringify(mutate(value))
    const targetBytes = Buffer.byteLength(line, 'utf8')
    const rewrittenBytes = Buffer.byteLength(rewritten, 'utf8')
    if (rewrittenBytes > targetBytes) throw new Error('deterministic JSONL rewrite exceeded target line length')
    return rewritten + ' '.repeat(targetBytes - rewrittenBytes)
  }).join('\n')
}

function tokenLine(input: number, cached: number, output: number, total: number): string {
  return JSON.stringify({
    timestamp: '2026-08-19T02:00:02.000Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 5, total_tokens: total }
      }
    }
  })
}
