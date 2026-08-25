import { describe, expect, it } from 'vitest'
import {
  dateKeysBetween,
  hongKongDateKey,
  rollingHongKongDateKeys,
  rollingHongKongDateRange,
  startOfHongKongDay,
  startOfHongKongMonth,
  startOfHongKongWeek
} from '../../src/main/time.js'

describe('Hong Kong period boundaries', () => {
  const wednesday = Date.parse('2026-08-19T10:30:00+08:00')

  it('uses HKT midnight for day and month', () => {
    expect(new Date(startOfHongKongDay(wednesday)).toISOString()).toBe('2026-08-18T16:00:00.000Z')
    expect(new Date(startOfHongKongMonth(wednesday)).toISOString()).toBe('2026-07-31T16:00:00.000Z')
  })

  it('starts the week on Monday', () => {
    expect(new Date(startOfHongKongWeek(wednesday)).toISOString()).toBe('2026-08-16T16:00:00.000Z')
  })

  it('creates stable date keys across UTC midnight', () => {
    expect(hongKongDateKey(Date.parse('2026-08-18T17:00:00Z'))).toBe('2026-08-19')
    expect(
      dateKeysBetween(Date.parse('2026-08-17T16:00:00Z'), Date.parse('2026-08-19T03:00:00Z'))
    ).toEqual(['2026-08-18', '2026-08-19'])
  })

  it('builds fixed rolling HKT date sets in chronological order', () => {
    const now = Date.parse('2026-08-19T10:30:00+08:00')
    expect(rollingHongKongDateKeys(now, 7)).toEqual([
      '2026-08-13',
      '2026-08-14',
      '2026-08-15',
      '2026-08-16',
      '2026-08-17',
      '2026-08-18',
      '2026-08-19'
    ])
    expect(rollingHongKongDateKeys(now, 0)).toEqual([])
    const range = rollingHongKongDateRange(now, 30)
    expect(range.dateKeys).toHaveLength(30)
    expect(hongKongDateKey(range.startMs)).toBe('2026-07-21')
    expect(range.endMs).toBe(now)
  })

  it('keeps rolling 7/30-day ranges correct across the HKT year boundary', () => {
    const newYear = Date.parse('2027-01-01T00:30:00+08:00')
    expect(rollingHongKongDateKeys(newYear, 7)).toEqual([
      '2026-12-26',
      '2026-12-27',
      '2026-12-28',
      '2026-12-29',
      '2026-12-30',
      '2026-12-31',
      '2027-01-01'
    ])
    const month = rollingHongKongDateRange(newYear, 30)
    expect(month.dateKeys).toHaveLength(30)
    expect(month.dateKeys[0]).toBe('2026-12-03')
    expect(month.dateKeys.at(-1)).toBe('2027-01-01')
    expect(hongKongDateKey(month.startMs)).toBe('2026-12-03')
  })
})
