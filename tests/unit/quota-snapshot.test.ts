import { describe, expect, it } from 'vitest'
import { buildQuotaSnapshot } from '../../src/main/quota-snapshot.js'
import { createDefaultQuotaState } from '../../src/main/quota-state.js'

const now = Date.UTC(2026, 8, 23, 12)
const weekMinutes = 7 * 24 * 60
const resetSeconds = (now + 3.5 * 24 * 60 * 60_000) / 1_000

function stateWithLimits(usedPercent = 25) {
  const state = createDefaultQuotaState()
  state.rateLimitsSyncedAt = new Date(now - 20_000).toISOString()
  state.rateLimits = [
    {
      limitId: 'codex', limitName: 'Codex', planType: null, rateLimitReachedType: null,
      primary: { usedPercent, windowDurationMins: weekMinutes, resetsAt: resetSeconds }, secondary: null
    },
    {
      limitId: 'extra', limitName: 'Other limit', planType: null, rateLimitReachedType: null,
      primary: { usedPercent: 10, windowDurationMins: weekMinutes, resetsAt: resetSeconds }, secondary: null
    }
  ]
  return state
}

describe('quota snapshot', () => {
  it('shows live percentages and the existing current-window pace projection', () => {
    const snapshot = buildQuotaSnapshot(stateWithLimits(), { appServer: 'online', message: null }, now)
    expect(snapshot.reset.usedPercent).toBe(25)
    expect(snapshot.reset.projection).toEqual({ status: 'lasts-until-reset', projectedUsedPercent: 50 })
    expect(snapshot.additionalLimits).toEqual([{ limitId: 'extra', label: 'Other limit', usedPercent: 10, resetsAt: resetSeconds }])
    expect(snapshot.stale).toBe(false)
    expect(snapshot.reset.startsAt).toBe(new Date(resetSeconds * 1_000 - weekMinutes * 60_000).toISOString())
    expect(snapshot.reset.observations).toEqual([])
    expect(Object.keys(snapshot)).not.toContain('periods')
  })

  it.each([[25, 50], [50, 100], [75, 150]])('matches the last observation and projects %i%% to %i%%', (used, expected) => {
    const state = stateWithLimits(used)
    const observedAt = now - 20_000
    state.quotaHistory = { limitId: 'codex', resetsAt: resetSeconds, windowDurationMins: weekMinutes,
      observations: [{ at: new Date(observedAt).toISOString(), usedPercent: used }] }
    const snapshot = buildQuotaSnapshot(state, { appServer: 'online', message: null }, now)
    expect(snapshot.reset.observations).toEqual(state.quotaHistory.observations)
    expect(snapshot.reset.projection.projectedUsedPercent).toBe(expected)
  })

  it('keeps the last active percentage but suppresses forecasts while offline or old', () => {
    const offline = buildQuotaSnapshot(stateWithLimits(), { appServer: 'offline', message: 'Disconnected' }, now)
    expect(offline.reset.usedPercent).toBe(25)
    expect(offline.reset.projection.status).toBe('unavailable')
    expect(offline.stale).toBe(true)

    const withHistory = stateWithLimits()
    withHistory.quotaHistory = { limitId: 'codex', resetsAt: resetSeconds, windowDurationMins: weekMinutes,
      observations: [{ at: new Date(now - 20_000).toISOString(), usedPercent: 25, projectedUsedPercent: 50 }] }
    expect(buildQuotaSnapshot(withHistory, { appServer: 'offline', message: 'Disconnected' }, now).reset.observations)
      .toEqual(withHistory.quotaHistory.observations)

    const old = stateWithLimits()
    old.rateLimitsSyncedAt = new Date(now - 121_000).toISOString()
    expect(buildQuotaSnapshot(old, { appServer: 'online', message: null }, now).reset.projection.status).toBe('unavailable')
  })

  it('shows existing observations while the reset timestamp shifts by a second', () => {
    const state = stateWithLimits()
    const observation = { at: new Date(now - 20_000).toISOString(), usedPercent: 25, projectedUsedPercent: 50 }
    state.quotaHistory = { limitId: 'codex', resetsAt: resetSeconds, windowDurationMins: weekMinutes,
      observations: [observation] }
    state.rateLimits[0]!.primary!.resetsAt = resetSeconds + 1

    expect(buildQuotaSnapshot(state, { appServer: 'online', message: null }, now).reset.observations)
      .toEqual([observation])

    state.rateLimits[0]!.primary!.resetsAt = resetSeconds + 3600
    expect(buildQuotaSnapshot(state, { appServer: 'online', message: null }, now).reset.observations)
      .toEqual([])
  })

  it('hides expired and missing windows instead of showing a false zero', () => {
    const expired = buildQuotaSnapshot(stateWithLimits(), { appServer: 'online', message: null }, resetSeconds * 1_000)
    expect(expired.reset.usedPercent).toBeNull()
    expect(expired.reset.resetsAt).toBeNull()
    expect(expired.reset.observations).toEqual([])
    expect(expired.reset.projection.status).toBe('unavailable')
    expect(expired.additionalLimits[0]?.usedPercent).toBeNull()

    const missing = buildQuotaSnapshot(createDefaultQuotaState(), { appServer: 'connecting', message: null }, now)
    expect(missing.reset.usedPercent).toBeNull()
    expect(missing.reset.projection.status).toBe('unavailable')

    const zero = buildQuotaSnapshot(stateWithLimits(0), { appServer: 'online', message: null }, now)
    expect(zero.reset.usedPercent).toBe(0)
    expect(zero.reset.projection.projectedUsedPercent).toBe(0)
  })
})
