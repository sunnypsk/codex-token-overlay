import { describe, expect, it } from 'vitest'
import {
  buildDashboardSnapshot,
  buildPeriod,
  estimateCapacity,
  estimateQuotaProjection
} from '../../src/main/aggregation.js'
import { createDefaultState, createEmptyStoredModelAggregate } from '../../src/main/state.js'

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
})
