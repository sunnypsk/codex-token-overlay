import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { ChevronDown, ChevronUp, Clock3, RefreshCw, Sparkles, X } from 'lucide-react'
import type { QuotaProjection, QuotaSnapshot } from '../shared/contracts'
import { formatProjectedPercent } from '../shared/quota-projection'
import { formatCountdown, formatFreshness, formatResetDate } from './format'
import { QuotaTrendChart } from './QuotaTrendChart'

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<QuotaSnapshot | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [fatalError, setFatalError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.codexOverlay) {
      setFatalError('The secure preload bridge did not initialize.')
      return
    }
    let mounted = true
    void window.codexOverlay.getSnapshot()
      .then((value) => { if (mounted) setSnapshot(value) })
      .catch((error) => { if (mounted) setFatalError(String(error)) })
    const unsubscribe = window.codexOverlay.onSnapshot((value) => setSnapshot(value))
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      mounted = false
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  if (fatalError) return <ErrorShell message={fatalError} />
  if (!snapshot) return <LoadingShell />

  const resetExpired = snapshot.reset.resetsAt !== null && Date.parse(snapshot.reset.resetsAt) <= now
  const resetAt = resetExpired ? null : snapshot.reset.resetsAt
  const projection: QuotaProjection = resetExpired
    ? { status: 'unavailable', projectedUsedPercent: null }
    : snapshot.reset.projection
  const usedPercent = resetExpired ? null : snapshot.reset.usedPercent
  const percentText = formatUsedPercent(usedPercent)
  const ringStyle = { '--usage-progress': `${Math.max(0, Math.min(100, usedPercent ?? 0)) * 3.6}deg` } as CSSProperties
  const freshness = snapshot.rateLimitsSyncedAt
    ? `Last synced ${formatFreshness(snapshot.rateLimitsSyncedAt, now)}`
    : 'Waiting for first sync'

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSnapshot(await window.codexOverlay.refresh())
    } catch (error) {
      setFatalError(String(error))
    } finally {
      setRefreshing(false)
    }
  }

  const setExpanded = async (value: boolean): Promise<void> => {
    try {
      setSnapshot(await window.codexOverlay.setExpanded(value))
    } catch (error) {
      setFatalError(String(error))
    }
  }

  if (!snapshot.settings.expanded) {
    return (
      <main className="overlay-shell collapsed-shell">
        <div className="drag-surface collapsed-content">
          <div className={`usage-ring${usedPercent === null ? ' usage-ring--unavailable' : ''}`} style={ringStyle} aria-label={`${percentText} used`}>
            <strong>{percentText}</strong>
          </div>
          <div className="collapsed-copy">
            <div className="collapsed-topline">
              <span className="eyebrow">CODEX LIMIT</span>
              {snapshot.stale && <span className="stale-label">LAST SYNCED</span>}
            </div>
            <strong>{resetAt ? `Reset in ${formatCountdown(resetAt, now)}` : 'Reset unavailable'}</strong>
            <span className={`quota-projection-copy quota-projection-copy--${projection.status}`}>
              {projectionCopy(projection)}
            </span>
          </div>
          <button className="icon-button no-drag" type="button" aria-label="Expand overlay" onClick={() => void setExpanded(true)}>
            <ChevronDown size={17} />
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="overlay-shell expanded-shell">
      <header className="app-header drag-surface">
        <div className="brand-mark"><Sparkles size={15} /></div>
        <div className="brand-copy">
          <strong>Codex usage</strong>
          <span className={`connection connection--${snapshot.connection}`}>
            <i /> {snapshot.stale ? freshness : 'Account connected'}
          </span>
        </div>
        <div className="header-actions no-drag">
          <button className="icon-button" type="button" aria-label="Refresh" onClick={() => void refresh()}>
            <RefreshCw size={15} className={refreshing ? 'spin' : ''} />
          </button>
          <button className="icon-button" type="button" aria-label="Collapse" onClick={() => void setExpanded(false)}>
            <ChevronUp size={16} />
          </button>
          <button className="icon-button" type="button" aria-label="Hide" onClick={() => void window.codexOverlay.hide()}>
            <X size={15} />
          </button>
        </div>
      </header>

      <section className="reset-card" aria-label="Codex quota">
        <div className="reset-heading">
          <div>
            <span className="eyebrow">CURRENT RESET WINDOW</span>
            <strong>{percentText}</strong>
          </div>
          <span className="used-label">USED</span>
        </div>
        <div className="progress-track" role="progressbar" aria-label="Codex quota used" aria-valuemin={0} aria-valuemax={100} aria-valuenow={usedPercent === null ? undefined : Math.max(0, Math.min(100, usedPercent))}>
          <span style={{ width: `${Math.max(0, Math.min(100, usedPercent ?? 0))}%` }} />
        </div>
        <div className="reset-meta">
          <span><Clock3 size={12} /> {resetAt ? `${formatResetDate(resetAt)} HKT` : 'Reset unavailable'}</span>
          <strong>{resetAt ? formatCountdown(resetAt, now) : 'N/A'}</strong>
        </div>
        <div className={`projection-row projection-row--${projection.status}`}>
          <div>
            <span className="eyebrow">CURRENT-WEEK PACE</span>
            <strong>{projectionCopy(projection)}</strong>
          </div>
          <span>{projectionStatus(projection)}</span>
        </div>
      </section>

      <QuotaTrendChart startsAt={resetExpired ? null : snapshot.reset.startsAt} resetsAt={resetAt}
        observations={resetExpired ? [] : snapshot.reset.observations} projection={projection} />

      {snapshot.additionalLimits.length > 0 && (
        <section className="secondary-limits" aria-label="Other quota limits">
          {snapshot.additionalLimits.map((limit) => (
            <div key={limit.limitId}>
              <span>{limit.label}</span>
              <strong>{formatUsedPercent(limit.resetsAt !== null && limit.resetsAt * 1_000 <= now ? null : limit.usedPercent)}</strong>
            </div>
          ))}
        </section>
      )}
      {snapshot.stale && <p className="sync-note" role="status">{freshness} · Forecast unavailable until sync</p>}
    </main>
  )
}

function formatUsedPercent(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'N/A' : `${value.toFixed(0)}%`
}

function projectionCopy(projection: QuotaProjection): string {
  return projection.status === 'unavailable'
    ? 'Projection unavailable'
    : `Projected ${formatProjectedPercent(projection.projectedUsedPercent)} by reset`
}

function projectionStatus(projection: QuotaProjection): string {
  if (projection.status === 'exhausts-before-reset') return 'Likely to run out early'
  if (projection.status === 'full-at-reset') return 'Expected to use full quota'
  if (projection.status === 'lasts-until-reset') return 'Expected to last until reset'
  return 'Waiting for current data'
}

function LoadingShell(): ReactElement {
  return (
    <main className="overlay-shell collapsed-shell loading-shell">
      <div className="loading-dot" />
      <div><strong>Codex usage</strong><span>Connecting to Codex…</span></div>
    </main>
  )
}

function ErrorShell({ message }: { message: string }): ReactElement {
  return (
    <main className="overlay-shell collapsed-shell loading-shell">
      <div className="error-dot" />
      <div><strong>Overlay unavailable</strong><span>{message}</span></div>
    </main>
  )
}
