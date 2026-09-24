import { describe, expect, it } from 'vitest'
import { recordQuotaObservation } from '../../src/main/quota-history.js'
import { createDefaultQuotaState } from '../../src/main/quota-state.js'

const start = Date.UTC(2026, 8, 23, 0)
const durationMins = 60
const reset = (start + durationMins * 60_000) / 1_000

function stateWithWindow() {
  const state = createDefaultQuotaState()
  state.rateLimits = [{ limitId: 'codex', limitName: 'Codex', planType: null, rateLimitReachedType: null,
    primary: { usedPercent: 0, windowDurationMins: durationMins, resetsAt: reset }, secondary: null }]
  return state
}

describe('quota observations', () => {
  it('records real syncs while collapsed and replaces readings in the same minute', () => {
    const state = stateWithWindow()
    recordQuotaObservation(state, start + 61_000)
    state.rateLimits[0]!.primary!.usedPercent = 12
    recordQuotaObservation(state, start + 95_000)
    state.rateLimits[0]!.primary!.usedPercent = 18
    recordQuotaObservation(state, start + 121_000)
    expect(state.quotaHistory?.observations).toEqual([
      { at: new Date(start + 95_000).toISOString(), usedPercent: 12, projectedUsedPercent: 454.7 },
      { at: new Date(start + 121_000).toISOString(), usedPercent: 18, projectedUsedPercent: 535.5 }
    ])
  })

  it('keeps each sync\'s reset forecast when later usage changes', () => {
    const state = stateWithWindow()
    state.rateLimits[0]!.primary!.usedPercent = 40
    recordQuotaObservation(state, start + 15 * 60_000)
    state.rateLimits[0]!.primary!.usedPercent = 60
    recordQuotaObservation(state, start + 30 * 60_000)
    expect(state.quotaHistory?.observations).toEqual([
      { at: new Date(start + 15 * 60_000).toISOString(), usedPercent: 40, projectedUsedPercent: 160 },
      { at: new Date(start + 30 * 60_000).toISOString(), usedPercent: 60, projectedUsedPercent: 120 }
    ])
  })

  it('records zero usage and an unavailable projection at the exact window start', () => {
    const state = stateWithWindow()
    recordQuotaObservation(state, start)
    expect(state.quotaHistory?.observations[0]?.projectedUsedPercent).toBe(0)
    state.rateLimits[0]!.primary!.usedPercent = 1
    recordQuotaObservation(state, start)
    expect(state.quotaHistory?.observations[0]?.projectedUsedPercent).toBeNull()
    recordQuotaObservation(state, start + 30_000)
    expect(state.quotaHistory?.observations[0]?.projectedUsedPercent).toBe(120)
  })

  it('starts a fresh history when the reset or window duration changes', () => {
    const state = stateWithWindow()
    recordQuotaObservation(state, start + 60_000)
    state.rateLimits[0]!.primary!.resetsAt = reset + 3600
    recordQuotaObservation(state, start + 61 * 60_000)
    expect(state.quotaHistory?.observations).toHaveLength(1)
    expect(state.quotaHistory?.resetsAt).toBe(reset + 3600)

    state.rateLimits[0]!.primary!.windowDurationMins = 120
    recordQuotaObservation(state, start + 62 * 60_000)
    expect(state.quotaHistory?.observations).toHaveLength(1)
    expect(state.quotaHistory?.windowDurationMins).toBe(120)

    state.rateLimits[0]!.limitId = 'another-limit'
    recordQuotaObservation(state, start + 63 * 60_000)
    expect(state.quotaHistory?.limitId).toBe('another-limit')
    expect(state.quotaHistory?.observations).toHaveLength(1)
  })

  it('ignores invalid or expired windows without inventing observations', () => {
    const state = stateWithWindow()
    recordQuotaObservation(state, start - 1)
    recordQuotaObservation(state, reset * 1_000)
    state.rateLimits[0]!.primary!.usedPercent = Number.NaN
    recordQuotaObservation(state, start + 60_000)
    expect(state.quotaHistory).toBeNull()
  })
})
