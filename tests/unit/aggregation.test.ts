import { describe, expect, it } from 'vitest'
import {
  aggregationInternals,
  buildDashboardSnapshot,
  buildPeriod,
  estimateCapacity,
  estimateQuotaProjection
} from '../../src/main/aggregation.js'
import { createDefaultState, createEmptyStoredModelAggregate, type StoredCycleAggregate, type StoredSessionState } from '../../src/main/state.js'

describe('usage aggregation', () => {
  it('uses account daily totals while retaining local cost coverage', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = {
      input: '1000',
      cachedInput: '600',
      cacheWriteInput: '100',
      output: '100',
      reasoningOutput: '40',
      total: '1100'
    }
    state.sessions.session = {
      sessionId: 'session',
      path: 'test.jsonl',
      offset: 0,
      fileSize: 0,
      modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol',
      lastCumulative: null,
      daily: { '2026-08-19': { models: { 'gpt-5.6-sol': usage } } },
      cycles: {},
      eventCount: 1,
      parseErrors: 0
    }
    state.account.dailyUsageBuckets['2026-08-19'] = '2200'

    const period = buildPeriod(
      'today',
      Date.parse('2026-08-18T16:00:00Z'),
      Date.parse('2026-08-19T04:00:00Z'),
      state
    )
    expect(period.authoritativeTokens).toBe('2200')
    expect(period.tokens.total).toBe('1100')
    expect(period.cost.microUsd).toBe('5425')
    expect(period.cost.coveragePercent).toBe(50)
    expect(period.source).toBe('account')
  })

  it('normalizes valid reset cycles into a bounded range', () => {
    const makeCycle = (resetsAt: number, tokens: bigint, percent: number) => ({
      limitId: 'codex',
      resetsAt,
      windowDurationMins: 10080,
      models: {
        model: {
          short: {
            input: tokens,
            cachedInput: 0n,
            cacheWriteInput: 0n,
            output: 0n,
            reasoningOutput: 0n,
            total: tokens
          },
          long: {
            input: 0n,
            cachedInput: 0n,
            cacheWriteInput: 0n,
            output: 0n,
            reasoningOutput: 0n,
            total: 0n
          },
          eventCount: 3
        }
      },
      usedPercents: new Set([10, percent - 5, percent])
    })
    const cycles = [
      makeCycle(500, 3_000_000_000n, 50),
      makeCycle(400, 4_200_000_000n, 60),
      makeCycle(300, 5_600_000_000n, 80)
    ]
    const estimate = estimateCapacity(cycles, cycles[0]!)
    expect(estimate.sampleCount).toBe(3)
    expect(BigInt(estimate.medianTokens!)).toBeGreaterThan(6_000_000_000n)
    expect(estimate.confidence).toBe('medium')
  })

  it('drops obviously incomplete historical cycles relative to the current-cycle anchor', () => {
    const cycle = (resetsAt: number, tokens: bigint) => ({
      limitId: 'codex',
      resetsAt,
      windowDurationMins: 10080,
      models: {
        model: {
          short: {
            input: tokens,
            cachedInput: 0n,
            cacheWriteInput: 0n,
            output: 0n,
            reasoningOutput: 0n,
            total: tokens
          },
          long: {
            input: 0n,
            cachedInput: 0n,
            cacheWriteInput: 0n,
            output: 0n,
            reasoningOutput: 0n,
            total: 0n
          },
          eventCount: 3
        }
      },
      usedPercents: new Set([15, 30, 60])
    })
    const current = cycle(500, 4_000_000_000n)
    const estimate = estimateCapacity([current, cycle(400, 250_000n), cycle(300, 4_100_000_000n)], current)
    expect(BigInt(estimate.lowerTokens!)).toBeGreaterThan(5_000_000_000n)
    expect(estimate.sampleCount).toBe(2)
  })

  it('coalesces reset-second drift without crossing limit or window boundaries', () => {
    const state = createDefaultState()
    const reset = 1_800_000_000
    const currentTokens = 5_902_241_585n
    state.rateLimits = [rateLimit(reset, 82)]
    state.sessions.fragments = sessionWithCycles([
      cycle(reset - 3, '1900000000', 82, 10_080, [20]),
      cycle(reset - 2, '2000000000', 82, 10_080, [50]),
      cycle(reset - 1, '2002241585', 82, 10_080, [82]),
      cycle(reset + 6, '999999999', 82),
      cycle(reset, '999999999', 82, 60)
    ])

    const snapshot = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    const cycles = aggregationInternals.aggregateCycles(state)
    const matching = cycles.filter((item) => item.limitId === 'codex' && item.windowDurationMins === 10_080)
    const current = matching.find((item) => item.resetsAt === reset - 1)

    expect(matching).toHaveLength(2)
    expect(current).toBeDefined()
    expect(current ? aggregationInternals.sumModels(current.models).total.toString() : null).toBe(currentTokens.toString())
    expect(snapshot.reset.tokensSinceReset.total).toBe(currentTokens.toString())
    expect(snapshot.reset.capacity.projectedTokens).toBe('7197855591')
    expect(snapshot.reset.capacity.lowerTokens).toBeNull()
    expect(snapshot.reset.capacity.basisUsedPercent).toBe(82)
    expect(snapshot.reset.capacity.confidence).toBe('medium')
    const historicalCompatible = estimateCapacity(matching, current!)
    expect(historicalCompatible.sampleCount).toBe(1)
    expect(historicalCompatible.medianTokens).toBe('7197855591')
  })

  it('rejects future and expired reset buckets before selecting or pricing a cycle', () => {
    const reset = 1_800_000_000
    const now = reset * 1_000
    for (const [label, bucketReset, checkAt] of [
      ['future', reset + 1_000_000, now],
      ['expired', reset - 1_000_000, now]
    ] as const) {
      const state = createDefaultState()
      state.rateLimits = [rateLimit(bucketReset, 82)]
      state.sessions[label] = sessionWithCycles([cycle(bucketReset, '999999999', 82)])
      const snapshot = buildDashboardSnapshot(
        state,
        { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
        null,
        checkAt
      )
      expect(snapshot.reset.tokensSinceReset.total, label).toBe('0')
      expect(snapshot.reset.capacity.projectedTokens, label).toBeNull()
      expect(snapshot.reset.currentWeekEstimate.observedMicroUsd, label).toBeNull()
      expect(snapshot.reset.currentWeekEstimate.estimatedTotalMicroUsd, label).toBeNull()
      expect(snapshot.reset.projection.status, label).toBe('unavailable')
    }
  })

  it('estimates current-reset-week USD and ignores historical cycle cost', () => {
    const reset = 1_800_000_000
    const state = createDefaultState()
    state.rateLimits = [rateLimit(reset, 25)]
    const currentCycle = cycle(reset, '1000000', 25)
    state.sessions.current = sessionWithCycles([currentCycle])
    const baseline = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    const currentEstimate = baseline.reset.currentWeekEstimate
    expect(currentEstimate.observedMicroUsd).not.toBeNull()
    expect(currentEstimate.priceCoveragePercent).toBe(100)
    expect(currentEstimate.basisUsedPercent).toBe(25)
    expect(currentEstimate.lowerBound).toBe(false)
    const observed = BigInt(currentEstimate.observedMicroUsd!)
    const expectedTotal = (observed * 4n)
    expect(currentEstimate.estimatedTotalMicroUsd).toBe(expectedTotal.toString())
    expect(currentEstimate.estimatedRemainingMicroUsd).toBe((expectedTotal - observed).toString())

    state.sessions.historical = sessionWithCycles([cycle(reset - 20_000, '999999999999', 90)])
    const withHistory = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(withHistory.reset.currentWeekEstimate).toEqual(currentEstimate)
    expect(withHistory.reset.capacity.projectedTokens).toBe(baseline.reset.capacity.projectedTokens)

    const partial = createDefaultState()
    partial.rateLimits = [rateLimit(reset, 50)]
    partial.sessions.partial = sessionWithCycles([cycle(reset, '1000000', 50)])
    const partialUsage = partial.sessions.partial.cycles[`codex:${reset}:10080`]!.models['gpt-5.6-sol']!
    partialUsage.unknown = { input: '100000', cachedInput: '0', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '100000' }
    const partialEstimate = buildDashboardSnapshot(
      partial,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    ).reset.currentWeekEstimate
    expect(partialEstimate.observedMicroUsd).not.toBeNull()
    expect(partialEstimate.priceCoveragePercent).toBeLessThan(100)
    expect(partialEstimate.lowerBound).toBe(true)
  })

  it('scales summed attoUSD before one final microUSD round and rejects over-100 input', () => {
    const reset = 1_800_000_000
    const state = createDefaultState()
    const model = state.priceBook.models['gpt-5.6-sol']!
    model.short.cachedInputMicroUsdPerMillion = '500000'
    const fractional = cycle(reset, '1', 1)
    const fractionalUsage = fractional.models['gpt-5.6-sol']!
    fractionalUsage.short = { input: '1', cachedInput: '1', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '1' }
    state.rateLimits = [rateLimit(reset, 1)]
    state.sessions.fractional = sessionWithCycles([fractional])
    const snapshot = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(snapshot.reset.currentWeekEstimate.observedMicroUsd).toBe('1')
    expect(snapshot.reset.currentWeekEstimate.estimatedTotalMicroUsd).toBe('50')
    expect(snapshot.reset.currentWeekEstimate.estimatedRemainingMicroUsd).toBe('49')

    const tiny = createDefaultState()
    const tinySource = cycle(reset, '1', 1)
    const tinyUsage = tinySource.models['gpt-5.6-sol']!
    const tinyCycle = { ...tinySource, models: { 'gpt-5.6-luna': tinyUsage } }
    tinyUsage.short = { input: '1', cachedInput: '1', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '1' }
    tiny.rateLimits = [rateLimit(reset, 1)]
    tiny.sessions.tiny = sessionWithCycles([tinyCycle])
    const tinyEstimate = buildDashboardSnapshot(
      tiny,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    ).reset.currentWeekEstimate
    expect(tinyEstimate.observedMicroUsd).toBe('0')
    expect(tinyEstimate.estimatedTotalMicroUsd).toBe('2')
    expect(tinyEstimate.estimatedRemainingMicroUsd).toBe('2')

    const over = createDefaultState()
    over.priceBook.models['gpt-5.6-sol']!.short.cachedInputMicroUsdPerMillion = '500000'
    const overCycle = cycle(reset, '1', 200)
    overCycle.models['gpt-5.6-sol']!.short = { input: '1', cachedInput: '1', cacheWriteInput: '0', output: '0', reasoningOutput: '0', total: '1' }
    over.rateLimits = [rateLimit(reset, 200)]
    over.sessions.over = sessionWithCycles([overCycle])
    const overSnapshot = buildDashboardSnapshot(
      over,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(overSnapshot.reset.capacity.projectedTokens).toBeNull()
    expect(overSnapshot.reset.currentWeekEstimate.observedMicroUsd).toBeNull()
    expect(overSnapshot.reset.currentWeekEstimate.estimatedTotalMicroUsd).toBeNull()
    expect(overSnapshot.reset.currentWeekEstimate.estimatedRemainingMicroUsd).toBeNull()
  })

  it('preserves per-cycle pricing segments and fails closed when one spans revisions', () => {
    const reset = 1_800_000_000
    const modelId = 'gpt-5.6-sol'
    const state = createDefaultState()
    const current = state.priceBook.models[modelId]!
    const historical = {
      ...current,
      short: { ...current.short, inputMicroUsdPerMillion: '1000000' },
      base: current.base ? { ...current.base, effectiveAt: '2026-08-18T00:00:00.000Z' } : undefined,
      longComponent: current.longComponent ? { ...current.longComponent, effectiveAt: '2026-08-18T00:00:00.000Z' } : undefined
    }
    state.pricingLedger = [
      {
        id: 'historical',
        effectiveAt: '2026-08-18T00:00:00.000Z',
        observedAt: '2026-08-18T01:00:00.000Z',
        source: 'test',
        sourceSha256: null,
        semanticHash: 'historical',
        models: { [modelId]: historical }
      },
      {
        id: 'current',
        effectiveAt: '2026-08-19T00:00:00.000Z',
        observedAt: '2026-08-19T01:00:00.000Z',
        source: 'test',
        sourceSha256: null,
        semanticHash: 'current',
        models: { [modelId]: current }
      }
    ]
    state.rateLimits = [rateLimit(reset, 50)]
    const first = cycleWithEvent(reset - 2, '1000000', 50, '2026-08-18T02:00:00.000Z')
    const second = cycleWithEvent(reset - 1, '1000000', 50, '2026-08-20T02:00:00.000Z')
    state.sessions.first = sessionWithCycles([first])
    state.sessions.second = sessionWithCycles([second])
    const preserved = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(preserved.reset.currentWeekEstimate.observedMicroUsd).toBe('6000000')
    expect(preserved.reset.currentWeekEstimate.priceCoveragePercent).toBe(100)

    const spanning = createDefaultState()
    spanning.pricingLedger = state.pricingLedger
    spanning.rateLimits = [rateLimit(reset, 50)]
    spanning.sessions.spanning = sessionWithCycles([cycleWithEvent(reset, '2000000', 50, '2026-08-18T02:00:00.000Z', '2026-08-20T02:00:00.000Z')])
    const closed = buildDashboardSnapshot(
      spanning,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(closed.reset.currentWeekEstimate.observedMicroUsd).toBeNull()
    expect(closed.reset.currentWeekEstimate.priceCoveragePercent).toBe(0)
    expect(closed.reset.currentWeekEstimate.lowerBound).toBe(true)
  })

  it('returns N/A for zero or unavailable current reset inputs and marks unpriced as lower bound', () => {
    const reset = 1_800_000_000
    const state = createDefaultState()
    state.rateLimits = [rateLimit(reset, 0)]
    state.sessions.zero = sessionWithCycles([cycle(reset, '1000000', 0)])
    const zero = buildDashboardSnapshot(
      state,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(zero.reset.capacity.projectedTokens).toBeNull()
    expect(zero.reset.currentWeekEstimate.observedMicroUsd).toBeNull()
    expect(zero.reset.currentWeekEstimate.estimatedTotalMicroUsd).toBeNull()
    expect(zero.reset.currentWeekEstimate.basisUsedPercent).toBeNull()

    const unpriced = createDefaultState()
    unpriced.rateLimits = [rateLimit(reset, 82)]
    const legacy = sessionWithCycles([cycle(reset, '1000000', 82)])
    legacy.legacyUnpriced = true
    unpriced.sessions.legacy = legacy
    const lowerBound = buildDashboardSnapshot(
      unpriced,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(lowerBound.reset.currentWeekEstimate.observedMicroUsd).toBeNull()
    expect(lowerBound.reset.currentWeekEstimate.estimatedRemainingMicroUsd).toBeNull()
    expect(lowerBound.reset.currentWeekEstimate.basisUsedPercent).toBe(82)
    expect(lowerBound.reset.currentWeekEstimate.priceCoveragePercent).toBe(0)
    expect(lowerBound.reset.currentWeekEstimate.lowerBound).toBe(true)

    const lowConfidence = createDefaultState()
    lowConfidence.rateLimits = [rateLimit(reset, 5)]
    lowConfidence.sessions.current = sessionWithCycles([cycle(reset, '1000000', 5)])
    const low = buildDashboardSnapshot(
      lowConfidence,
      { appServer: 'offline', appServerMessage: null, indexing: 'idle', indexedFiles: 0, totalFiles: 0 },
      null,
      reset * 1_000 - 60_000
    )
    expect(low.reset.capacity.projectedTokens).toBe('20000000')
    expect(low.reset.capacity.confidence).toBe('low')
  })

  it('projects current-week quota usage from elapsed time', () => {
    const start = Date.parse('2026-08-17T00:00:00Z')
    const reset = Date.parse('2026-08-24T00:00:00Z')
    const halfway = start + (reset - start) / 2

    expect(estimateQuotaProjection(25, start, reset, halfway)).toEqual({
      status: 'lasts-until-reset',
      projectedUsedPercent: 50
    })
    expect(estimateQuotaProjection(50, start, reset, halfway)).toEqual({
      status: 'full-at-reset',
      projectedUsedPercent: 100
    })
    expect(estimateQuotaProjection(60, start, reset, halfway)).toEqual({
      status: 'exhausts-before-reset',
      projectedUsedPercent: 120
    })
    expect(estimateQuotaProjection(0, start, reset, start)).toEqual({
      status: 'lasts-until-reset',
      projectedUsedPercent: 0
    })
  })

  it('handles early high usage and unavailable reset windows', () => {
    const start = Date.parse('2026-08-17T00:00:00Z')
    const reset = Date.parse('2026-08-24T00:00:00Z')
    const afterOneMinute = start + 60_000

    expect(estimateQuotaProjection(1, start, reset, afterOneMinute)).toEqual({
      status: 'exhausts-before-reset',
      projectedUsedPercent: 10_080
    })
    expect(estimateQuotaProjection(null, start, reset, afterOneMinute).status).toBe('unavailable')
    expect(estimateQuotaProjection(10, start, reset, start - 1).status).toBe('unavailable')
    expect(estimateQuotaProjection(10, start, reset, reset).status).toBe('unavailable')
  })

  it('adds the primary Codex projection to the dashboard snapshot', () => {
    const state = createDefaultState()
    const start = Date.parse('2026-08-17T00:00:00Z')
    const reset = Date.parse('2026-08-24T00:00:00Z')
    const halfway = start + (reset - start) / 2
    state.rateLimits = [{
      limitId: 'codex',
      limitName: 'Codex',
      primary: {
        usedPercent: 60,
        windowDurationMins: 10_080,
        resetsAt: reset / 1_000
      },
      secondary: null,
      planType: null,
      rateLimitReachedType: null
    }]

    const snapshot = buildDashboardSnapshot(
      state,
      {
        appServer: 'online',
        appServerMessage: null,
        indexing: 'idle',
        indexedFiles: 0,
        totalFiles: 0
      },
      null,
      halfway
    )
    expect(snapshot.reset.projection).toEqual({
      status: 'exhausts-before-reset',
      projectedUsedPercent: 120
    })
    expect(snapshot.reset.capacity.sampleCount).toBe(0)
  })

  it('uses rolling HKT days and keeps invalid account buckets out of the trend', () => {
    const state = createDefaultState()
    const usage = createEmptyStoredModelAggregate()
    usage.short = {
      input: '12',
      cachedInput: '0',
      cacheWriteInput: '0',
      output: '0',
      reasoningOutput: '0',
      total: '12'
    }
    state.sessions.local = {
      sessionId: 'local',
      path: 'local.jsonl',
      offset: 0,
      fileSize: 0,
      modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol',
      lastCumulative: null,
      daily: {
        '2026-08-10': { models: { 'gpt-5.6-sol': usage } },
        '2026-08-16': { models: { 'gpt-5.6-sol': usage } }
      },
      cycles: {},
      eventCount: 2,
      parseErrors: 0
    }
    state.account.dailyUsageBuckets = {
      '2026-08-17': '-1',
      '2026-08-18': '0',
      '2026-08-19': 'not-a-number'
    }

    const period = buildPeriod(
      'week',
      Date.parse('2026-08-10T16:00:00Z'),
      Date.parse('2026-08-19T02:30:00Z'),
      state
    )

    expect(period.startAt).toBe('2026-08-12T16:00:00.000Z')
    expect(period.tokens.total).toBe('12')
    expect(period.authoritativeTokens).toBe('12')
    expect(period.dailyUsage).toEqual([
      { date: '2026-08-13', tokens: null, source: 'unavailable' },
      { date: '2026-08-14', tokens: null, source: 'unavailable' },
      { date: '2026-08-15', tokens: null, source: 'unavailable' },
      { date: '2026-08-16', tokens: '12', source: 'local' },
      { date: '2026-08-17', tokens: null, source: 'unavailable' },
      { date: '2026-08-18', tokens: '0', source: 'account' },
      { date: '2026-08-19', tokens: null, source: 'unavailable' }
    ])
    expect(period.dailyUsage).toHaveLength(7)
    expect(period.models[0]?.tokens.total).toBe('12')
  })

  it('keeps Today without a trend payload while month uses exactly 30 dates', () => {
    const state = createDefaultState()
    const now = Date.parse('2026-08-19T10:30:00+08:00')
    const today = buildPeriod('today', Date.parse('2026-08-18T16:00:00Z'), now, state)
    const month = buildPeriod('month', Date.parse('2026-08-01T16:00:00Z'), now, state)

    expect(today.dailyUsage).toBeUndefined()
    expect(month.dailyUsage).toHaveLength(30)
    expect(month.dailyUsage?.[0]?.date).toBe('2026-07-21')
    expect(month.dailyUsage?.at(-1)?.date).toBe('2026-08-19')
  })

  it('labels rolling periods with their shared 7/30-day metadata', () => {
    const state = createDefaultState()
    const now = Date.parse('2027-01-01T00:30:00+08:00')

    expect(buildPeriod('week', now - 6 * 24 * 60 * 60 * 1_000, now, state).label).toBe('Last 7 days')
    expect(buildPeriod('month', now - 29 * 24 * 60 * 60 * 1_000, now, state).label).toBe('Last 30 days')
  })

  it('preserves leading-zero account point strings while summing authoritative tokens numerically', () => {
    const state = createDefaultState()
    state.account.dailyUsageBuckets['2026-12-31'] = '00007'
    const period = buildPeriod(
      'week',
      Date.parse('2026-12-26T00:00:00+08:00'),
      Date.parse('2027-01-01T00:30:00+08:00'),
      state
    )

    expect(period.authoritativeTokens).toBe('7')
    expect(period.dailyUsage?.find((point) => point.date === '2026-12-31')).toEqual({
      date: '2026-12-31',
      tokens: '00007',
      source: 'account'
    })
  })

  it('treats a present zero-token local aggregate as known local zero', () => {
    const state = createDefaultState()
    state.sessions.zero = {
      sessionId: 'zero',
      path: 'zero.jsonl',
      offset: 0,
      fileSize: 0,
      modifiedAtMs: 0,
      currentModel: 'gpt-5.6-sol',
      lastCumulative: null,
      daily: { '2027-01-01': { models: { 'gpt-5.6-sol': createEmptyStoredModelAggregate() } } },
      cycles: {},
      eventCount: 0,
      parseErrors: 0
    }
    const period = buildPeriod(
      'week',
      Date.parse('2026-12-26T00:00:00+08:00'),
      Date.parse('2027-01-01T00:30:00+08:00'),
      state
    )

    expect(period.dailyUsage?.at(-1)).toEqual({ date: '2027-01-01', tokens: '0', source: 'local' })
  })
})

function rateLimit(resetsAt: number, usedPercent: number) {
  return {
    limitId: 'codex',
    limitName: 'Codex',
    primary: { usedPercent, windowDurationMins: 10_080, resetsAt },
    secondary: null,
    planType: null,
    rateLimitReachedType: null
  }
}

function cycle(
  resetsAt: number,
  total: string,
  usedPercent: number,
  windowDurationMins = 10_080,
  usedPercents: number[] = [usedPercent]
): StoredCycleAggregate {
  const usage = createEmptyStoredModelAggregate()
  usage.short = {
    input: total,
    cachedInput: '0',
    cacheWriteInput: '0',
    output: '0',
    reasoningOutput: '0',
    total
  }
  return {
    limitId: 'codex',
    resetsAt,
    windowDurationMins,
    models: { 'gpt-5.6-sol': usage },
    usedPercents,
    firstSampleAt: '2026-08-19T02:00:00.000Z',
    lastSampleAt: '2026-08-19T02:00:00.000Z'
  }
}

function cycleWithEvent(
  resetsAt: number,
  total: string,
  usedPercent: number,
  firstEventAt: string,
  lastEventAt = firstEventAt
): ReturnType<typeof cycle> {
  const result = cycle(resetsAt, total, usedPercent)
  const usage = result.models['gpt-5.6-sol']!
  usage.eventCount = 1
  usage.firstEventAt = firstEventAt
  usage.lastEventAt = lastEventAt
  usage.bySpeed = {
    standard: {
      short: usage.short,
      long: usage.long,
      eventCount: 1,
      firstEventAt,
      lastEventAt
    }
  }
  return result
}

function sessionWithCycles(cycles: StoredCycleAggregate[]): StoredSessionState {
  return {
    sessionId: 'session',
    path: 'test.jsonl',
    offset: 0,
    fileSize: 0,
    modifiedAtMs: 0,
    currentModel: 'gpt-5.6-sol',
    lastCumulative: null,
    daily: {},
    cycles: Object.fromEntries(cycles.map((item) => [`codex:${item.resetsAt}:${item.windowDurationMins}`, item])),
    eventCount: cycles.length,
    parseErrors: 0
  }
}
