import type { QuotaProjection } from './contracts.js'

export function estimateQuotaProjection(
  usedPercent: number | null,
  startsAtMs: number | null,
  resetsAtMs: number | null,
  nowMs = Date.now()
): QuotaProjection {
  const unavailable: QuotaProjection = { status: 'unavailable', projectedUsedPercent: null }
  if (
    usedPercent === null || startsAtMs === null || resetsAtMs === null ||
    !Number.isFinite(usedPercent) || !Number.isFinite(startsAtMs) ||
    !Number.isFinite(resetsAtMs) || !Number.isFinite(nowMs) ||
    resetsAtMs <= startsAtMs || nowMs < startsAtMs || nowMs >= resetsAtMs
  ) return unavailable

  const normalizedUsedPercent = Math.max(0, usedPercent)
  if (normalizedUsedPercent === 0) {
    return { status: 'lasts-until-reset', projectedUsedPercent: 0 }
  }
  const elapsedMs = nowMs - startsAtMs
  if (elapsedMs <= 0) return unavailable
  const projection = normalizedUsedPercent / (elapsedMs / (resetsAtMs - startsAtMs))
  if (!Number.isFinite(projection)) return unavailable
  const projectedUsedPercent = Math.round(projection * 10) / 10
  return {
    status: projectedUsedPercent > 100
      ? 'exhausts-before-reset'
      : projectedUsedPercent === 100 ? 'full-at-reset' : 'lasts-until-reset',
    projectedUsedPercent
  }
}

export function formatProjectedPercent(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return 'N/A'
  if (value > 999) return '>999%'
  const rounded = (Math.round(value * 10) / 10).toFixed(1).replace(/\.0$/u, '')
  return `${rounded}%`
}
