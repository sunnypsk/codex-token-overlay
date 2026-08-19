import { appendFile, mkdir, mkdtemp, stat, utimes, writeFile, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionIndexer, type SessionReadStreamFactory } from '../../src/main/session-indexer.js'
import { StateStore } from '../../src/main/state.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('session reconciliation v2', () => {
  it('detects a same-size content rewrite even when only the fingerprint changes', async () => {
    const { file, root, sessionId } = await makeSession(tokenLine(100, 60, 10, 110))
    const store = new StateStore(join(root, 'state.json'))
    await store.load()
    const indexer = new SessionIndexer(root, store, 0, () => undefined)
    await indexer.scan()
    const before = store.get().sessions[sessionId]!
    const original = await readText(file)
    const rewritten = rewriteJsonlExact(original, (value) => {
      if (value.type === 'turn_context') value.payload.model = 'gpt-5.4-sol'
      if (value.payload?.type === 'thread_settings_applied') value.payload.settings.service_tier = 'priority'
      if (value.payload?.type === 'token_count') {
        value.payload.info.total_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
        value.payload.info.last_token_usage = { input_tokens: 200, cached_input_tokens: 80, cache_write_input_tokens: 0, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 220 }
      }
      return value
    })
    expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original))
    expect(rewritten.split(/\n/).length).toBe(original.split(/\n/).length)
    await writeFile(file, rewritten, 'utf8')
    expect((await stat(file)).size).toBe(Buffer.byteLength(original))
    await indexer.scan()
    const after = store.get().sessions[sessionId]!
    expect(after.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe(before.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total)
    expect(after.unreconciled).toBe(true)
    expect(after.legacyUnpriced).toBe(true)
    await appendFile(file, tokenLine(240, 200, 20, 260) + '\n', 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.daily['2026-08-19']?.models['gpt-5.6-sol']?.short.total).toBe('150')
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
    await writeFile(file, rewritten, 'utf8')
    await indexer.scan()
    expect(store.get().sessions[sessionId]?.unreconciled).toBe(true)
    expect(store.get().sessions[sessionId]?.legacyUnpriced).toBe(true)
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
    expect(store.get().sessions[sessionId]?.unreconciled).toBe(true)
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
    await writeFile(file, rewritten, 'utf8')
    const reloaded = new StateStore(legacyStatePath)
    await reloaded.load()
    expect(reloaded.get().sessions[sessionId]?.fingerprintBootstrapPending).toBe(true)
    await new SessionIndexer(root, reloaded, 0, () => undefined).scan()
    const rejected = reloaded.get().sessions[sessionId]!
    expect(rejected.legacyUnpriced).toBe(true)
    expect(rejected.unreconciled).toBe(true)
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
