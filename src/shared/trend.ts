import type { DailyUsagePoint, DailyUsageSource } from './contracts.js'

export const TREND_CHART_WIDTH = 348
export const TREND_CHART_HEIGHT = 128
export const TREND_CHART_LEFT = 8
export const TREND_CHART_RIGHT = 8
export const TREND_CHART_TOP = 12
export const TREND_CHART_BOTTOM = 28

const TREND_COORDINATE_SCALE = 1_000_000n

export interface TrendChartPoint {
  raw: DailyUsagePoint
  x: number
  y: number
  available: boolean
}

export interface TrendChartSegment {
  points: TrendChartPoint[]
  linePath: string
  areaPath: string | null
}

export interface TrendChartLabel {
  index: number
  text: string
  x: number
  anchor: 'start' | 'middle' | 'end'
}

export interface TrendChartModel {
  width: number
  height: number
  left: number
  right: number
  baseline: number
  points: TrendChartPoint[]
  segments: TrendChartSegment[]
  labels: TrendChartLabel[]
  hasData: boolean
  maxTokens: bigint
}

/**
 * Build SVG geometry without converting the exact token strings to Number.
 * Only a bounded fixed-point ratio is converted to a pixel coordinate.
 */
export function buildTrendChartModel(
  dailyUsage: DailyUsagePoint[],
  dimensions: { width?: number; height?: number } = {}
): TrendChartModel {
  const width = dimensions.width ?? TREND_CHART_WIDTH
  const height = dimensions.height ?? TREND_CHART_HEIGHT
  const left = TREND_CHART_LEFT
  const right = TREND_CHART_RIGHT
  const baseline = height - TREND_CHART_BOTTOM
  const plotWidth = Math.max(0, width - left - right)
  const plotHeight = Math.max(0, baseline - TREND_CHART_TOP)
  const values = dailyUsage.map((raw) => ({ raw, value: parseTrendTokens(raw) }))
  const maxTokens = values.reduce<bigint>((maximum, point) => {
    if (point.value === null || point.raw.source === 'unavailable') return maximum
    return point.value > maximum ? point.value : maximum
  }, 0n)
  const points: TrendChartPoint[] = values.map((point, index) => {
    const x = dailyUsage.length <= 1 ? left + plotWidth / 2 : left + (plotWidth * index) / (dailyUsage.length - 1)
    const available = point.value !== null && point.raw.source !== 'unavailable'
    return {
      raw: point.raw,
      x,
      y: available ? tokenY(point.value!, maxTokens, baseline, plotHeight) : baseline,
      available
    }
  })

  const segments: TrendChartSegment[] = []
  let current: TrendChartPoint[] = []
  const flush = (): void => {
    if (current.length === 0) return
    segments.push({
      points: current,
      linePath: linePath(current),
      areaPath: current.length >= 2 ? areaPath(current, baseline) : null
    })
    current = []
  }
  for (const point of points) {
    if (point.available) current.push(point)
    else flush()
  }
  flush()

  const labels = buildTrendLabels(dailyUsage, points)
  return {
    width,
    height,
    left,
    right,
    baseline,
    points,
    segments,
    labels,
    hasData: points.some((point) => point.available),
    maxTokens
  }
}

export function formatTrendTooltip(point: DailyUsagePoint): string {
  if (parseTrendTokens(point) === null) return `${point.date} HKT · Data unavailable`
  return `${point.date} HKT · ${point.tokens} tokens · ${trendSourceLabel(point.source)}`
}

export function trendSourceLabel(source: DailyUsageSource): string {
  if (source === 'account') return 'Account'
  if (source === 'local') return 'Local'
  return 'Data unavailable'
}

export function trendLabelIndices(pointCount: number): number[] {
  if (pointCount <= 0) return []
  if (pointCount <= 7) return Array.from({ length: pointCount }, (_, index) => index)
  const lastIndex = pointCount - 1
  const indices = [0]
  for (let index = 7; index < lastIndex; index += 7) {
    if (lastIndex - index > 2) indices.push(index)
  }
  indices.push(lastIndex)
  return indices
}

function parseTrendTokens(point: DailyUsagePoint): bigint | null {
  if (point.tokens === null || !/^\d+$/u.test(point.tokens)) return null
  try {
    return BigInt(point.tokens)
  } catch {
    return null
  }
}

function tokenY(value: bigint, maximum: bigint, baseline: number, plotHeight: number): number {
  if (maximum <= 0n) return baseline
  const scaledRatio = (value * TREND_COORDINATE_SCALE) / maximum
  const ratio = Number(scaledRatio) / Number(TREND_COORDINATE_SCALE)
  return baseline - ratio * plotHeight
}

function linePath(points: TrendChartPoint[]): string {
  return points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${coordinate(point.x)} ${coordinate(point.y)}`)
    .join(' ')
}

function areaPath(points: TrendChartPoint[], baseline: number): string {
  const first = points[0]!
  const last = points.at(-1)!
  return [
    `M ${coordinate(first.x)} ${coordinate(baseline)}`,
    ...points.map((point) => `L ${coordinate(point.x)} ${coordinate(point.y)}`),
    `L ${coordinate(last.x)} ${coordinate(baseline)}`,
    'Z'
  ].join(' ')
}

function coordinate(value: number): string {
  return value.toFixed(2)
}

function buildTrendLabels(
  dailyUsage: DailyUsagePoint[],
  points: TrendChartPoint[]
): TrendChartLabel[] {
  const indices = trendLabelIndices(dailyUsage.length)
  return indices.flatMap((index) => {
    const point = points[index]
    const raw = dailyUsage[index]
    if (!point || !raw) return []
    const edge = index === 0 ? 'start' : index === dailyUsage.length - 1 ? 'end' : 'middle'
    return [{ index, text: formatTrendDateLabel(raw.date), x: point.x, anchor: edge }]
  })
}

function formatTrendDateLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(date)
  if (!match) return date
  return `${Number(match[2])}/${Number(match[3])}`
}
