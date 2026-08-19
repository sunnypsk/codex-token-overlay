import { describe, expect, it } from 'vitest'
import {
  dateKeysBetween,
  hongKongDateKey,
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
})
