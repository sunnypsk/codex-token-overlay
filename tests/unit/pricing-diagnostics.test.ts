import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildPricingDiagnosticSummary, PricingDiagnostics } from '../../src/main/pricing-diagnostics.js'
import { calculateModelCostDetailed, resolveEffectiveModelPricing } from '../../src/main/pricing.js'
import { createDefaultState, createEmptyStoredModelAggregate } from '../../src/main/state.js'
import { deserializeTokens } from '../../src/main/token-math.js'

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('pricing diagnostics', () => {
  it('classifies priceable, lower-bound, unknown-context, missing-model, and legacy totals without raw payloads', () => {
    const state = createDefaultState()
    const known = createEmptyStoredModelAggregate()
    known.short = tokens(100)
    known.unknown = tokens(50)
    known.bySpeed = {
      unknown: { short: tokens(100), long: zero(), unknown: tokens(50), eventCount: 2, firstEventAt: '2026-08-19T02:00:00.000Z' }
    }
    const missing = createEmptyStoredModelAggregate()
    missing.short = tokens(20)
    const legacy = createEmptyStoredModelAggregate()
    legacy.short = tokens(30)
    state.sessions.safe = {
      sessionId: 'secret-session-id',
      path: 'C:/private/prompt.jsonl',
      offset: 0,
      fileSize: 0,
      modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol',
      lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': known, 'unknown-model': missing } } },
      legacyDaily: { '2026-08-19': { models: { 'gpt-5.6-sol': legacy } } },
      cycles: {},
      eventCount: 3,
      parseErrors: 0
    }
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    expect(summary.event).toBe('pricing-diagnostic.v1')
    expect(summary.totals.localTokens).toBe('200')
    expect(summary.totals.pricedTokens).toBe('100')
    expect(summary.totals.unpricedTokens).toBe('100')
    expect(summary.reasonCounts.priceable).toBe('100')
    expect(summary.totals.lowerBoundTokens).toBe('200')
    expect(summary.reasonCounts.unknown_context).toBe('50')
    expect(summary.reasonCounts.missing_model_or_alias).toBe('20')
    expect(summary.reasonCounts.legacy_fallback).toBe('30')
    const primaryReasonTotal = Object.values(summary.reasonCounts).reduce((total, value) => total + BigInt(value), 0n)
    expect(primaryReasonTotal.toString()).toBe(summary.totals.localTokens)
    expect(summary.samples.length).toBeLessThanOrEqual(8)
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('secret-session-id')
    expect(serialized).not.toContain('private/prompt.jsonl')
  })

  it('hashes unrecognized model/component values and never emits persisted URLs', async () => {
    const state = createDefaultState()
    const secretModel = 'C:/private/prompt.txt :: bearer-secret :: do-not-log'
    const usage = createEmptyStoredModelAggregate()
    usage.short = tokens(10)
    const knownUsage = createEmptyStoredModelAggregate()
    knownUsage.short = tokens(11)
    state.priceBook.sourceUrl = 'https://secret.invalid/prompt?token=do-not-log'
    state.priceBook.sourceQuality = 'embedded'
    state.priceBook.models['gpt-5.6-sol'] = {
      ...state.priceBook.models['gpt-5.6-sol']!,
      base: { ...state.priceBook.models['gpt-5.6-sol']!.base!, componentId: 'C:/secret/component-with-prompt' }
    }
    state.sessions.adversarial = {
      sessionId: 'thread-secret-id', path: 'C:/private/session-secret.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: secretModel, lastCumulative: null,
      daily: { '2026-08-19': { models: { [secretModel]: usage, 'gpt-5.6-sol': knownUsage } } }, cycles: {}, eventCount: 2, parseErrors: 0
    }
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(secretModel)
    expect(serialized).not.toContain('secret.invalid')
    expect(serialized).not.toContain('do-not-log')
    expect(serialized).not.toContain('thread-secret-id')
    expect(serialized).not.toContain('session-secret.jsonl')
    expect(serialized).not.toContain('component-with-prompt')
    expect(serialized).toMatch(/model#[0-9a-f]{16}/u)
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-trusted-secret-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { log: () => undefined })
    await logger.emit(state)
    const firstLine = (await readFile(logger.filePath, 'utf8')).split(/\r?\n/u)[0] ?? ''
    expect(firstLine).not.toContain(secretModel)
    expect(firstLine).not.toContain('secret.invalid')
    expect(firstLine).not.toContain('component-with-prompt')
  })

  it('hashes trusted price-book keys/components and bounds corrupted token strings before first write', async () => {
    const state = createDefaultState()
    const trustedSecretModel = 'C:/trusted/prompt-secret-model'
    const trustedSecretComponent = 'embedded-base-C:/trusted/prompt-secret-component'
    const huge = '9'.repeat(10_000)
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: huge, cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: huge }
    state.priceBook.models[trustedSecretModel] = {
      ...state.priceBook.models['gpt-5.6-sol']!,
      base: { ...state.priceBook.models['gpt-5.6-sol']!.base!, componentId: trustedSecretComponent }
    }
    state.sessions.corrupt = {
      sessionId: 'secret-thread', path: 'C:/secret/prompt.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: trustedSecretModel, lastCumulative: null,
      daily: { '2026-08-19': { models: { [trustedSecretModel]: usage } } }, cycles: {}, eventCount: 1, parseErrors: 0
    }
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain(trustedSecretModel)
    expect(serialized).not.toContain(trustedSecretComponent)
    expect(serialized).not.toContain(huge)
    expect(summary.totals.overflowBuckets).toBe('1')

    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-corrupt-'))
    roots.push(root)
    let tick = 0
    const logger = new PricingDiagnostics(root, { maxBytes: 512, now: () => `2026-08-20T00:00:0${tick++}.000Z`, log: () => undefined })
    await logger.emit(state)
    await logger.emit(state)
    const content = await readFile(logger.filePath, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(512)
    expect(content.trim().split(/\r?\n/u)).toHaveLength(1)
    const firstLine = content.split(/\r?\n/u)[0] ?? ''
    expect(firstLine).not.toContain(trustedSecretModel)
    expect(firstLine).not.toContain(trustedSecretComponent)
    expect(firstLine).not.toContain(huge)
  })

  it('matches production effective-price and cost semantics for a supported model', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '100', cachedInput: '40', cacheWriteInput: '0', output: '10', reasoningOutput: '0', total: '110' }
    usage.bySpeed = { standard: { short: usage.short, long: zero(), eventCount: 1, firstEventAt: '2026-08-19T02:00:00.000Z' } }
    state.sessions.parity = {
      sessionId: 'parity', path: 'parity.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } }, cycles: {}, eventCount: 1, parseErrors: 0
    }
    const eventAt = '2026-08-19T02:00:00.000Z'
    const effective = resolveEffectiveModelPricing(state.priceBook, 'gpt-5.6-sol', eventAt, state.pricingLedger)
    const detailed = calculateModelCostDetailed({ short: deserializeTokens(usage.short), long: { input: 0n, cachedInput: 0n, cacheWriteInput: 0n, output: 0n, reasoningOutput: 0n, total: 0n } }, effective.price, { fast: false, fastFact: effective.fastFact })
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    expect(summary.totals.pricedTokens).toBe(detailed.pricedTokens.toString())
    expect(summary.totals.unpricedTokens).toBe((110n - detailed.pricedTokens).toString())
  })

  it('does not price an injected unsupported model key with copied trusted components', () => {
    const state = createDefaultState()
    const injected = createEmptyStoredModelAggregate()
    injected.short = tokens(25)
    state.priceBook.models['gpt-5.4-injected'] = { ...state.priceBook.models['gpt-5.6-sol']! }
    state.sessions.injected = {
      sessionId: 'injected', path: 'injected.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.4-injected', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.4-injected': injected } } }, cycles: {}, eventCount: 1, parseErrors: 0
    }
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    expect(summary.reasonCounts.missing_model_or_alias).toBe('25')
    expect(summary.reasonCounts.priceable).toBe('0')
  })

  it('classifies an absent-current canonical historical model as pre-effective, not missing', () => {
    const state = createDefaultState()
    const modelId = 'gpt-5.4'
    const canonical = state.priceBook.models[modelId]!
    delete state.priceBook.models[modelId]
    const usage = createEmptyStoredModelAggregate()
    usage.short = tokens(20)
    usage.unknown = tokens(5)
    usage.bySpeed = {
      standard: { short: tokens(20), long: zero(), unknown: tokens(5), eventCount: 2, firstEventAt: '2026-08-19T02:00:00.000Z' }
    }
    state.sessions.historical = {
      sessionId: 'historical', path: 'historical.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: modelId, lastCumulative: null,
      daily: { '2026-08-19': { models: { [modelId]: usage } } }, cycles: {}, eventCount: 2, parseErrors: 0
    }

    for (const baseAt of ['2026-08-20T00:00:00.000Z', 'not-a-date']) {
      state.pricingLedger = [{
        id: `historical-${baseAt}`,
        effectiveAt: '2026-08-18T00:00:00.000Z',
        observedAt: '2026-08-18T01:00:00.000Z',
        source: 'test', sourceSha256: null, semanticHash: 'historical',
        models: { [modelId]: { ...canonical, base: { ...canonical.base!, effectiveAt: baseAt } } }
      }]
      const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
      expect(summary.reasonCounts.pre_effective_or_missing_rate).toBe('20')
      expect(summary.reasonCounts.unknown_context).toBe('5')
      expect(summary.reasonCounts.missing_model_or_alias).toBe('0')
    }
  })

  it('mirrors production Fast lower-bound for a non-exact premium rational', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = tokens(3)
    usage.bySpeed = { fast: { short: usage.short, long: zero(), eventCount: 1, firstEventAt: '2026-08-19T02:00:00.000Z' } }
    const fact = state.priceBook.fastFacts!['gpt-5.6-sol']!
    state.priceBook.fastFacts!['gpt-5.6-sol'] = { ...fact, numerator: '1', denominator: '3' }
    state.sessions.fastNonExact = {
      sessionId: 'fastNonExact', path: 'fast.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } }, cycles: {}, eventCount: 1, parseErrors: 0
    }
    const eventAt = '2026-08-19T02:00:00.000Z'
    const effective = resolveEffectiveModelPricing(state.priceBook, 'gpt-5.6-sol', eventAt, state.pricingLedger)
    const detailed = calculateModelCostDetailed({ short: deserializeTokens(usage.short), long: { input: 0n, cachedInput: 0n, cacheWriteInput: 0n, output: 0n, reasoningOutput: 0n, total: 0n } }, effective.price, { fast: true, fastFact: effective.fastFact })
    expect(detailed.lowerBound).toBe(true)
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    expect(summary.totals.lowerBoundTokens).toBe('3')
    expect(summary.samples.some((sample) => sample.model.startsWith('model#') && sample.lowerBound)).toBe(true)
    state.priceBook.fastFacts!['gpt-5.6-sol'] = { ...fact, numerator: 'not-a-number' }
    const malformedEffective = resolveEffectiveModelPricing(state.priceBook, 'gpt-5.6-sol', eventAt, state.pricingLedger)
    const malformedDetailed = calculateModelCostDetailed({ short: deserializeTokens(usage.short), long: { input: 0n, cachedInput: 0n, cacheWriteInput: 0n, output: 0n, reasoningOutput: 0n, total: 0n } }, malformedEffective.price, { fast: true, fastFact: malformedEffective.fastFact })
    expect(malformedDetailed.lowerBound).toBe(true)
    expect(buildPricingDiagnosticSummary(state, '2026-08-20T00:00:01.000Z').totals.lowerBoundTokens).toBe('3')
  })

  it('deduplicates identical summaries and rotates the durable JSONL file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { maxEntries: 2, maxBytes: 16_384, log: () => undefined })
    const state = createDefaultState()
    const first = await logger.emit(state)
    const duplicate = await logger.emit(state)
    expect(first).toBe(true)
    expect(duplicate).toBe(false)

    for (let index = 1; index <= 3; index += 1) {
      state.rebuild.pending = index
      state.rebuild.state = index % 2 === 0 ? 'indexing' : 'partial'
      await logger.emit(state)
    }
    const content = await readFile(logger.filePath, 'utf8')
    const lines = content.trim().split(/\r?\n/u)
    expect(lines).toHaveLength(2)
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(16_384)
    expect(lines.every((line) => JSON.parse(line).event === 'pricing-diagnostic.v1')).toBe(true)
  })

  it('repairs malformed tails and hard-caps a single oversized candidate record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-cap-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { maxBytes: 512, maxEntries: 256, log: () => undefined })
    const state = createDefaultState()
    await logger.emit(state)
    await appendFile(logger.filePath, '\nnot-json-tail\n{"event":"pricing-diagnostic.v1"', 'utf8')
    await logger.emit(state)
    expect(await readFile(logger.filePath, 'utf8')).not.toContain('not-json-tail')
    state.rebuild.pending = 7
    await logger.emit(state)
    const content = await readFile(logger.filePath, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(512)
    const lines = content.trim().split(/\r?\n/u)
    expect(lines.every((line) => {
      const parsed = JSON.parse(line) as { event?: string; summaryHash?: string }
      return parsed.event === 'pricing-diagnostic.v1' && typeof parsed.summaryHash === 'string'
    })).toBe(true)
    expect((await readdir(root)).filter((name) => name.endsWith('.tmp'))).toHaveLength(0)
  })

  it('repairs a canonical duplicate that was preloaded over the configured cap', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-preloaded-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { maxBytes: 512, log: () => undefined })
    const state = createDefaultState()
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    await mkdir(root, { recursive: true })
    await writeFile(logger.filePath, `${JSON.stringify(summary)}\n${JSON.stringify(summary)}\n`, 'utf8')
    await logger.emit(state)
    const content = await readFile(logger.filePath, 'utf8')
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThanOrEqual(512)
    expect(content.trim().split(/\r?\n/u)).toHaveLength(1)
  })

  it('repairs a duplicate summary from more than 256 valid entries before returning', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-entries-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { maxEntries: 256, maxBytes: 512 * 1024, log: () => undefined })
    const state = createDefaultState()
    const summary = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    await mkdir(root, { recursive: true })
    const line = JSON.stringify(summary)
    await writeFile(logger.filePath, `${Array.from({ length: 300 }, () => line).join('\n')}\n`, 'utf8')
    await logger.emit(state)
    const content = await readFile(logger.filePath, 'utf8')
    expect(content.trim().split(/\r?\n/u).length).toBeLessThanOrEqual(256)
  })

  it('surfaces safe write warnings and drains concurrent writes without leaking path data', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-errors-'))
    roots.push(root)
    const blocked = join(root, 'blocked-secret-path')
    await writeFile(blocked, 'not-a-directory', 'utf8')
    const warnings: string[] = []
    const logger = new PricingDiagnostics(join(blocked, 'logs'), { warn: (message) => warnings.push(message), log: () => undefined })
    const state = createDefaultState()
    await Promise.all([logger.emit(state), logger.emit(state)])
    await logger.flush()
    expect(warnings.length).toBeGreaterThan(0)
    expect(warnings.every((message) => !message.includes('blocked-secret-path'))).toBe(true)
    expect(warnings.every((message) => message === 'Unable to persist pricing diagnostics.')).toBe(true)
  })

  it('serializes concurrent duplicate summaries to one durable entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-pricing-diagnostics-concurrent-'))
    roots.push(root)
    const logger = new PricingDiagnostics(root, { log: () => undefined })
    const state = createDefaultState()
    const results = await Promise.all([logger.emit(state), logger.emit(state), logger.emit(state)])
    await logger.flush()
    const lines = (await readFile(logger.filePath, 'utf8')).trim().split(/\r?\n/u)
    expect(lines).toHaveLength(1)
    expect(results.filter(Boolean)).toHaveLength(1)
  })
})

function tokens(total: number) {
  return { input: String(total), cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: String(total) }
}

function zero() {
  return tokens(0)
}
