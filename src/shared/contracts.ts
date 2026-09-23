export type PeriodKey = 'today' | 'week' | 'month'
export type ConnectionState = 'connecting' | 'online' | 'offline'
export type IndexingState = 'idle' | 'indexing' | 'error'
export type Confidence = 'high' | 'medium' | 'low' | 'none'
export type ServiceTier = 'standard' | 'fast' | 'unknown'
export type ContextClass = 'short' | 'long'
export type QuotaProjectionStatus =
  | 'unavailable'
  | 'lasts-until-reset'
  | 'full-at-reset'
  | 'exhausts-before-reset'

export interface TokenBreakdown {
  input: string
  cachedInput: string
  cacheWriteInput: string
  output: string
  reasoningOutput: string
  total: string
}

export interface ModelUsageSummary {
  model: string
  tokens: TokenBreakdown
  apiEquivalentMicroUsd: string | null
  pricedTokens: string
  unpricedTokens?: string
  speed?: ServiceTier
  context?: ContextClass
  lowerBound?: boolean
  source?: PricingComponentSummary
}

export interface CostSummary {
  microUsd: string | null
  coveragePercent: number | null
  pricedTokens: string
  unknownModels: string[]
  /** Coverage denominators are null when the corresponding bucket is empty. */
  localCoveragePercent?: number | null
  priceCoveragePercent?: number | null
  tierCoveragePercent?: number | null
  fastRateCoveragePercent?: number | null
  lowerBound?: boolean
  unpricedTokens?: string
  unknownSpeedTokens?: string
  sourceConflicts?: PricingConflictSummary[]
  tiers?: Record<ServiceTier, {
    shortTokens: string
    longTokens: string
    unknownTokens?: string
    pricedTokens: string
    unpricedTokens: string
    lowerBound: boolean
  }>
}

export type DailyUsageSource = 'account' | 'local' | 'unavailable'

interface DailyUsagePointBase {
  /** HKT calendar date in YYYY-MM-DD form. */
  date: string
}

export type DailyUsagePoint =
  | (DailyUsagePointBase & { source: 'account'; tokens: string })
  | (DailyUsagePointBase & { source: 'local'; tokens: string })
  | (DailyUsagePointBase & { source: 'unavailable'; tokens: null })

export interface PricingComponentSummary {
  componentId: string
  source: string
  sourceUrl: string
  sourceSha256: string | null
  effectiveAt: string | null
  observedAt: string | null
  quality: string
}

export interface PricingConflictSummary {
  model: string
  component: 'base' | 'long'
}

export interface PeriodSummary {
  key: PeriodKey
  label: string
  startAt: string
  endAt: string
  tokens: TokenBreakdown
  authoritativeTokens: string
  source: 'account' | 'local' | 'mixed'
  liveAccountSyncPending: boolean
  cost: CostSummary
  models: ModelUsageSummary[]
  /** Present for rolling week/month periods; omitted for legacy Today callers. */
  dailyUsage?: DailyUsagePoint[]
}

export interface RateLimitWindow {
  usedPercent: number
  windowDurationMins: number
  resetsAt: number
}

export interface RateLimitBucket {
  limitId: string
  limitName: string | null
  primary: RateLimitWindow | null
  secondary: RateLimitWindow | null
  planType: string | null
  rateLimitReachedType: string | null
}

export interface CapacityEstimate {
  lowerTokens: string | null
  medianTokens: string | null
  upperTokens: string | null
  /** Current-reset-cycle-only projection; absent for legacy range callers. */
  projectedTokens?: string | null
  /** Reset-window percentage used for the current-cycle projection. */
  basisUsedPercent?: number | null
  confidence: Confidence
  sampleCount: number
  explanation: string
}

export interface QuotaProjection {
  status: QuotaProjectionStatus
  projectedUsedPercent: number | null
}

export interface QuotaObservation {
  at: string
  usedPercent: number
}

export interface CurrentWeekEstimate {
  /** Priced API-equivalent cost observed in the current reset cycle. */
  observedMicroUsd: string | null
  /** Round-half-up extrapolation of the observed cost to 100% of the cycle. */
  estimatedTotalMicroUsd: string | null
  /** Estimated total less the observed priced cost. */
  estimatedRemainingMicroUsd: string | null
  /** Priced local-cycle cost as a percentage of local-cycle tokens. */
  priceCoveragePercent: number | null
  /** Reset-window percentage used as the extrapolation basis. */
  basisUsedPercent: number | null
  /** True when the priced result is incomplete or otherwise a lower bound. */
  lowerBound: boolean
}

export interface ResetSummary {
  limitId: string | null
  usedPercent: number | null
  startsAt: string | null
  resetsAt: string | null
  tokensSinceReset: TokenBreakdown
  projection: QuotaProjection
  capacity: CapacityEstimate
  currentWeekEstimate: CurrentWeekEstimate
}

export interface FreshnessStatus {
  appServer: ConnectionState
  appServerMessage: string | null
  accountSyncedAt: string | null
  localIndexedAt: string | null
  pricingCheckedAt: string | null
  pricingUpdatedAt: string | null
  pricingStale: boolean
  pricingMessage: string | null
  indexing: IndexingState
  indexedFiles: number
  totalFiles: number
  pricingSource?: string
  pricingSourceSha256?: string | null
  pricingPayloadSha256?: string | null
  pricingQuality?: string
  pricingComponents?: PricingComponentSummary[]
  pricingConflicts?: PricingConflictSummary[]
  pendingPricing?: number
  rebuild?: {
    state: string
    processedFiles: number
    totalFiles: number
    pending: number
    message: string | null
    /** Expanded provenance for a background replay or incremental rebuild. */
    mode?: string
    replayedSessions?: number
    retainedLegacySessions?: number
    rawTokenDelta?: string
    failureDiagnostics?: string[]
  }
}

export interface OverlaySettings {
  alwaysOnTop: boolean
  startAtLogin: boolean
  expanded: boolean
}

export interface DashboardSnapshot {
  generatedAt: string
  timezone: 'Asia/Hong_Kong'
  periods: Record<PeriodKey, PeriodSummary>
  reset: ResetSummary
  rateLimits: RateLimitBucket[]
  freshness: FreshnessStatus
  settings: OverlaySettings
}

/** The active IPC payload for the percentage-only overlay. */
export interface QuotaSnapshot {
  generatedAt: string
  reset: {
    limitId: string | null
    usedPercent: number | null
    startsAt: string | null
    resetsAt: string | null
    projection: QuotaProjection
    observations: QuotaObservation[]
  }
  additionalLimits: Array<{
    limitId: string
    label: string
    usedPercent: number | null
    resetsAt: number | null
  }>
  connection: ConnectionState
  connectionMessage: string | null
  rateLimitsSyncedAt: string | null
  stale: boolean
  settings: OverlaySettings
}

export interface OverlayBridge {
  getSnapshot: () => Promise<QuotaSnapshot>
  refresh: () => Promise<QuotaSnapshot>
  setExpanded: (expanded: boolean) => Promise<QuotaSnapshot>
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<QuotaSnapshot>
  setStartAtLogin: (startAtLogin: boolean) => Promise<QuotaSnapshot>
  hide: () => Promise<void>
  quit: () => Promise<void>
  onSnapshot: (listener: (snapshot: QuotaSnapshot) => void) => () => void
}
