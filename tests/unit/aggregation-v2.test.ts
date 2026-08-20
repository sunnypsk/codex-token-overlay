import { describe, expect, it } from 'vitest'
import { buildDashboardSnapshot, buildPeriod } from '../../src/main/aggregation.js'
import { createDefaultState, createEmptyStoredModelAggregate } from '../../src/main/state.js'

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
})
