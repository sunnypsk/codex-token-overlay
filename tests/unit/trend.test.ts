import { describe, expect, it } from 'vitest'
import { buildTrendChartModel, formatTrendTooltip, trendLabelIndices } from '../../src/shared/trend.js'

describe('token use trend geometry', () => {
  it('normalizes huge decimal token values with BigInt and preserves the zero baseline', () => {
    const chart = buildTrendChartModel([
      { date: '2026-08-17', tokens: '100000000000000000000000000001', source: 'account' },
      { date: '2026-08-18', tokens: '0', source: 'account' },
      { date: '2026-08-19', tokens: '200000000000000000000000000000', source: 'local' }
    ])

    expect(chart.hasData).toBe(true)
    expect(chart.maxTokens).toBe(200000000000000000000000000000n)
    expect(chart.points[1]?.y).toBe(chart.baseline)
    expect(chart.points[0]?.y).toBeLessThan(chart.baseline)
    expect(chart.segments).toHaveLength(1)
    expect(chart.segments[0]?.areaPath).toContain(` ${chart.baseline.toFixed(2)} `)
  })

  it('splits line and area paths at unavailable gaps and exposes accessible exact tooltips', () => {
    const points = [
      { date: '2026-08-13', tokens: '4', source: 'account' as const },
      { date: '2026-08-14', tokens: null, source: 'unavailable' as const },
      { date: '2026-08-15', tokens: '6', source: 'local' as const },
      { date: '2026-08-16', tokens: '7', source: 'local' as const }
    ]
    const chart = buildTrendChartModel(points)

    expect(chart.segments).toHaveLength(2)
    expect(chart.segments.every((segment) => !segment.linePath.includes('NaN'))).toBe(true)
    expect(chart.points[1]?.available).toBe(false)
    expect(formatTrendTooltip(points[0]!)).toBe('2026-08-13 HKT · 4 tokens · Account')
    expect(formatTrendTooltip(points[1]!)).toBe('2026-08-14 HKT · Data unavailable')
  })

  it('labels all week points and avoids crowded final month ticks', () => {
    expect(trendLabelIndices(7)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(trendLabelIndices(30)).toEqual([0, 7, 14, 21, 29])
    expect(trendLabelIndices(29)).toEqual([0, 7, 14, 21, 28])
    expect(trendLabelIndices(24)).toEqual([0, 7, 14, 23])
    const empty = buildTrendChartModel([
      { date: '2026-08-13', tokens: null, source: 'unavailable' },
      { date: '2026-08-14', tokens: null, source: 'unavailable' }
    ])
    expect(empty.hasData).toBe(false)
    expect(empty.segments).toEqual([])
  })
})
