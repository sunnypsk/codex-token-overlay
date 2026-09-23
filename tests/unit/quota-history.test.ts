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
      { at: new Date(start + 95_000).toISOString(), usedPercent: 12 },
      { at: new Date(start + 121_000).toISOString(), usedPercent: 18 }
    ])
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
