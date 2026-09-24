import type { QuotaState } from './quota-state.js'
import { MAX_QUOTA_OBSERVATIONS } from './quota-state.js'
import { estimateQuotaProjection } from '../shared/quota-projection.js'

/** Record only actual successful rate-limit reads in the active primary window. */
export function recordQuotaObservation(state: QuotaState, observedAtMs: number): void {
  const bucket = state.rateLimits.find((item) => item.limitId === 'codex') ?? state.rateLimits[0]
  const window = bucket?.primary
  if (!bucket || !window || !Number.isFinite(observedAtMs) ||
    !Number.isFinite(window.usedPercent) || window.usedPercent < 0 ||
    !Number.isFinite(window.resetsAt) || !Number.isFinite(window.windowDurationMins) ||
    window.windowDurationMins <= 0) return

  const startsAtMs = window.resetsAt * 1_000 - window.windowDurationMins * 60_000
  if (observedAtMs < startsAtMs || observedAtMs >= window.resetsAt * 1_000) return

  const history = state.quotaHistory
  if (!history || history.limitId !== bucket.limitId || history.resetsAt !== window.resetsAt ||
    history.windowDurationMins !== window.windowDurationMins) {
    state.quotaHistory = {
      limitId: bucket.limitId,
      resetsAt: window.resetsAt,
      windowDurationMins: window.windowDurationMins,
      observations: []
    }
  }

  const observations = state.quotaHistory!.observations
  const last = observations[observations.length - 1]
  if (last && observedAtMs < Date.parse(last.at)) return
  const point = {
    at: new Date(observedAtMs).toISOString(),
    usedPercent: window.usedPercent,
    projectedUsedPercent: estimateQuotaProjection(
      window.usedPercent, startsAtMs, window.resetsAt * 1_000, observedAtMs
    ).projectedUsedPercent
  }
  if (last && Math.floor(Date.parse(last.at) / 60_000) === Math.floor(observedAtMs / 60_000)) {
    observations[observations.length - 1] = point
  } else {
    observations.push(point)
    if (observations.length > MAX_QUOTA_OBSERVATIONS) observations.shift()
  }
}
