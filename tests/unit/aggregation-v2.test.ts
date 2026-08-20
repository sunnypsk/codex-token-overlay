import { describe, expect, it } from 'vitest'
import { aggregationInternals, buildDashboardSnapshot, buildPeriod } from '../../src/main/aggregation.js'
import { buildPricingDiagnosticSummary } from '../../src/main/pricing-diagnostics.js'
import { calculateModelCostDetailed, resolveEffectiveModelPricing, roundAttoUsdToMicroUsd } from '../../src/main/pricing.js'
import { createDefaultState, createEmptyStoredModelAggregate } from '../../src/main/state.js'
import { deserializeTokens, zeroTokens } from '../../src/main/token-math.js'

describe('aggregation v2 coverage dimensions', () => {
  it('reports null coverages for zero denominators and keeps unknown speed lower-bound', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '10', reasoningOutput: '0', total: '110' }
    usage.bySpeed = {
      unknown: {
        short: usage.short,
        long: usage.long,
        eventCount: 1
      }
    }
    state.sessions.session = {
      sessionId: 'session', path: 'test.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {}, eventCount: 1, parseErrors: 0
    }
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    expect(period.cost.localCoveragePercent).toBeNull()
    expect(period.cost.tierCoveragePercent).toBe(0)
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.priceCoveragePercent).toBe(100)
  })

  it('keeps legacy-unpriced aggregates as lower bounds instead of verified bounds', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '10', reasoningOutput: '0', total: '110' }
    state.sessions.legacy = {
      sessionId: 'legacy', path: 'missing.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null, legacyUnpriced: true,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {}, eventCount: 1, parseErrors: 0
    }
    state.account.dailyUsageBuckets['2026-08-19'] = '110'
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.unpricedTokens).toBe('110')
    expect(period.models[0]?.lowerBound).toBe(true)
    expect(period.models[0]?.apiEquivalentMicroUsd).toBeNull()
  })

  it('counts pending and processing pricing work in the expanded freshness contract', () => {
    const state = createDefaultState()
    state.pendingPricingQueue = [
      { id: 'p', sessionId: 'p', filePath: 'p', capturedSize: 1, capturedOffset: 0, queuedAt: '', status: 'pending' },
      { id: 'w', sessionId: 'w', filePath: 'w', capturedSize: 1, capturedOffset: 0, queuedAt: '', status: 'processing' },
      { id: 'c', sessionId: 'c', filePath: 'c', capturedSize: 1, capturedOffset: 0, queuedAt: '', status: 'complete' }
    ]
    const snapshot = buildDashboardSnapshot(state, { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 }, null, Date.parse('2026-08-19T04:00:00Z'))
    expect(snapshot.freshness.pendingPricing).toBe(2)
  })

  it('excludes unknown-context Fast tokens from verified premium coverage', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    usage.unknown = { input: '50', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '50' }
    usage.bySpeed = {
      fast: {
        short: usage.short,
        long: usage.long,
        unknown: usage.unknown,
        eventCount: 2,
        firstEventAt: '2026-08-19T02:00:00.000Z'
      }
    }
    state.sessions.fast = {
      sessionId: 'fast', path: 'test.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {}, eventCount: 2, parseErrors: 0
    }
    state.account.dailyUsageBuckets['2026-08-19'] = '150'
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    expect(period.cost.fastRateCoveragePercent).toBe(66.66)
    expect(period.cost.priceCoveragePercent).toBe(66.66)
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.unpricedTokens).toBe('50')
  })

  it('does not count malformed Fast rational facts as verified premium coverage', () => {
    const state = createDefaultState()
    state.priceBook.fastFacts!['gpt-5.6-sol'] = {
      ...state.priceBook.fastFacts!['gpt-5.6-sol']!,
      numerator: 'not-a-number'
    }
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    usage.bySpeed = { fast: { short: usage.short, long: usage.long, eventCount: 1, firstEventAt: '2026-08-19T02:00:00.000Z' } }
    state.sessions.malformedFast = {
      sessionId: 'malformedFast', path: 'test.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {}, eventCount: 1, parseErrors: 0
    }
    state.account.dailyUsageBuckets['2026-08-19'] = '100'
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    expect(period.cost.fastRateCoveragePercent).toBe(0)
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.unpricedTokens).toBe('0')
  })

  it('subtracts unknown-tier short, long, and unknown-context tokens from tier coverage', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    const unknownSpeed = {
      short: { input: '10', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '10' },
      long: { input: '20', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '20' },
      unknown: { input: '30', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '30' },
      eventCount: 3
    }
    usage.bySpeed = { unknown: unknownSpeed }
    usage.short = unknownSpeed.short
    usage.long = unknownSpeed.long
    usage.unknown = unknownSpeed.unknown
    state.sessions.unknownTier = {
      sessionId: 'unknownTier', path: 'test.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol', lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {}, eventCount: 3, parseErrors: 0
    }
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    expect(period.cost.tierCoveragePercent).toBe(0)
  })

  it('uses the applicable historical ledger revision for aggregate and diagnostic cost', () => {
    const fixture = historicalPricingFixture()
    const { state, modelId, eventAt, usage, historical } = fixture
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const effective = resolveEffectiveModelPricing(state.priceBook, modelId, eventAt, state.pricingLedger)
    const expected = calculateModelCostDetailed(
      { short: deserializeTokens(usage.short), long: zeroTokens() },
      effective.price
    )

    expect(state.priceBook.models[modelId]?.short.inputMicroUsdPerMillion).toBe('9000000')
    expect(historical.short.inputMicroUsdPerMillion).toBe('1000000')
    expect(effective.price?.short.inputMicroUsdPerMillion).toBe('1000000')
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
    expect(period.cost.microUsd).toBe(expected.microUsd?.toString() ?? null)
  })

  it('keeps injected copied models unpriced while a verified alias remains priceable', () => {
    const state = createDefaultState()
    const injectedModel = 'gpt-5.4-injected'
    const injected = createEmptyStoredModelAggregate()
    injected.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    const aliasModel = 'gpt-5.6-codex'
    const alias = createEmptyStoredModelAggregate()
    alias.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
    state.priceBook.models[injectedModel] = { ...state.priceBook.models['gpt-5.6']! }
    state.sessions.injected = {
      sessionId: 'injected', path: 'injected.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
      currentModel: injectedModel, lastCumulative: null,
      daily: { '2026-08-19': { models: { [injectedModel]: injected, [aliasModel]: alias } } },
      cycles: {}, eventCount: 2, parseErrors: 0
    }
    state.account.dailyUsageBuckets['2026-08-19'] = '200'
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')

    expect(period.cost.pricedTokens).toBe('100')
    expect(period.cost.unpricedTokens).toBe('100')
    expect(period.cost.unknownModels).toContain(injectedModel)
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
    expect(diagnostics.reasonCounts.missing_model_or_alias).toBe('100')
    expect(diagnostics.reasonCounts.priceable).toBe('100')
  })

  it('uses an applicable historical model absent from the current book in aggregate and diagnostics', () => {
    const fixture = historicalPricingFixture()
    const { state, modelId, historical } = fixture
    delete state.priceBook.models[modelId]
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')

    expect(period.cost.pricedTokens).toBe('100')
    expect(period.cost.unpricedTokens).toBe('0')
    expect(period.models.find((summary) => summary.model === modelId)?.source?.componentId).toBe(historical.base?.componentId)
    expect(diagnostics.totals.pricedTokens).toBe('100')
    expect(diagnostics.totals.unpricedTokens).toBe('0')
    expect(diagnostics.reasonCounts.priceable).toBe('100')
  })

  it('prices short tokens but leaves long tokens unpriced when the selected long revision is future', () => {
    const fixture = historicalPricingFixture()
    const { state, modelId, eventAt, usage, historical } = fixture
    const longUsage = { input: '50', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '50' }
    usage.long = longUsage
    usage.bySpeed!.standard!.long = longUsage
    state.account.dailyUsageBuckets['2026-08-19'] = '150'
    const futureLong = {
      ...historical,
      longComponent: { ...historical.longComponent!, effectiveAt: '2026-08-20T00:00:00.000Z' }
    }
    state.pricingLedger[0] = { ...state.pricingLedger[0]!, models: { [modelId]: futureLong } }

    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const effective = resolveEffectiveModelPricing(state.priceBook, modelId, eventAt, state.pricingLedger)
    const expectedShort = calculateModelCostDetailed(
      { short: deserializeTokens(usage.short), long: zeroTokens() },
      effective.price
    )

    expect(effective.hasEffectiveBase).toBe(true)
    expect(effective.hasEffectiveLong).toBe(false)
    expect(period.cost.pricedTokens).toBe('100')
    expect(period.cost.unpricedTokens).toBe('50')
    expect(period.cost.microUsd).toBe(expectedShort.microUsd?.toString() ?? null)
    expect(period.cost.lowerBound).toBe(true)
    expect(period.models[0]?.source?.effectiveAt).toBe('2026-08-18T00:00:00.000Z')
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
  })

  it('prices short tokens but leaves long tokens unpriced when the selected long revision is malformed', () => {
    const fixture = historicalPricingFixture()
    const { state, modelId, eventAt, usage, historical } = fixture
    const longUsage = { input: '50', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '50' }
    usage.long = longUsage
    usage.bySpeed!.standard!.long = longUsage
    state.account.dailyUsageBuckets['2026-08-19'] = '150'
    const malformedLong = {
      ...historical,
      longComponent: { ...historical.longComponent!, effectiveAt: 'not-a-date' }
    }
    state.pricingLedger[0] = { ...state.pricingLedger[0]!, models: { [modelId]: malformedLong } }

    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const effective = resolveEffectiveModelPricing(state.priceBook, modelId, eventAt, state.pricingLedger)

    expect(effective.hasEffectiveBase).toBe(true)
    expect(effective.hasEffectiveLong).toBe(false)
    expect(period.cost.pricedTokens).toBe('100')
    expect(period.cost.unpricedTokens).toBe('50')
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
    expect(diagnostics.reasonCounts.pre_effective_or_missing_rate).toBe('50')
  })

  it('keeps a selected malformed historical revision unpriced in aggregate and diagnostics', () => {
    const fixture = historicalPricingFixture()
    const { state, modelId } = fixture
    const malformed = {
      ...fixture.historical,
      base: { ...fixture.historical.base!, effectiveAt: 'not-a-date' }
    }
    state.pricingLedger[0] = {
      ...state.pricingLedger[0]!,
      observedAt: '2026-08-19T03:00:00.000Z',
      models: { [modelId]: malformed }
    }
    const period = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), Date.parse('2026-08-19T04:00:00Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')

    expect(period.cost.pricedTokens).toBe('0')
    expect(period.cost.unpricedTokens).toBe('100')
    expect(period.cost.lowerBound).toBe(true)
    expect(diagnostics.totals.pricedTokens).toBe('0')
    expect(diagnostics.totals.unpricedTokens).toBe('100')
    expect(diagnostics.reasonCounts.pre_effective_or_missing_rate).toBe('100')
  })

  it('prices same-model segments with their own revisions and rounds once globally', () => {
    const fixture = multiRevisionPricingFixture()
    const { state, modelId, firstEventAt, secondEventAt, firstUsage, secondUsage, r1, r2 } = fixture
    const startMs = Date.parse('2026-08-17T16:00:00Z')
    const endMs = Date.parse('2026-08-19T15:59:59Z')
    const period = buildPeriod('today', startMs, endMs, state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const firstEffective = resolveEffectiveModelPricing(state.priceBook, modelId, firstEventAt, state.pricingLedger)
    const secondEffective = resolveEffectiveModelPricing(state.priceBook, modelId, secondEventAt, state.pricingLedger)
    const firstCost = calculateModelCostDetailed({ short: deserializeTokens(firstUsage.short), long: zeroTokens() }, firstEffective.price)
    const secondCost = calculateModelCostDetailed({ short: deserializeTokens(secondUsage.short), long: zeroTokens() }, secondEffective.price)
    const expectedAtto = (firstCost.attoUsd ?? 0n) + (secondCost.attoUsd ?? 0n)
    const collapsedR1Atto = (firstCost.attoUsd ?? 0n) + (firstCost.attoUsd ?? 0n)

    expect(firstEffective.price?.short.inputMicroUsdPerMillion).toBe(r1.short.inputMicroUsdPerMillion)
    expect(secondEffective.price?.short.inputMicroUsdPerMillion).toBe(r2.short.inputMicroUsdPerMillion)
    expect(period.tokens.total).toBe('500000')
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
    expect(period.cost.microUsd).toBe(roundAttoUsdToMicroUsd(expectedAtto).toString())
    expect(period.cost.microUsd).toBe('2')
    expect(period.cost.microUsd).not.toBe(roundAttoUsdToMicroUsd(collapsedR1Atto).toString())
    expect(period.cost.coveragePercent).toBe(100)
    expect(period.cost.localCoveragePercent).toBe(100)
    expect(period.models[0]?.source).toBeUndefined()
  })

  it('keeps an unpriceable earlier segment unpriced while pricing a later valid revision', () => {
    const fixture = multiRevisionPricingFixture()
    const { state, modelId, secondEventAt, r1, r2 } = fixture
    const malformedR1 = { ...r1, base: { ...r1.base!, effectiveAt: 'not-a-date' } }
    state.pricingLedger[0] = { ...state.pricingLedger[0]!, models: { [modelId]: malformedR1 } }
    const period = buildPeriod('today', Date.parse('2026-08-17T16:00:00Z'), Date.parse('2026-08-19T15:59:59Z'), state)
    const diagnostics = buildPricingDiagnosticSummary(state, '2026-08-20T00:00:00.000Z')
    const secondEffective = resolveEffectiveModelPricing(state.priceBook, modelId, secondEventAt, state.pricingLedger)
    const secondCost = calculateModelCostDetailed({ short: deserializeTokens(fixture.secondUsage.short), long: zeroTokens() }, secondEffective.price)

    expect(secondEffective.price?.short.inputMicroUsdPerMillion).toBe(r2.short.inputMicroUsdPerMillion)
    expect(period.cost.pricedTokens).toBe('250000')
    expect(period.cost.unpricedTokens).toBe('250000')
    expect(period.cost.lowerBound).toBe(true)
    expect(period.cost.microUsd).toBe(roundAttoUsdToMicroUsd(secondCost.attoUsd ?? 0n).toString())
    expect(period.cost.pricedTokens).toBe(diagnostics.totals.pricedTokens)
    expect(period.cost.unpricedTokens).toBe(diagnostics.totals.unpricedTokens)
    expect(diagnostics.reasonCounts.pre_effective_or_missing_rate).toBe('250000')
  })

  it('ignores observedAt-only provenance drift in the base identity', () => {
    const book = createDefaultState().priceBook
    const price = book.models['gpt-5.6-sol']!
    const first = {
      ...price,
      base: { ...price.base!, observedAt: '2026-08-19T01:00:00.000Z' }
    }
    const second = {
      ...price,
      base: { ...price.base!, observedAt: '2026-08-20T01:00:00.000Z' }
    }
    expect(aggregationInternals.pricingBaseIdentity(first)).toBe(aggregationInternals.pricingBaseIdentity(second))
  })
})

function historicalPricingFixture() {
  const state = createDefaultState()
  const modelId = 'gpt-5.6-sol'
  const eventAt = '2026-08-19T02:00:00.000Z'
  const currentEffectiveAt = '2026-08-20T00:00:00.000Z'
  const historicalEffectiveAt = '2026-08-18T00:00:00.000Z'
  const current = state.priceBook.models[modelId]!
  const currentR2 = {
    ...current,
    short: { ...current.short, inputMicroUsdPerMillion: '9000000' },
    base: current.base ? { ...current.base, effectiveAt: currentEffectiveAt } : undefined,
    longComponent: current.longComponent ? { ...current.longComponent, effectiveAt: currentEffectiveAt } : undefined
  }
  const historical = {
    ...current,
    short: { ...current.short, inputMicroUsdPerMillion: '1000000' },
    base: current.base ? { ...current.base, effectiveAt: historicalEffectiveAt } : undefined,
    longComponent: current.longComponent ? { ...current.longComponent, effectiveAt: historicalEffectiveAt } : undefined
  }
  state.priceBook.models[modelId] = currentR2
  state.pricingLedger = [{
    id: 'historical-r1',
    effectiveAt: historicalEffectiveAt,
    observedAt: '2026-08-18T01:00:00.000Z',
    source: 'test',
    sourceSha256: null,
    semanticHash: 'historical-r1',
    models: { [modelId]: historical }
  }]
  const usage = createEmptyStoredModelAggregate()
  usage.short = { input: '100', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100' }
  usage.bySpeed = { standard: { short: usage.short, long: usage.long, eventCount: 1, firstEventAt: eventAt } }
  state.sessions.historical = {
    sessionId: 'historical', path: 'historical.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
    currentModel: modelId, lastCumulative: null,
    daily: { '2026-08-19': { models: { [modelId]: usage } } },
    cycles: {}, eventCount: 1, parseErrors: 0
  }
  state.account.dailyUsageBuckets['2026-08-19'] = '100'
  return { state, modelId, eventAt, usage, historical }
}

function multiRevisionPricingFixture() {
  const state = createDefaultState()
  const modelId = 'gpt-5.6-sol'
  const firstEventAt = '2026-08-18T02:00:00.000Z'
  const secondEventAt = '2026-08-19T02:00:00.000Z'
  const current = state.priceBook.models[modelId]!
  const makeRevision = (rate: string, effectiveAt: string) => ({
    ...current,
    short: { ...current.short, inputMicroUsdPerMillion: rate },
    base: current.base ? { ...current.base, effectiveAt } : undefined,
    longComponent: current.longComponent ? { ...current.longComponent, effectiveAt } : undefined
  })
  const r1 = makeRevision('1', '2026-08-18T00:00:00.000Z')
  const r2 = makeRevision('5', '2026-08-19T00:00:00.000Z')
  const currentR2 = {
    ...current,
    short: { ...current.short, inputMicroUsdPerMillion: '5' },
    base: current.base ? { ...current.base, effectiveAt: '2026-08-20T00:00:00.000Z' } : undefined,
    longComponent: current.longComponent ? { ...current.longComponent, effectiveAt: '2026-08-20T00:00:00.000Z' } : undefined
  }
  state.priceBook.models[modelId] = currentR2
  state.pricingLedger = [
    {
      id: 'r1', effectiveAt: '2026-08-18T00:00:00.000Z', observedAt: '2026-08-18T01:00:00.000Z',
      source: 'test', sourceSha256: null, semanticHash: 'r1', models: { [modelId]: r1 }
    },
    {
      id: 'r2', effectiveAt: '2026-08-19T00:00:00.000Z', observedAt: '2026-08-19T01:00:00.000Z',
      source: 'test', sourceSha256: null, semanticHash: 'r2', models: { [modelId]: r2 }
    }
  ]
  const makeUsage = (eventAt: string) => {
    const usage = createEmptyStoredModelAggregate()
    usage.short = { input: '250000', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '250000' }
    usage.bySpeed = { standard: { short: usage.short, long: usage.long, eventCount: 1, firstEventAt: eventAt } }
    return usage
  }
  const firstUsage = makeUsage(firstEventAt)
  const secondUsage = makeUsage(secondEventAt)
  state.sessions.first = {
    sessionId: 'first', path: 'first.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
    currentModel: modelId, lastCumulative: null,
    daily: { '2026-08-18': { models: { [modelId]: firstUsage } } }, cycles: {}, eventCount: 1, parseErrors: 0
  }
  state.sessions.second = {
    sessionId: 'second', path: 'second.jsonl', offset: 0, fileSize: 0, modifiedAtMs: 0,
    currentModel: modelId, lastCumulative: null,
    daily: { '2026-08-19': { models: { [modelId]: secondUsage } } }, cycles: {}, eventCount: 1, parseErrors: 0
  }
  state.account.dailyUsageBuckets['2026-08-18'] = '250000'
  state.account.dailyUsageBuckets['2026-08-19'] = '250000'
  return { state, modelId, firstEventAt, secondEventAt, firstUsage, secondUsage, r1, r2 }
}
