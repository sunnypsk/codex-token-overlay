export const HONG_KONG_TIMEZONE = 'Asia/Hong_Kong' as const
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1_000
const HONG_KONG_DAY_MS = 24 * 60 * 60 * 1_000

export interface HongKongDateRange {
  startMs: number
  endMs: number
  dateKeys: string[]
}

export function hongKongDateKey(timestampMs: number): string {
  return new Date(timestampMs + HONG_KONG_OFFSET_MS).toISOString().slice(0, 10)
}

export function startOfHongKongDay(timestampMs: number): number {
  const shifted = new Date(timestampMs + HONG_KONG_OFFSET_MS)
  return (
    Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) -
    HONG_KONG_OFFSET_MS
  )
}

export function startOfHongKongWeek(timestampMs: number): number {
  const shifted = new Date(timestampMs + HONG_KONG_OFFSET_MS)
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7
  return (
    Date.UTC(
      shifted.getUTCFullYear(),
      shifted.getUTCMonth(),
      shifted.getUTCDate() - daysSinceMonday
    ) - HONG_KONG_OFFSET_MS
  )
}

export function startOfHongKongMonth(timestampMs: number): number {
  const shifted = new Date(timestampMs + HONG_KONG_OFFSET_MS)
  return Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - HONG_KONG_OFFSET_MS
}

export function dateKeysBetween(startMs: number, endMs: number): string[] {
  const keys: string[] = []
  let cursor = startOfHongKongDay(startMs)
  while (cursor <= endMs) {
    keys.push(hongKongDateKey(cursor))
    cursor += HONG_KONG_DAY_MS
  }
  return keys
}

/**
 * Return a fixed number of chronological HKT calendar dates ending today.
 * Hong Kong has no daylight-saving transition, so stepping HKT midnights by
 * one day is deterministic and does not depend on the host browser timezone.
 */
export function rollingHongKongDateKeys(endMs: number, dayCount: number): string[] {
  if (!Number.isFinite(endMs) || !Number.isInteger(dayCount) || dayCount <= 0) return []
  const todayStart = startOfHongKongDay(endMs)
  return Array.from({ length: dayCount }, (_, index) =>
    hongKongDateKey(todayStart - (dayCount - 1 - index) * HONG_KONG_DAY_MS)
  )
}

/** Return the HKT midnight start and exact timestamp end for a rolling range. */
export function rollingHongKongDateRange(endMs: number, dayCount: number): HongKongDateRange {
  const dateKeys = rollingHongKongDateKeys(endMs, dayCount)
  const endOfToday = startOfHongKongDay(endMs)
  return {
    startMs: dateKeys.length > 0 ? endOfToday - (dateKeys.length - 1) * HONG_KONG_DAY_MS : endOfToday,
    endMs,
    dateKeys
  }
}

export function formatHongKongIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString()
}
