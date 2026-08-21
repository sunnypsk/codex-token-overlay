import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Clock3,
  Database,
  HardDrive,
  RefreshCw,
  Sparkles,
  X
} from 'lucide-react'
import type { DashboardSnapshot, PeriodKey, QuotaProjection, TokenBreakdown } from '../shared/contracts'
import { formatProjectedPercent } from '../shared/quota-projection'
import {
  formatCountdown,
  formatExactTokens,
  formatFreshness,
  formatMicroUsd,
  formatResetDate,
  formatTokens,
  safeBigInt
} from './format'

const periodKeys: PeriodKey[] = ['today', 'week', 'month']

export function App(): ReactElement {
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null)
  const [periodKey, setPeriodKey] = useState<PeriodKey>('today')
  const [refreshing, setRefreshing] = useState(false)
  const [now, setNow] = useState(Date.now())
  const [fatalError, setFatalError] = useState<string | null>(null)

  useEffect(() => {
    if (!window.codexOverlay) {
      setFatalError('The secure preload bridge did not initialize.')
      return
    }
    let mounted = true
    void window.codexOverlay.getSnapshot().then((value) => mounted && setSnapshot(value))
    const unsubscribe = window.codexOverlay.onSnapshot((value) => setSnapshot(value))
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => {
      mounted = false
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [])

  if (fatalError) return <ErrorShell message={fatalError} />

  const period = snapshot?.periods[periodKey]
  const expanded = snapshot?.settings.expanded ?? false
  const resetPercent = Math.max(0, Math.min(100, snapshot?.reset.usedPercent ?? 0))
  const ringStyle = { '--usage-progress': `${resetPercent * 3.6}deg` } as CSSProperties

  const refresh = async (): Promise<void> => {
    setRefreshing(true)
    try {
      setSnapshot(await window.codexOverlay.refresh())
    } finally {
      setRefreshing(false)
    }
  }

  const setExpanded = async (value: boolean): Promise<void> => {
    setSnapshot(await window.codexOverlay.setExpanded(value))
  }

  if (!snapshot || !period) return <LoadingShell />

  if (!expanded) {
    return (
      <main className="overlay-shell collapsed-shell">
        <div className="drag-surface collapsed-content">
          <div className="usage-ring" style={ringStyle} title={`${resetPercent.toFixed(0)}% of reset window used`}>
            <div className="usage-ring__inner">
              <strong>{resetPercent.toFixed(0)}</strong>
              <span>%</span>
            </div>
          </div>

          <div className="collapsed-stat">
            <span className="eyebrow">TODAY</span>
            <strong title={`${formatExactTokens(period.authoritativeTokens)} tokens`}>
              {formatTokens(period.authoritativeTokens)}
            </strong>
            <span>{formatMicroUsd(period.cost.microUsd)}</span>
          </div>

          <div className="collapsed-reset">
            <span className="eyebrow">RESET IN</span>
            <strong>{formatCountdown(snapshot.reset.resetsAt, now)}</strong>
            <span
              className={`quota-projection-copy quota-projection-copy--${snapshot.reset.projection.status}`}
              title={collapsedProjectionCopy(snapshot.reset.projection)}
            >
              {collapsedProjectionCopy(snapshot.reset.projection)}
            </span>
          </div>

          <button
            className="icon-button expand-button no-drag"
            type="button"
            aria-label="Expand overlay"
            onClick={() => void setExpanded(true)}
          >
            <ChevronDown size={17} />
          </button>
        </div>
      </main>
    )
  }

  const breakdown = calculateBreakdown(period.tokens)
  const additionalLimits = snapshot.rateLimits.filter((bucket) => bucket.limitId !== snapshot.reset.limitId)

  return (
    <main className="overlay-shell expanded-shell">
      <header className="app-header drag-surface">
        <div className="brand-mark"><Sparkles size={15} /></div>
        <div className="brand-copy">
          <strong>Codex usage</strong>
          <span className={`connection ${snapshot.freshness.appServer}`}>
            <i /> {snapshot.freshness.appServer === 'online' ? 'Account connected' : 'Local data mode'}
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

      <nav className="period-tabs" aria-label="Usage period">
        {periodKeys.map((key) => (
          <button
            key={key}
            type="button"
            className={periodKey === key ? 'active' : ''}
            onClick={() => setPeriodKey(key)}
          >
            {key === 'today' ? 'Today' : key === 'week' ? 'Week' : 'Month'}
          </button>
        ))}
      </nav>

      <section className="hero-stat">
        <div>
          <span className="eyebrow">ACCOUNT TOKENS</span>
          <strong title={formatExactTokens(period.authoritativeTokens)}>
            {formatTokens(period.authoritativeTokens)}
          </strong>
          <p>{period.liveAccountSyncPending ? 'Live local data · account sync pending' : 'Account daily buckets synced'}</p>
        </div>
        <div className="cost-block">
          <span className="eyebrow">API-EQUIVALENT</span>
          <strong>{formatMicroUsd(period.cost.microUsd)}</strong>
          <p>{period.cost.coveragePercent === null ? 'N/A coverage' : `${period.cost.coveragePercent.toFixed(1)}% coverage`}</p>
        </div>
      </section>

      <section className="breakdown-grid" aria-label="Local token breakdown">
        <BreakdownItem icon={<ArrowDownToLine size={14} />} label="Uncached input" value={breakdown.uncached} />
        <BreakdownItem icon={<Database size={14} />} label="Cached input" value={period.tokens.cachedInput} />
        <BreakdownItem icon={<ArrowUpFromLine size={14} />} label="Output" value={period.tokens.output} />
      </section>

      <section className="reset-card">
        <div className="section-heading">
          <div>
            <span className="eyebrow">RESET WINDOW</span>
            <strong>{formatCountdown(snapshot.reset.resetsAt, now)} remaining</strong>
          </div>
          <span className="percent-pill">{resetPercent.toFixed(0)}%</span>
        </div>
        <div className="progress-track" aria-label={`${resetPercent.toFixed(0)} percent used`}>
          <span style={{ width: `${resetPercent}%` }} />
        </div>
        <div className="reset-meta">
          <span><Clock3 size={12} /> {formatResetDate(snapshot.reset.resetsAt)} HKT</span>
          <span>{formatTokens(snapshot.reset.tokensSinceReset.total)} used since reset</span>
        </div>
        <QuotaProjectionRow projection={snapshot.reset.projection} />
        <CapacityRange snapshot={snapshot} />
      </section>

      {additionalLimits.length > 0 && (
        <section className="secondary-limits">
          {additionalLimits.map((bucket) => (
            <div key={bucket.limitId}>
              <span>{bucket.limitName ?? bucket.limitId}</span>
              <strong>{bucket.primary ? `${bucket.primary.usedPercent.toFixed(0)}%` : 'N/A'}</strong>
            </div>
          ))}
        </section>
      )}

      <section className="models-card">
        <div className="section-heading compact">
          <span className="eyebrow">TOP MODELS · LOCAL DETAIL</span>
          <span>{period.models.length} tracked</span>
        </div>
        {period.models.length === 0 ? (
          <p className="empty-copy">Indexing local Codex sessions…</p>
        ) : (
          period.models.slice(0, 4).map((model) => (
            <div className="model-row" key={model.model}>
              <span title={model.model}>{prettyModelName(model.model)}</span>
              <strong>{formatTokens(model.tokens.total)}</strong>
              <small>{formatMicroUsd(model.apiEquivalentMicroUsd)}</small>
            </div>
          ))
        )}
      </section>

      <PricingDetails period={period} snapshot={snapshot} />

      <footer className="app-footer">
        <div className="freshness-line">
          <span><HardDrive size={12} /> Local {formatFreshness(snapshot.freshness.localIndexedAt, now)}</span>
          <span className={snapshot.freshness.pricingStale ? 'warning-text' : ''}>
            Prices {formatFreshness(snapshot.freshness.pricingUpdatedAt, now)}
          </span>
        </div>
      </footer>
    </main>
  )
}

function PricingDetails({
  period,
  snapshot
}: {
  period: DashboardSnapshot['periods'][PeriodKey]
  snapshot: DashboardSnapshot
}): ReactElement {
  const freshness = snapshot.freshness
  const source = freshness.pricingSource ?? snapshot.freshness.pricingMessage ?? 'embedded'
  const sourceHash = freshness.pricingSourceSha256 ?? freshness.pricingPayloadSha256
  const progress = freshness.rebuild
  return (
    <section className="pricing-details" aria-label="Pricing provenance and coverage">
      <div className="section-heading compact">
        <span className="eyebrow">PRICING PROVENANCE</span>
        <span className={freshness.pricingStale ? 'warning-text' : ''}>{freshness.pricingQuality ?? (freshness.pricingStale ? 'stale' : 'verified')}</span>
      </div>
      <div className="pricing-source" title={sourceHash ?? undefined}>
        <span>{source}</span>
        <small>{sourceHash ? `${sourceHash.slice(0, 12)}…` : 'SHA unavailable'} · checked {formatFreshness(freshness.pricingCheckedAt)}</small>
      </div>
      <div className="coverage-grid">
        <span>Local {formatCoverage(period.cost.localCoveragePercent)}</span>
        <span>Price {formatCoverage(period.cost.priceCoveragePercent)}</span>
        <span>Tier {formatCoverage(period.cost.tierCoveragePercent)}</span>
        <span>Fast rate {formatCoverage(period.cost.fastRateCoveragePercent)}</span>
      </div>
      <div className="pricing-flags">
        <span>{period.cost.lowerBound ? 'Lower bound' : 'Verified bound'}</span>
        <span>{period.cost.unpricedTokens ?? '0'} unpriced tokens</span>
        {period.cost.sourceConflicts && period.cost.sourceConflicts.length > 0 && <span className="warning-text">Source conflict</span>}
        {freshness.pricingMessage && <span className="warning-text" title={freshness.pricingMessage}>Pricing error/stale</span>}
        {freshness.appServer === 'offline' && <span className="warning-text">Offline/local data</span>}
        {(freshness.pendingPricing ?? 0) > 0 && <span>Pending {freshness.pendingPricing}</span>}
        {progress && progress.state !== 'idle' && <span>{progress.state} {progress.processedFiles}/{progress.totalFiles}</span>}
        {progress && (progress.replayedSessions ?? 0) > 0 && <span>Raw replay {progress.replayedSessions}</span>}
        {progress && (progress.retainedLegacySessions ?? 0) > 0 && <span className="warning-text">Legacy retained {progress.retainedLegacySessions}</span>}
        {progress && progress.rawTokenDelta && progress.rawTokenDelta !== '0' && <span>Raw delta {progress.rawTokenDelta}</span>}
        {progress && (progress.failureDiagnostics?.length ?? 0) > 0 && <span className="warning-text" title={progress.failureDiagnostics?.join(', ')}>Replay diagnostics</span>}
      </div>
      {freshness.pricingComponents && freshness.pricingComponents.length > 0 && (
        <div className="pricing-components">
          {freshness.pricingComponents.slice(0, 4).map((component) => (
            <span key={component.componentId} title={`${component.sourceUrl} · ${component.sourceSha256 ?? 'SHA unavailable'}`}>
              {component.source} · {component.quality} · effective {component.effectiveAt ? formatFreshness(component.effectiveAt) : 'N/A'}
            </span>
          ))}
        </div>
      )}
    </section>
  )
}

function formatCoverage(value: number | null | undefined): string {
  return value === null || value === undefined ? 'N/A' : `${value.toFixed(1)}%`
}

function QuotaProjectionRow({ projection }: { projection: QuotaProjection }): ReactElement {
  const percent = formatProjectedPercent(projection.projectedUsedPercent)
  const headline = projection.status === 'unavailable' ? 'Projection unavailable' : `Projected ${percent} by reset`
  const statusCopy =
    projection.status === 'exhausts-before-reset'
      ? 'Likely to use up quota before reset'
      : projection.status === 'full-at-reset'
        ? 'Expected to use full quota by reset'
        : projection.status === 'lasts-until-reset'
          ? 'Expected to last until reset'
          : 'Current reset window unavailable'

  return (
    <div className={`projection-row projection-row--${projection.status}`}>
      <div>
        <span className="eyebrow">CURRENT-WEEK PACE</span>
        <strong>{headline}</strong>
      </div>
      <span>{statusCopy}</span>
    </div>
  )
}

function collapsedProjectionCopy(projection: QuotaProjection): string {
  if (projection.status === 'unavailable') return 'Projection unavailable'
  const percent = formatProjectedPercent(projection.projectedUsedPercent)
  if (projection.status === 'exhausts-before-reset') return `Projected ${percent} · runs out early`
  if (projection.status === 'full-at-reset') return `Projected ${percent} · full by reset`
  return `Projected ${percent} · lasts to reset`
}

function CapacityRange({ snapshot }: { snapshot: DashboardSnapshot }): ReactElement {
  const estimate = snapshot.reset.capacity
  if (!estimate.lowerTokens || !estimate.upperTokens) {
    return (
      <div className="capacity-row muted">
        <span>Estimated weekly capacity</span>
        <strong>Learning your usage mix…</strong>
      </div>
    )
  }
  return (
    <div className="capacity-row">
      <span>Estimated weekly capacity</span>
      <strong>{formatTokens(estimate.lowerTokens)}–{formatTokens(estimate.upperTokens)}</strong>
      <small>
        Median {estimate.medianTokens ? formatTokens(estimate.medianTokens) : 'N/A'} · {estimate.confidence} confidence · {estimate.sampleCount} cycle{estimate.sampleCount === 1 ? '' : 's'}
      </small>
    </div>
  )
}

function BreakdownItem({
  icon,
  label,
  value
}: {
  icon: ReactElement
  label: string
  value: string
}): ReactElement {
  return (
    <div>
      <span>{icon} {label}</span>
      <strong title={formatExactTokens(value)}>{formatTokens(value)}</strong>
    </div>
  )
}

function calculateBreakdown(tokens: TokenBreakdown): { uncached: string } {
  const uncached = safeBigInt(tokens.input) - safeBigInt(tokens.cachedInput) - safeBigInt(tokens.cacheWriteInput)
  return { uncached: (uncached > 0n ? uncached : 0n).toString() }
}

function prettyModelName(model: string): string {
  return model
    .replace(/^gpt-/u, 'GPT ')
    .replaceAll('-', ' ')
    .replace(/\b(sol|terra|luna)\b/giu, (value) => value[0]!.toUpperCase() + value.slice(1).toLowerCase())
}

function LoadingShell(): ReactElement {
  return (
    <main className="overlay-shell collapsed-shell loading-shell">
      <div className="loading-dot" />
      <div><strong>Codex usage</strong><span>Connecting to local data…</span></div>
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
