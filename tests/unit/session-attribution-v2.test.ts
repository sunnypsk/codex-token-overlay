import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionIndexerInternals } from '../../src/main/session-indexer.js'
import { SessionIndexer } from '../../src/main/session-indexer.js'
import { StateStore } from '../../src/main/state.js'
import { createBundledPriceBook, resolveEffectiveModelPricing } from '../../src/main/pricing.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

describe('session pricing attribution v2', () => {
  it('maps standard/default and fast/priority while preserving unknown-present', () => {
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: 'default' })).toBe('standard')
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: 'standard' })).toBe('standard')
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: 'priority' })).toBe('fast')
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: 'fast' })).toBe('fast')
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: 'experimental' })).toBe('unknown')
    expect(sessionIndexerInternals.classifyServiceTier({ service_tier: null })).toBe('unknown')
    expect(sessionIndexerInternals.classifyServiceTier({})).toBeNull()
  })

  it('prefers the token event model over the turn-context model', () => {
    expect(sessionIndexerInternals.extractEventModel({ model: 'gpt-5.6-sol' }, { model: 'gpt-5.4' })).toBe('gpt-5.6-sol')
    expect(sessionIndexerInternals.extractEventModel({}, { model: 'gpt-5.4' })).toBe('gpt-5.4')
  })

  it('inherits thread settings and derives model/context dimensions per event', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-attribution-v2-'))
    roots.push(root)
    const sessions = join(root, 'sessions', '2026', '08', '19')
    await mkdir(sessions, { recursive: true })
    const sessionId = '01a00000-0000-7000-8000-000000000088'
    const file = join(sessions, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
    const lines = [
      { timestamp: '2026-08-19T02:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } },
      { timestamp: '2026-08-19T02:00:01.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', settings: { service_tier: 'priority' } } },
      tokenEvent('2026-08-19T02:00:02.000Z', 100, 100, 'gpt-5.6-sol'),
      { timestamp: '2026-08-19T02:00:03.000Z', type: 'event_msg', payload: { type: 'thread_settings_applied', settings: { service_tier: 'standard' } } },
      tokenEvent('2026-08-19T02:00:04.000Z', 272100, 272100, 'gpt-5.4')
    ]
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const aggregate = store.get().sessions[sessionId]?.daily['2026-08-19']?.models
    expect(aggregate?.['gpt-5.6-sol']?.bySpeed?.fast?.short.total).toBe('100')
    expect(aggregate?.['gpt-5.4']?.bySpeed?.standard?.long.total).toBe('272000')
  })

  it('uses model-specific effective long thresholds instead of a global 272K decision', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-threshold-v2-'))
    roots.push(root)
    const sessions = join(root, 'sessions', '2026', '08', '19')
    await mkdir(sessions, { recursive: true })
    const sessionId = '01a00000-0000-7000-8000-000000000087'
    const file = join(sessions, `rollout-2026-08-19T10-00-00-${sessionId}.jsonl`)
    const lines = [
      { timestamp: '2026-08-19T02:00:00.000Z', type: 'turn_context', payload: { model: 'gpt-5.4' } },
      tokenEvent('2026-08-19T02:00:01.000Z', 210000, 210000, 'gpt-5.4'),
      tokenEvent('2026-08-19T02:00:02.000Z', 210000, 420000, 'gpt-5.5'),
      tokenEvent('2026-08-19T02:00:03.000Z', 280000, 700000, 'gpt-5.5')
    ]
    await writeFile(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8')
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const book = createBundledPriceBook()
    book.models['gpt-5.4'] = { ...book.models['gpt-5.4']!, longContextThreshold: '200000' }
    book.models['gpt-5.5'] = { ...book.models['gpt-5.5']!, longContextThreshold: '272000' }
    store.update((state) => { state.priceBook = book })
    await new SessionIndexer(root, store, 0, () => undefined).scan()
    const models = store.get().sessions[sessionId]?.daily['2026-08-19']?.models
    expect(models?.['gpt-5.4']?.long?.total).toBe('210000')
    expect(models?.['gpt-5.4']?.short?.total).toBe('0')
    expect(models?.['gpt-5.5']?.short?.total).toBe('210000')
    expect(models?.['gpt-5.5']?.long?.total).toBe('280000')
    expect(resolveEffectiveModelPricing(book, 'gpt-5.4', '2026-08-19T02:00:01.000Z').longContextThreshold).toBe(200000n)
  })
})

function tokenEvent(timestamp: string, input: number, total: number, model: string): Record<string, unknown> {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      model,
      info: {
        total_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total },
        last_token_usage: { input_tokens: input, cached_input_tokens: 0, cache_write_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: total }
      }
    }
  }
}
