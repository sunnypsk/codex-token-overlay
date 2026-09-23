import { memo, useState, type PointerEvent, type ReactElement } from 'react'
import type { QuotaProjection, QuotaObservation } from '../shared/contracts'
import { formatProjectedPercent } from '../shared/quota-projection'
import { splitObservationSegments } from '../shared/quota-trend'

const WIDTH = 340
const HEIGHT = 158
const LEFT = 34
const RIGHT = 325
const TOP = 10
const BOTTOM = 127

interface Props {
  startsAt: string | null
  resetsAt: string | null
  observations: QuotaObservation[]
  projection: QuotaProjection
}

export const QuotaTrendChart = memo(function QuotaTrendChart({ startsAt, resetsAt, observations, projection }: Props): ReactElement {
  const [hoveredAt, setHoveredAt] = useState<string | null>(null)
  const start = startsAt === null ? Number.NaN : Date.parse(startsAt)
  const reset = resetsAt === null ? Number.NaN : Date.parse(resetsAt)
  const validWindow = Number.isFinite(start) && Number.isFinite(reset) && reset > start
  const points = validWindow ? observations.filter((point) => {
    const at = Date.parse(point.at)
    return Number.isFinite(at) && at >= start && at < reset &&
      Number.isFinite(point.usedPercent) && point.usedPercent >= 0
  }) : []
  const projected = projection.status === 'unavailable' ? null : projection.projectedUsedPercent
  const hasProjection = projected !== null && Number.isFinite(projected) && points.length > 0
  const maxObserved = points.reduce((max, point) => Math.max(max, point.usedPercent), 0)
  const ceiling = Math.max(100, Math.ceil(Math.max(maxObserved, hasProjection ? projected : 0) / 25) * 25)
  const x = (at: number): number => LEFT + ((at - start) / (reset - start)) * (RIGHT - LEFT)
  const y = (percent: number): number => BOTTOM - (percent / ceiling) * (BOTTOM - TOP)

  const segmentGroups = splitObservationSegments(points)
  const segments = segmentGroups.map((segment) => segment.map((point, index) =>
    `${index ? 'L' : 'M'}${x(Date.parse(point.at)).toFixed(2)} ${y(point.usedPercent).toFixed(2)}`
  ).join(' '))

  const last = points[points.length - 1]
  const projectedPath = hasProjection && last
    ? `M${x(Date.parse(last.at)).toFixed(2)} ${y(last.usedPercent).toFixed(2)} L${RIGHT} ${y(projected).toFixed(2)}`
    : null
  const hovered = points.find((point) => point.at === hoveredAt)
  const summary = !validWindow ? 'Waiting for the next reset window' : points.length === 0
    ? 'Waiting for the first observation' :
      `${points.length} observed ${points.length === 1 ? 'reading' : 'readings'}; ${hasProjection ? `projected ${formatProjectedPercent(projected)} by reset` : 'projection unavailable'}`

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>): void => {
    if (points.length === 0) return
    const bounds = event.currentTarget.getBoundingClientRect()
    const pointerX = (event.clientX - bounds.left) * WIDTH / bounds.width
    const at = start + ((pointerX - LEFT) / (RIGHT - LEFT)) * (reset - start)
    let low = 0
    let high = points.length
    while (low < high) {
      const middle = Math.floor((low + high) / 2)
      if (Date.parse(points[middle]!.at) < at) low = middle + 1
      else high = middle
    }
    const before = points[Math.max(0, low - 1)]!
    const after = points[Math.min(points.length - 1, low)]!
    const nearest = Math.abs(Date.parse(before.at) - at) <= Math.abs(Date.parse(after.at) - at) ? before : after
    setHoveredAt(Math.abs(x(Date.parse(nearest.at)) - pointerX) <= 10 ? nearest.at : null)
  }

  return (
    <section className="trend-card" aria-label="Current quota trend">
      <div className="trend-heading">
        <span className="eyebrow">USAGE TREND</span>
        <span className="trend-timezone">CURRENT WINDOW · HKT</span>
      </div>
      <div className="trend-chart-wrap">
        <svg className="trend-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img"
          aria-label={`Codex quota used percentage trend. ${summary}.`} onPointerMove={handlePointerMove}
          onPointerLeave={() => setHoveredAt(null)}>
          <line className="trend-grid" x1={LEFT} x2={RIGHT} y1={BOTTOM} y2={BOTTOM} />
          <line className="trend-grid trend-grid--limit" x1={LEFT} x2={RIGHT} y1={y(100)} y2={y(100)} />
          {ceiling > 100 && <text className="trend-axis" x={ceiling >= 1_000 ? LEFT + 4 : LEFT - 5}
            y={TOP + 4} textAnchor={ceiling >= 1_000 ? 'start' : 'end'}>{formatProjectedPercent(ceiling)}</text>}
          <text className="trend-axis" x={LEFT - 5} y={y(100) + 4} textAnchor="end">100%</text>
          <text className="trend-axis" x={LEFT - 5} y={BOTTOM + 4} textAnchor="end">0%</text>
          {segments.map((path, index) => <path className="trend-observed" d={path} key={index} />)}
          {segmentGroups.filter((group) => group.length === 1 && group[0]!.at !== last?.at).map((group) => (
            <circle className="trend-isolated-point" key={group[0]!.at}
              cx={x(Date.parse(group[0]!.at))} cy={y(group[0]!.usedPercent)} r="3.5" />
          ))}
          {projectedPath && <path className="trend-projected" d={projectedPath} />}
          {last && <circle className="trend-last-point" cx={x(Date.parse(last.at))} cy={y(last.usedPercent)} r="3.5" />}
          {hasProjection && <circle className="trend-projected-point" cx={RIGHT} cy={y(projected)} r="3.5" />}
          {hasProjection && <text className="trend-end-label" x={RIGHT - 5}
            y={Math.max(TOP + 10, y(projected) - 7)} textAnchor="end">{formatProjectedPercent(projected)}</text>}
          {validWindow && <>
            <text className="trend-axis" x={LEFT} y={HEIGHT - 3}>{formatAxisDate(start)}</text>
            <text className="trend-axis" x={RIGHT} y={HEIGHT - 3} textAnchor="end">{formatAxisDate(reset)}</text>
          </>}
          {hovered && <circle className="trend-hover-point" cx={x(Date.parse(hovered.at))} cy={y(hovered.usedPercent)} r="5" />}
        </svg>
        {hovered && <div className="trend-tooltip" role="tooltip"
          style={{ left: `${Math.max(24, Math.min(76, x(Date.parse(hovered.at)) / WIDTH * 100))}%` }}>
          {formatTooltipDate(hovered.at)} HKT · {formatObservedPercent(hovered.usedPercent)}
        </div>}
        {points.length === 0 && <span className="trend-empty">{summary}</span>}
      </div>
      <div className="trend-footer">
        <span className="trend-legend"><i className="trend-key trend-key--observed" />Observed</span>
        <span className="trend-legend"><i className="trend-key trend-key--projected" />Projected</span>
        <span className="trend-summary">{points.length > 0 ? `${points.length} recorded` : 'No readings yet'}</span>
      </div>
      <span className="sr-only">{summary}. Recorded readings begin when this version first syncs.</span>
    </section>
  )
})

function formatAxisDate(ms: number): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Hong_Kong', day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms))
}

function formatTooltipDate(iso: string): string {
  return formatAxisDate(Date.parse(iso))
}

function formatObservedPercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`
}
