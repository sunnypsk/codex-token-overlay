import { describe, expect, it } from 'vitest'
import { splitObservationSegments, splitProjectedSegments } from '../../src/shared/quota-trend.js'

describe('observed trend gaps', () => {
  it('does not connect readings more than two minutes apart', () => {
    const start = Date.UTC(2026, 8, 23)
    const points = [1, 2, 4, 7].map((minute) => ({
      at: new Date(start + minute * 60_000).toISOString(), usedPercent: minute * 10
    }))
    expect(splitObservationSegments(points)).toEqual([points.slice(0, 3), points.slice(3)])
  })

  it('leaves an empty graph empty and retains a single zero reading', () => {
    expect(splitObservationSegments([])).toEqual([])
    const zero = { at: '2026-09-23T00:00:00.000Z', usedPercent: 0 }
    expect(splitObservationSegments([zero])).toEqual([[zero]])
  })
})

describe('recorded reset forecast gaps', () => {
  it('does not backfill legacy points or join across missing, invalid, or distant readings', () => {
    const start = Date.UTC(2026, 8, 23)
    const point = (minute: number, projectedUsedPercent?: number | null) => ({
      at: new Date(start + minute * 60_000).toISOString(), usedPercent: minute,
      ...(projectedUsedPercent !== undefined ? { projectedUsedPercent } : {})
    })
    const points = [point(0), point(1, 160), point(2, 150), point(3, null),
      point(4, 0), point(7, 120), point(8, Number.NaN), point(9, 110)]
    expect(splitProjectedSegments(points)).toEqual([
      points.slice(1, 3), [points[4]], [points[5]], [points[7]]
    ])
    expect(splitProjectedSegments([])).toEqual([])
  })

})
