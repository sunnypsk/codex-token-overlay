import { describe, expect, it } from 'vitest'
import { splitObservationSegments } from '../../src/shared/quota-trend.js'

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
