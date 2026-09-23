import type { ConnectionState, QuotaSnapshot, RateLimitWindow } from '../shared/contracts.js'
import { estimateQuotaProjection } from '../shared/quota-projection.js'
import type { QuotaState } from './quota-state.js'

const STALE_AFTER_MS = 2 * 60_000

export interface QuotaRuntimeStatus {
  appServer: ConnectionState
  message: string | null
}

export function buildQuotaSnapshot(
  state: QuotaState,
  runtime: QuotaRuntimeStatus,
  nowMs = Date.now()
): QuotaSnapshot {
  const syncedAtMs = state.rateLimitsSyncedAt === null ? Number.NaN : Date.parse(state.rateLimitsSyncedAt)
  const stale = runtime.appServer !== 'online' || !Number.isFinite(syncedAtMs) ||
    syncedAtMs > nowMs || nowMs - syncedAtMs > STALE_AFTER_MS
  const primaryBucket = state.rateLimits.find((bucket) => bucket.limitId === 'codex') ?? state.rateLimits[0] ?? null
  const window = activeWindow(primaryBucket?.primary ?? null, nowMs)
  const resetMs = window === null ? null : window.resetsAt * 1_000
  const startMs = window === null ? null : resetMs! - window.windowDurationMins * 60_000
  const history = state.quotaHistory
  const observations = window && history && history.limitId === primaryBucket?.limitId &&
    history.resetsAt === window.resetsAt && history.windowDurationMins === window.windowDurationMins
    ? history.observations.map((point) => ({ ...point })) : []
  const latestAtMs = observations.length > 0
    ? Date.parse(observations[observations.length - 1]!.at) : syncedAtMs

  return {
    generatedAt: new Date(nowMs).toISOString(),
    reset: {
      limitId: primaryBucket?.limitId ?? null,
      usedPercent: window?.usedPercent ?? null,
      startsAt: startMs === null ? null : new Date(startMs).toISOString(),
      resetsAt: resetMs === null ? null : new Date(resetMs).toISOString(),
      projection: stale
        ? { status: 'unavailable', projectedUsedPercent: null }
        : estimateQuotaProjection(window?.usedPercent ?? null, startMs, resetMs, latestAtMs),
      observations
    },
    additionalLimits: state.rateLimits
      .filter((bucket) => bucket.limitId !== primaryBucket?.limitId)
      .map((bucket) => {
        const active = activeWindow(bucket.primary, nowMs)
        return {
          limitId: bucket.limitId,
          label: bucket.limitName ?? bucket.limitId,
          usedPercent: active?.usedPercent ?? null,
          resetsAt: active?.resetsAt ?? null
        }
      }),
    connection: runtime.appServer,
    connectionMessage: runtime.message,
    rateLimitsSyncedAt: state.rateLimitsSyncedAt,
    stale,
    settings: { ...state.settings }
  }
}

function activeWindow(window: RateLimitWindow | null, nowMs: number): RateLimitWindow | null {
  if (
    window === null || !Number.isFinite(window.usedPercent) ||
    !Number.isFinite(window.windowDurationMins) || window.windowDurationMins <= 0 ||
    !Number.isFinite(window.resetsAt) || window.resetsAt * 1_000 <= nowMs ||
    window.resetsAt * 1_000 - window.windowDurationMins * 60_000 > nowMs
  ) return null
  return window
}

export const quotaSnapshotConstants = { STALE_AFTER_MS }
