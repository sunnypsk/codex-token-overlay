export const HONG_KONG_TIMEZONE = 'Asia/Hong_Kong' as const
const HONG_KONG_OFFSET_MS = 8 * 60 * 60 * 1_000

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
    cursor += 24 * 60 * 60 * 1_000
  }
  return keys
}

export function formatHongKongIso(timestampMs: number): string {
  return new Date(timestampMs).toISOString()
}
