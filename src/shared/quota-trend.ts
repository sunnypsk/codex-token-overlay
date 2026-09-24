import type { QuotaObservation } from './contracts.js'

const MAX_CONNECTED_GAP_MS = 2 * 60_000

/** Missing syncs are not represented as a continuous observed line. */
export function splitObservationSegments(points: QuotaObservation[]): QuotaObservation[][] {
  const segments: QuotaObservation[][] = []
  let current: QuotaObservation[] = []
  for (const point of points) {
    const previous = current[current.length - 1]
    if (previous && Date.parse(point.at) - Date.parse(previous.at) > MAX_CONNECTED_GAP_MS) {
      segments.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 0) segments.push(current)
  return segments
}

/** Historical forecasts start only where a valid value was actually recorded. */
export function splitProjectedSegments(points: QuotaObservation[]): QuotaObservation[][] {
  const segments: QuotaObservation[][] = []
  let current: QuotaObservation[] = []
  for (const point of points) {
    if (typeof point.projectedUsedPercent !== 'number' ||
      !Number.isFinite(point.projectedUsedPercent) || point.projectedUsedPercent < 0) {
      if (current.length > 0) segments.push(current)
      current = []
      continue
    }
    const previous = current[current.length - 1]
    if (previous && Date.parse(point.at) - Date.parse(previous.at) > MAX_CONNECTED_GAP_MS) {
      segments.push(current)
      current = []
    }
    current.push(point)
  }
  if (current.length > 0) segments.push(current)
  return segments
}
