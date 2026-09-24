import type { RateLimitWindow } from '../shared/contracts.js'
import type { QuotaCycleHistory, QuotaState } from './quota-state.js'
import { MAX_QUOTA_OBSERVATIONS, RESET_TIME_TOLERANCE_SECONDS } from './quota-state.js'
import { estimateQuotaProjection } from '../shared/quota-projection.js'

/** Allow small App Server corrections without treating them as a new quota cycle. */
export function isSameQuotaCycle(
  history: QuotaCycleHistory | null,
  limitId: string,
  window: RateLimitWindow
): boolean {
  return history !== null && history.limitId === limitId &&
    history.windowDurationMins === window.windowDurationMins &&
    Math.abs(history.resetsAt - window.resetsAt) <= RESET_TIME_TOLERANCE_SECONDS
}

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
  if (!isSameQuotaCycle(history, bucket.limitId, window)) {
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
