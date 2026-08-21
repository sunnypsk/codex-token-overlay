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
  confidence: Confidence
  sampleCount: number
  explanation: string
}

export interface QuotaProjection {
  status: QuotaProjectionStatus
  projectedUsedPercent: number | null
}

export interface ResetSummary {
  limitId: string | null
  usedPercent: number | null
  startsAt: string | null
  resetsAt: string | null
  tokensSinceReset: TokenBreakdown
  projection: QuotaProjection
  capacity: CapacityEstimate
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

export interface OverlayBridge {
  getSnapshot: () => Promise<DashboardSnapshot>
  refresh: () => Promise<DashboardSnapshot>
  setExpanded: (expanded: boolean) => Promise<DashboardSnapshot>
  setAlwaysOnTop: (alwaysOnTop: boolean) => Promise<DashboardSnapshot>
  setStartAtLogin: (startAtLogin: boolean) => Promise<DashboardSnapshot>
  hide: () => Promise<void>
  quit: () => Promise<void>
  onSnapshot: (listener: (snapshot: DashboardSnapshot) => void) => () => void
}
