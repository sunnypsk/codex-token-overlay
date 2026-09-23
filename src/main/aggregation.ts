import type {
  CapacityEstimate,
  CurrentWeekEstimate,
  DashboardSnapshot,
  DailyUsagePoint,
  FreshnessStatus,
  ModelUsageSummary,
  PeriodKey,
  PeriodSummary,
  RateLimitBucket,
  RateLimitWindow,
  ResetSummary,
  TokenBreakdown
} from '../shared/contracts.js'
import {
  calculateModelCostDetailed,
  resolveEffectiveModelPricing,
  resolveModelPrice,
  roundAttoUsdToMicroUsd,
  type ContextUsage,
  type StoredModelPrice,
  type StoredPriceBook
} from './pricing.js'
import type {
  PersistentState,
  StoredCycleAggregate,
  StoredModelAggregate,
  ServiceTier
} from './state.js'
import {
  addTokens,
  deserializeTokens,
  serializeTokens,
  zeroTokens,
  type BigTokenBreakdown
} from './token-math.js'
import {
  dateKeysBetween,
  formatHongKongIso,
  hongKongDateKey,
  rollingHongKongDateRange,
  startOfHongKongDay,
  startOfHongKongMonth,
  startOfHongKongWeek
} from './time.js'
import { estimateQuotaProjection } from '../shared/quota-projection.js'
export { estimateQuotaProjection } from '../shared/quota-projection.js'

interface ModelAggregateBig extends ContextUsage {
  unknown?: BigTokenBreakdown
  eventCount: number
  firstEventAt?: string
  lastEventAt?: string
  bySpeed?: Partial<Record<ServiceTier, { short: BigTokenBreakdown; long: BigTokenBreakdown; unknown?: BigTokenBreakdown; eventCount: number; firstEventAt?: string; lastEventAt?: string }>>
  /** Legacy fallback is a separate slice so future appends remain priceable. */
  legacy?: ModelAggregateSlice
}

interface ModelAggregateSlice extends ContextUsage {
  unknown?: BigTokenBreakdown
  eventCount: number
  firstEventAt?: string
  lastEventAt?: string
  bySpeed?: Partial<Record<ServiceTier, { short: BigTokenBreakdown; long: BigTokenBreakdown; unknown?: BigTokenBreakdown; eventCount: number; firstEventAt?: string; lastEventAt?: string }>>
}

interface PricingSegment {
  model: string
  usage: ModelAggregateSlice
  legacy: boolean
}

type ModelsBig = Record<string, ModelAggregateBig>

const RESET_DRIFT_TOLERANCE_SECONDS = 5

interface AggregatedCycle {
  limitId: string
  resetsAt: number
  windowDurationMins: number
  models: ModelsBig
  /** Keep each persisted cycle/model slice separate for effective-dated pricing. */
  pricingSegments?: PricingSegment[]
  usedPercents: Set<number>
}

export interface SnapshotRuntimeStatus {
  appServer: FreshnessStatus['appServer']
  appServerMessage: string | null
  indexing: FreshnessStatus['indexing']
  indexedFiles: number
  totalFiles: number
}

export function buildDashboardSnapshot(
  state: PersistentState,
  runtime: SnapshotRuntimeStatus,
  fallbackRateLimit: RateLimitBucket | null,
  nowMs = Date.now()
): DashboardSnapshot {
  const periods = {
    today: buildPeriod('today', startOfHongKongDay(nowMs), nowMs, state),
    week: buildPeriod('week', startOfHongKongWeek(nowMs), nowMs, state),
    month: buildPeriod('month', startOfHongKongMonth(nowMs), nowMs, state)
  }
  const rateLimits = state.rateLimits.length > 0 ? state.rateLimits : fallbackRateLimit ? [fallbackRateLimit] : []
  const reset = buildResetSummary(state, rateLimits, nowMs)

  return {
    generatedAt: new Date(nowMs).toISOString(),
    timezone: 'Asia/Hong_Kong',
    periods,
    reset,
    rateLimits,
    freshness: {
      appServer: runtime.appServer,
      appServerMessage: runtime.appServerMessage,
      accountSyncedAt: state.account.syncedAt,
      localIndexedAt: state.localIndexedAt,
      pricingCheckedAt: state.priceBook.checkedAt,
      pricingUpdatedAt: state.priceBook.updatedAt,
      pricingStale: state.priceBook.stale,
      pricingMessage: state.priceBook.message,
      indexing: runtime.indexing,
      indexedFiles: runtime.indexedFiles,
      totalFiles: runtime.totalFiles,
      pricingSource: state.priceBook.sourceUrl,
      pricingSourceSha256: state.priceBook.sourceSha256 ?? null,
      pricingPayloadSha256: state.priceBook.payloadSha256 ?? null,
      pricingQuality: state.priceBook.sourceQuality ?? (state.priceBook.stale ? 'stale' : 'legacy'),
      pricingComponents: collectPricingComponents(state.priceBook),
      pricingConflicts: (state.priceBook.conflicts ?? []).map((conflict) => ({ model: conflict.model, component: conflict.component })),
      pendingPricing: state.pendingPricingQueue.filter((entry) => entry.status === 'pending' || entry.status === 'processing').length,
      rebuild: { ...state.rebuild }
    },
    settings: { ...state.settings }
  }
}

export function buildPeriod(
  key: PeriodKey,
  startMs: number,
  endMs: number,
  state: PersistentState
): PeriodSummary {
  const rollingDayCount = key === 'week' ? 7 : key === 'month' ? 30 : null
  const rollingRange = rollingDayCount === null ? null : rollingHongKongDateRange(endMs, rollingDayCount)
  const dateKeys = rollingRange?.dateKeys ?? dateKeysBetween(startMs, endMs)
  const periodStartMs = rollingRange?.startMs ?? startMs
  const dateSet = new Set(dateKeys)
  const models = aggregateDailyModels(state, dateSet)
  const pricingSegments = collectPricingSegments(state, dateSet)
  const localTokens = sumModels(models)
  const today = hongKongDateKey(endMs)
  let authoritativeTokens = 0n
  let accountTokens = 0n
  let usedAccount = false
  let usedLocal = false
  let liveAccountSyncPending = false

  const dailyUsage: DailyUsagePoint[] = []
  for (const dateKey of dateKeys) {
    const accountValue = state.account.dailyUsageBuckets[dateKey]
    const accountDay = parseNonNegativeTokenCount(accountValue)
    if (accountDay !== null) {
      authoritativeTokens += accountDay
      accountTokens += accountDay
      usedAccount = true
      if (key !== 'today') {
        dailyUsage.push({
          date: dateKey,
          tokens: typeof accountValue === 'string' ? accountValue : accountDay.toString(),
          source: 'account'
        })
      }
      continue
    }

    const localModels = aggregateDailyModels(state, new Set([dateKey]))
    const localForDay = sumModels(localModels).total
    const hasLocalAggregate = Object.keys(localModels).length > 0
    if (hasLocalAggregate) {
      authoritativeTokens += localForDay
      usedLocal = true
      if (key !== 'today') dailyUsage.push({ date: dateKey, tokens: localForDay.toString(), source: 'local' })
    } else if (key !== 'today') {
      dailyUsage.push({ date: dateKey, tokens: null, source: 'unavailable' })
    } else {
      // Today retains its legacy aggregate semantics: an absent account bucket
      // contributes a zero local fallback even when no local event exists.
      authoritativeTokens += localForDay
    }
    if (dateKey === today) liveAccountSyncPending = true
  }

  const source = usedAccount && usedLocal ? 'mixed' : usedAccount ? 'account' : 'local'
  const { cost, modelSummaries } = calculateCostSummary(models, usedAccount ? accountTokens : null, state.priceBook, state.pricingLedger, pricingSegments)

  return {
    key,
    label: periodLabel(key),
    startAt: formatHongKongIso(periodStartMs),
    endAt: formatHongKongIso(endMs),
    tokens: serializeTokens(localTokens),
    authoritativeTokens: authoritativeTokens.toString(),
    source,
    liveAccountSyncPending,
    cost,
    models: modelSummaries,
    ...(key !== 'today' ? { dailyUsage } : {})
  }
}

export function estimateCapacity(cycles: AggregatedCycle[], current: AggregatedCycle | null): CapacityEstimate {
  const currentReset = current?.resetsAt ?? Number.POSITIVE_INFINITY
  const currentWindow = current?.windowDurationMins ?? 10_080
  const candidates = cycles
    .filter(
      (cycle) =>
        cycle.limitId === 'codex' &&
        cycle.resetsAt <= currentReset &&
        cycle.windowDurationMins === currentWindow
    )
    .sort((left, right) => right.resetsAt - left.resetsAt)
    .slice(0, 9)
    .flatMap((cycle) => {
      const usedPercent = Math.max(0, ...cycle.usedPercents)
      const tokens = sumModels(cycle.models).total
      if (usedPercent < 15 || cycle.usedPercents.size < 3 || tokens <= 0n) return []
      const usedMilliPercent = BigInt(Math.round(usedPercent * 1_000))
      return [(tokens * 100_000n) / usedMilliPercent]
    })

  if (candidates.length === 0) {
    return {
      lowerTokens: null,
      medianTokens: null,
      upperTokens: null,
      confidence: 'none',
      sampleCount: 0,
      explanation: 'Not enough valid reset-cycle samples yet.'
    }
  }

  const anchor = candidates[0]!
  const ratioFiltered = candidates.filter(
    (value) => value * 50n >= anchor && value <= anchor * 50n
  )
  let sorted = [...(ratioFiltered.length > 0 ? ratioFiltered : candidates)].sort(compareBigInt)
  if (sorted.length >= 5) sorted = removeTukeyOutliers(sorted)
  const median = quantile(sorted, 0.5)
  let lower: bigint
  let upper: bigint
  if (sorted.length >= 3) {
    lower = quantile(sorted, 0.2)
    upper = quantile(sorted, 0.8)
  } else {
    lower = (sorted[0]! * 80n) / 100n
    upper = (sorted.at(-1)! * 120n) / 100n
  }

  const spreadIsTight = median > 0n && (upper - lower) * 100n <= median * 25n
  const currentUsed = current ? Math.max(0, ...current.usedPercents) : 0
  const confidence =
    sorted.length >= 5 && spreadIsTight
      ? 'high'
      : sorted.length >= 3 || currentUsed >= 30
        ? 'medium'
        : 'low'

  return {
    lowerTokens: lower.toString(),
    medianTokens: median.toString(),
    upperTokens: upper.toString(),
    confidence,
    sampleCount: sorted.length,
    explanation: 'Empirical raw-token range from the current and up to eight recent valid reset cycles.'
  }
}

function estimateCurrentCapacity(current: AggregatedCycle | null, usedPercent: number | null): CapacityEstimate {
  const unavailable: CapacityEstimate = {
    lowerTokens: null,
    medianTokens: null,
    upperTokens: null,
    projectedTokens: null,
    basisUsedPercent: null,
    confidence: 'none',
    sampleCount: 0,
    explanation: 'No current reset-cycle token sample is available.'
  }
  if (!current || usedPercent === null || !Number.isFinite(usedPercent) || usedPercent <= 0 || usedPercent > 100) {
    return unavailable
  }

  const currentTokens = sumModels(current.models).total
  if (currentTokens <= 0n) return unavailable

  const usedMilliPercent = Math.round(usedPercent * 1_000)
  if (!Number.isSafeInteger(usedMilliPercent) || usedMilliPercent <= 0 || usedMilliPercent > 100_000) {
    return unavailable
  }

  const denominator = BigInt(usedMilliPercent)
  const projectedTokens = (currentTokens * 100_000n + denominator / 2n) / denominator
  return {
    lowerTokens: null,
    medianTokens: null,
    upperTokens: null,
    projectedTokens: projectedTokens.toString(),
    basisUsedPercent: usedPercent,
    confidence: usedPercent < 15 ? 'low' : 'medium',
    sampleCount: 1,
    explanation: 'Current reset-cycle raw-token projection at the observed usage percentage.'
  }
}

function unavailableCurrentWeekEstimate(
  lowerBound = false,
  basisUsedPercent: number | null = null,
  priceCoveragePercent: number | null = null
): CurrentWeekEstimate {
  return {
    observedMicroUsd: null,
    estimatedTotalMicroUsd: null,
    estimatedRemainingMicroUsd: null,
    priceCoveragePercent,
    basisUsedPercent,
    lowerBound
  }
}

function estimateCurrentWeekApiEquivalent(
  current: AggregatedCycle | null,
  usedPercent: number | null,
  priceBook: StoredPriceBook,
  pricingLedger: PersistentState['pricingLedger']
): CurrentWeekEstimate {
  if (!current || usedPercent === null || !Number.isFinite(usedPercent) || usedPercent <= 0 || usedPercent > 100) {
    return unavailableCurrentWeekEstimate()
  }

  const { cost, attoUsd } = calculateCostSummary(current.models, null, priceBook, pricingLedger, current.pricingSegments ?? [])
  const lowerBound = cost.lowerBound === true
  if (cost.pricedTokens === '0' || attoUsd <= 0n) {
    return unavailableCurrentWeekEstimate(lowerBound, usedPercent, currentTokensPriceCoverage(current, cost.priceCoveragePercent ?? null))
  }

  const usedMilliPercent = Math.round(usedPercent * 1_000)
  if (!Number.isSafeInteger(usedMilliPercent) || usedMilliPercent <= 0) {
    return unavailableCurrentWeekEstimate(lowerBound, usedPercent, currentTokensPriceCoverage(current, cost.priceCoveragePercent ?? null))
  }

  const observedMicroUsd = roundAttoUsdToMicroUsd(attoUsd)
  // usedPercent is represented in thousandths of a percent. Scale by
  // 100 / usedPercent with integer round-half-up, keeping all monetary math
  // in BigInt and avoiding floating point drift for large totals.
  const scaleDenominator = BigInt(usedMilliPercent)
  const scaleNumerator = 100_000n
  const estimatedTotalAtto = (attoUsd * scaleNumerator + scaleDenominator / 2n) / scaleDenominator
  const estimatedTotal = roundAttoUsdToMicroUsd(estimatedTotalAtto)
  const estimatedRemaining = estimatedTotal >= observedMicroUsd ? estimatedTotal - observedMicroUsd : 0n

  return {
    observedMicroUsd: observedMicroUsd.toString(),
    estimatedTotalMicroUsd: estimatedTotal.toString(),
    estimatedRemainingMicroUsd: estimatedRemaining.toString(),
    priceCoveragePercent: cost.priceCoveragePercent ?? null,
    basisUsedPercent: usedPercent,
    lowerBound
  }
}

function currentTokensPriceCoverage(current: AggregatedCycle, coverage: number | null): number | null {
  return sumModels(current.models).total > 0n ? coverage ?? 0 : null
}

function buildResetSummary(
  state: PersistentState,
  rateLimits: RateLimitBucket[],
  nowMs: number
): ResetSummary {
  const main = rateLimits.find((bucket) => bucket.limitId === 'codex') ?? rateLimits[0] ?? null
  const window = main?.primary ?? null
  if (!main || !window) {
    return {
      limitId: null,
      usedPercent: null,
      startsAt: null,
      resetsAt: null,
      tokensSinceReset: serializeTokens(zeroTokens()),
      projection: estimateQuotaProjection(null, null, null, nowMs),
      capacity: estimateCurrentCapacity(null, null),
      currentWeekEstimate: unavailableCurrentWeekEstimate()
    }
  }

  const bounds = resetWindowBounds(window)
  if (!bounds || !Number.isFinite(nowMs) || nowMs < bounds.startMs || nowMs >= bounds.resetMs) {
    return {
      limitId: main.limitId,
      usedPercent: Number.isFinite(window.usedPercent) ? window.usedPercent : null,
      startsAt: bounds ? new Date(bounds.startMs).toISOString() : null,
      resetsAt: bounds ? new Date(bounds.resetMs).toISOString() : null,
      tokensSinceReset: serializeTokens(zeroTokens()),
      projection: estimateQuotaProjection(null, null, null, nowMs),
      capacity: estimateCurrentCapacity(null, null),
      currentWeekEstimate: unavailableCurrentWeekEstimate()
    }
  }

  const cycles = aggregateCycles(state)
  const current =
    findCurrentCycle(cycles, main.limitId, window)
  const currentWeekEstimate = estimateCurrentWeekApiEquivalent(
    current,
    window.usedPercent,
    state.priceBook,
    state.pricingLedger
  )
  const tokens = current ? sumModels(current.models) : zeroTokens()
  const resetMs = bounds.resetMs
  const startMs = bounds.startMs

  return {
    limitId: main.limitId,
    usedPercent: window.usedPercent,
    startsAt: new Date(startMs).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    tokensSinceReset: serializeTokens(tokens),
    projection: estimateQuotaProjection(window.usedPercent, startMs, resetMs, nowMs),
    capacity: estimateCurrentCapacity(current, window.usedPercent),
    currentWeekEstimate
  }
}

function resetWindowBounds(window: RateLimitWindow): { startMs: number; resetMs: number } | null {
  if (
    !Number.isFinite(window.resetsAt) ||
    !Number.isFinite(window.windowDurationMins) ||
    window.windowDurationMins <= 0
  ) return null
  const resetMs = Math.trunc(window.resetsAt) * 1_000
  const startMs = resetMs - window.windowDurationMins * 60 * 1_000
  if (!Number.isFinite(resetMs) || !Number.isFinite(startMs) || startMs > resetMs) return null
  return { startMs, resetMs }
}

function aggregateDailyModels(state: PersistentState, dates: Set<string>): ModelsBig {
  const models: ModelsBig = {}
  for (const session of Object.values(state.sessions)) {
    for (const [date, daily] of Object.entries(session.legacyDaily ?? {})) {
      if (!dates.has(date)) continue
      mergeStoredModels(models, daily.models, true)
    }
    for (const [date, daily] of Object.entries(session.daily)) {
      if (!dates.has(date)) continue
      // Compatibility for pre-revision v1 objects that have no dedicated
      // legacyDaily slice yet.
      mergeStoredModels(models, daily.models, session.legacyUnpriced === true && !session.legacyDaily)
    }
  }
  return models
}

function collectPricingSegments(state: PersistentState, dates: Set<string>): PricingSegment[] {
  const segments: PricingSegment[] = []
  for (const session of Object.values(state.sessions)) {
    for (const [date, daily] of Object.entries(session.legacyDaily ?? {})) {
      if (!dates.has(date)) continue
      for (const [model, stored] of Object.entries(daily.models)) {
        segments.push({ model, usage: materializeStoredModel(stored), legacy: true })
      }
    }
    for (const [date, daily] of Object.entries(session.daily)) {
      if (!dates.has(date)) continue
      const legacy = session.legacyUnpriced === true && !session.legacyDaily
      for (const [model, stored] of Object.entries(daily.models)) {
        segments.push({ model, usage: materializeStoredModel(stored), legacy })
      }
    }
  }
  return segments
}

function materializeStoredModel(stored: StoredModelAggregate): ModelAggregateSlice {
  const aggregate: ModelAggregateSlice = {
    short: zeroTokens(),
    long: zeroTokens(),
    unknown: zeroTokens(),
    eventCount: 0,
    bySpeed: {}
  }
  mergeAggregateSlice(aggregate, stored)
  return aggregate
}

function findCurrentCycle(
  cycles: AggregatedCycle[],
  limitId: string,
  window: RateLimitWindow
): AggregatedCycle | null {
  const targetReset = Math.trunc(window.resetsAt)
  const matching = cycles
    .filter(
      (cycle) =>
        cycle.limitId === limitId &&
        cycle.windowDurationMins === window.windowDurationMins &&
        Math.abs(cycle.resetsAt - targetReset) <= RESET_DRIFT_TOLERANCE_SECONDS
    )
    .sort((left, right) => {
      const distance = Math.abs(left.resetsAt - targetReset) - Math.abs(right.resetsAt - targetReset)
      return distance !== 0 ? distance : right.resetsAt - left.resetsAt
    })
  return matching[0] ?? null
}

function aggregateCycles(state: PersistentState): AggregatedCycle[] {
  const cycles = new Map<string, AggregatedCycle>()
  for (const session of Object.values(state.sessions)) {
    for (const [key, stored] of Object.entries(session.legacyCycles ?? {})) {
      const mapKey = `${key}:${stored.windowDurationMins}`
      const cycle = cycles.get(mapKey) ?? createAggregatedCycle(stored)
      mergeStoredModels(cycle.models, stored.models, true)
      appendStoredCycleSegments(cycle.pricingSegments ?? (cycle.pricingSegments = []), stored.models, true)
      for (const percent of stored.usedPercents) cycle.usedPercents.add(percent)
      cycles.set(mapKey, cycle)
    }
    for (const [key, stored] of Object.entries(session.cycles)) {
      const mapKey = `${key}:${stored.windowDurationMins}`
      const cycle = cycles.get(mapKey) ?? createAggregatedCycle(stored)
      const legacy = session.legacyUnpriced === true && !session.legacyCycles
      mergeStoredModels(cycle.models, stored.models, legacy)
      appendStoredCycleSegments(cycle.pricingSegments ?? (cycle.pricingSegments = []), stored.models, legacy)
      for (const percent of stored.usedPercents) cycle.usedPercents.add(percent)
      cycles.set(mapKey, cycle)
    }
  }
  return coalesceResetDrift([...cycles.values()])
}

function createAggregatedCycle(stored: StoredCycleAggregate): AggregatedCycle {
  return {
    limitId: stored.limitId,
    resetsAt: Math.trunc(stored.resetsAt),
    windowDurationMins: stored.windowDurationMins,
    models: {},
    pricingSegments: [],
    usedPercents: new Set<number>()
  }
}

function coalesceResetDrift(cycles: AggregatedCycle[]): AggregatedCycle[] {
  const grouped = new Map<string, AggregatedCycle[]>()
  for (const cycle of cycles) {
    const key = `${cycle.limitId}:${cycle.windowDurationMins}`
    const group = grouped.get(key) ?? []
    group.push(cycle)
    grouped.set(key, group)
  }

  const result: AggregatedCycle[] = []
  for (const group of grouped.values()) {
    group.sort((left, right) => left.resetsAt - right.resetsAt)
    let current: AggregatedCycle | null = null
    let groupStartReset = 0
    for (const cycle of group) {
      if (!current || cycle.resetsAt - groupStartReset > RESET_DRIFT_TOLERANCE_SECONDS) {
        current = {
          limitId: cycle.limitId,
          resetsAt: cycle.resetsAt,
          windowDurationMins: cycle.windowDurationMins,
          models: {},
          pricingSegments: [],
          usedPercents: new Set<number>()
        }
        groupStartReset = cycle.resetsAt
        result.push(current)
      }
      mergeAggregatedCycle(current, cycle)
      current.resetsAt = Math.max(current.resetsAt, cycle.resetsAt)
    }
  }
  return result
}

function mergeAggregatedCycle(target: AggregatedCycle, source: AggregatedCycle): void {
  for (const [model, sourceUsage] of Object.entries(source.models)) {
    const targetUsage = (target.models[model] ??= createModelAggregate())
    mergeModelAggregate(targetUsage, sourceUsage)
  }
  target.pricingSegments!.push(...source.pricingSegments ?? [])
  for (const percent of source.usedPercents) target.usedPercents.add(percent)
}

function appendStoredCycleSegments(
  target: PricingSegment[],
  source: Record<string, StoredModelAggregate>,
  legacy: boolean
): void {
  for (const [model, stored] of Object.entries(source)) {
    target.push({ model, usage: materializeStoredModel(stored), legacy })
  }
}

function createModelAggregate(): ModelAggregateBig {
  return {
    short: zeroTokens(),
    long: zeroTokens(),
    unknown: zeroTokens(),
    eventCount: 0,
    bySpeed: {}
  }
}

function mergeModelAggregate(target: ModelAggregateBig, source: ModelAggregateBig): void {
  mergeModelSlice(target, source)
  if (!source.legacy) return
  const legacy = (target.legacy ??= {
    short: zeroTokens(),
    long: zeroTokens(),
    unknown: zeroTokens(),
    eventCount: 0,
    bySpeed: {}
  })
  mergeModelSlice(legacy, source.legacy)
}

function mergeModelSlice(target: ModelAggregateSlice, source: ModelAggregateSlice): void {
  target.short = addTokens(target.short, source.short)
  target.long = addTokens(target.long, source.long)
  target.unknown = addTokens(target.unknown ?? zeroTokens(), source.unknown ?? zeroTokens())
  target.eventCount += source.eventCount
  target.firstEventAt = minIso(target.firstEventAt, source.firstEventAt)
  target.lastEventAt = maxIso(target.lastEventAt, source.lastEventAt)
  const targetBySpeed = (target.bySpeed ??= {})
  for (const [speed, sourceSpeed] of Object.entries(source.bySpeed ?? {})) {
    if (!sourceSpeed || !isServiceTier(speed)) continue
    const targetSpeed = (targetBySpeed[speed] ??= {
      short: zeroTokens(),
      long: zeroTokens(),
      unknown: zeroTokens(),
      eventCount: 0
    })
    targetSpeed.short = addTokens(targetSpeed.short, sourceSpeed.short)
    targetSpeed.long = addTokens(targetSpeed.long, sourceSpeed.long)
    targetSpeed.unknown = addTokens(targetSpeed.unknown ?? zeroTokens(), sourceSpeed.unknown ?? zeroTokens())
    targetSpeed.eventCount += sourceSpeed.eventCount
    targetSpeed.firstEventAt = minIso(targetSpeed.firstEventAt, sourceSpeed.firstEventAt)
    targetSpeed.lastEventAt = maxIso(targetSpeed.lastEventAt, sourceSpeed.lastEventAt)
  }
}

function mergeStoredModels(target: ModelsBig, source: Record<string, StoredModelAggregate>, legacyUnpriced = false): void {
  for (const [model, stored] of Object.entries(source)) {
    const aggregate = (target[model] ??= {
      short: zeroTokens(),
      long: zeroTokens(),
      unknown: zeroTokens(),
      eventCount: 0,
      bySpeed: {}
    })
    const destination = legacyUnpriced
      ? (aggregate.legacy ??= { short: zeroTokens(), long: zeroTokens(), unknown: zeroTokens(), eventCount: 0, bySpeed: {} })
      : aggregate
    mergeAggregateSlice(destination, stored)
  }
}

function mergeAggregateSlice(target: ModelAggregateSlice, stored: StoredModelAggregate): void {
    target.short = addTokens(target.short, deserializeTokens(stored.short))
    target.long = addTokens(target.long, deserializeTokens(stored.long))
    target.unknown = addTokens(target.unknown ?? zeroTokens(), deserializeTokens(stored.unknown ?? serializeTokens(zeroTokens())))
    target.eventCount += stored.eventCount
    target.firstEventAt = minIso(target.firstEventAt, stored.firstEventAt)
    target.lastEventAt = maxIso(target.lastEventAt, stored.lastEventAt)
    const aggregateBySpeed = (target.bySpeed ??= {})
    for (const [speed, speedStored] of Object.entries(stored.bySpeed ?? {})) {
      if (!isServiceTier(speed)) continue
      const speedAggregate = (aggregateBySpeed[speed] ??= {
        short: zeroTokens(),
        long: zeroTokens(),
        unknown: zeroTokens(),
        eventCount: 0
      })
      speedAggregate.short = addTokens(speedAggregate.short, deserializeTokens(speedStored!.short))
      speedAggregate.long = addTokens(speedAggregate.long, deserializeTokens(speedStored!.long))
      speedAggregate.unknown = addTokens(speedAggregate.unknown ?? zeroTokens(), deserializeTokens(speedStored!.unknown ?? serializeTokens(zeroTokens())))
      speedAggregate.eventCount += speedStored!.eventCount
      speedAggregate.firstEventAt = minIso(speedAggregate.firstEventAt, speedStored!.firstEventAt)
      speedAggregate.lastEventAt = maxIso(speedAggregate.lastEventAt, speedStored!.lastEventAt)
    }
    // v1 data had no speed dimension. Treat it as an explicitly lower-bound
    // Standard bucket instead of silently inflating Fast coverage.
    if (Object.keys(stored.bySpeed ?? {}).length === 0 && stored.eventCount > 0) {
      const speedAggregate = (aggregateBySpeed.standard ??= {
        short: zeroTokens(),
        long: zeroTokens(),
        unknown: zeroTokens(),
        eventCount: 0
      })
      speedAggregate.short = addTokens(speedAggregate.short, deserializeTokens(stored.short))
      speedAggregate.long = addTokens(speedAggregate.long, deserializeTokens(stored.long))
      speedAggregate.unknown = addTokens(speedAggregate.unknown ?? zeroTokens(), deserializeTokens(stored.unknown ?? serializeTokens(zeroTokens())))
      speedAggregate.eventCount += stored.eventCount
    }
}

function sumModels(models: ModelsBig): BigTokenBreakdown {
  let total = zeroTokens()
  for (const usage of Object.values(models)) {
    total = addTokens(total, addTokens(addTokens(usage.short, usage.long), usage.unknown ?? zeroTokens()))
    if (usage.legacy) total = addTokens(total, addTokens(addTokens(usage.legacy.short, usage.legacy.long), usage.legacy.unknown ?? zeroTokens()))
  }
  return total
}

function calculateCostSummary(
  models: ModelsBig,
  authoritativeAccountTokens: bigint | null,
  priceBook: StoredPriceBook,
  pricingLedger: PersistentState['pricingLedger'] = [],
  pricingSegments: PricingSegment[] = []
): {
  cost: PeriodSummary['cost']
  modelSummaries: ModelUsageSummary[]
  attoUsd: bigint
} {
  let totalAttoUsd = 0n
  let totalPricedTokens = 0n
  let totalUnpricedTokens = 0n
  let localTokens = 0n
  const unknownModels = new Set<string>()
  let lowerBound = false
  let unknownSpeedTokens = 0n
  const tierTotals: Record<ServiceTier, { shortTokens: bigint; longTokens: bigint; unknownTokens: bigint; pricedTokens: bigint; unpricedTokens: bigint; premiumVerifiedTokens: bigint; lowerBound: boolean }> = {
    standard: { shortTokens: 0n, longTokens: 0n, unknownTokens: 0n, pricedTokens: 0n, unpricedTokens: 0n, premiumVerifiedTokens: 0n, lowerBound: false },
    fast: { shortTokens: 0n, longTokens: 0n, unknownTokens: 0n, pricedTokens: 0n, unpricedTokens: 0n, premiumVerifiedTokens: 0n, lowerBound: false },
    unknown: { shortTokens: 0n, longTokens: 0n, unknownTokens: 0n, pricedTokens: 0n, unpricedTokens: 0n, premiumVerifiedTokens: 0n, lowerBound: false }
  }
  const modelSummaries: ModelUsageSummary[] = []
  const segmentsByModel = new Map<string, PricingSegment[]>()
  for (const segment of pricingSegments) {
    const modelSegments = segmentsByModel.get(segment.model) ?? []
    modelSegments.push(segment)
    segmentsByModel.set(segment.model, modelSegments)
  }

  for (const [model, usage] of Object.entries(models)) {
    const combined = addTokens(addTokens(usage.short, usage.long), usage.unknown ?? zeroTokens())
    const totalWithLegacy = usage.legacy
      ? addTokens(combined, addTokens(addTokens(usage.legacy.short, usage.legacy.long), usage.legacy.unknown ?? zeroTokens()))
      : combined
    localTokens += totalWithLegacy.total
    let modelAtto = 0n
    let modelPriced = 0n
    let modelUnpriced = 0n
    let modelLowerBound = false
    const summaryBaseIdentities = new Set<string>()
    let summaryIdentityComplete = true
    let summaryPrice: ReturnType<typeof resolveModelPrice> | undefined
    const segments = segmentsByModel.get(model)?.length
      ? segmentsByModel.get(model)!
      : [
          { model, usage, legacy: false },
          ...(usage.legacy ? [{ model, usage: usage.legacy, legacy: true }] : [])
        ]
    for (const segment of segments) {
      const segmentUsage = segment.usage
      // Persisted cycle/model aggregates retain only endpoint timestamps. If
      // those endpoints resolve to different pricing facts, the indivisible
      // segment cannot be split safely; fail the whole segment closed instead
      // of applying the earliest rate to every token. Changes that occur and
      // revert inside one persisted segment remain unobservable at this
      // granularity and are therefore a documented residual limitation.
      const segmentStable = segment.legacy || isPricingSegmentStable(segment, priceBook, pricingLedger)
      const bySpeed = segmentUsage.bySpeed && Object.keys(segmentUsage.bySpeed).length > 0
        ? segmentUsage.bySpeed
        : { standard: { short: segmentUsage.short, long: segmentUsage.long, unknown: segmentUsage.unknown, eventCount: segmentUsage.eventCount } }
      for (const speed of ['standard', 'fast', 'unknown'] as const) {
        const speedUsage = bySpeed[speed]
        if (!speedUsage) continue
        const speedUnknown = speedUsage.unknown ?? zeroTokens()
        const speedTokens = addTokens(addTokens(speedUsage.short, speedUsage.long), speedUnknown)
        const eventAt = speedUsage.firstEventAt ?? segmentUsage.firstEventAt ?? priceBook.updatedAt
        const effective = segment.legacy || !segmentStable
          ? null
          : resolveEffectiveModelPricing(priceBook, model, eventAt, pricingLedger)
        const selectedPrice = effective?.hasEffectiveBase ? effective.price : undefined
        const baseIdentity = selectedPrice ? pricingBaseIdentity(selectedPrice) : null
        // A valid base can coexist with an ineligible long revision. Keep the
        // selected base for short pricing, but project long to null for this
        // calculation so a future/malformed long rate cannot leak through.
        const effectivePrice = selectedPrice && effective?.hasEffectiveLong === false
          ? { ...selectedPrice, long: null, longContextThreshold: null }
          : selectedPrice
        const fastFact = !segment.legacy && speed === 'fast'
          ? effective?.fastFact ?? null
          : null
        const result = calculateModelCostDetailed(
          { short: speedUsage.short, long: speedUsage.long },
          effectivePrice,
          { fast: speed === 'fast', fastFact }
        )
        const isUnknownSpeed = speed === 'unknown'
        const unknownContextTokens = speedUnknown.total
        const speedUnpricedTokens = (result.unpricedTokens ?? 0n) + unknownContextTokens
        const missingBase = !segment.legacy && !effective?.hasEffectiveBase
        const missingLong = !segment.legacy && speedUsage.long.total > 0n && !effective?.hasEffectiveLong
        const speedLowerBound = result.lowerBound === true || speedUnpricedTokens > 0n || isUnknownSpeed || unknownContextTokens > 0n || segment.legacy || missingBase || missingLong
        if (result.pricedTokens > 0n && selectedPrice) {
          summaryPrice ??= selectedPrice
          if (baseIdentity) summaryBaseIdentities.add(baseIdentity)
          else summaryIdentityComplete = false
        }
        const tier = tierTotals[speed]
        tier.shortTokens += speedUsage.short.total
        tier.longTokens += speedUsage.long.total
        tier.unknownTokens += unknownContextTokens
        tier.pricedTokens += result.pricedTokens
        tier.unpricedTokens += speedUnpricedTokens
        if (speed === 'fast' && fastFact && !result.lowerBound) tier.premiumVerifiedTokens += result.pricedTokens
        tier.lowerBound ||= speedLowerBound
        if (isUnknownSpeed) unknownSpeedTokens += speedTokens.total
        totalAttoUsd += result.attoUsd ?? 0n
        totalPricedTokens += result.pricedTokens
        totalUnpricedTokens += speedUnpricedTokens
        modelAtto += result.attoUsd ?? 0n
        modelPriced += result.pricedTokens
        modelUnpriced += speedUnpricedTokens
        modelLowerBound ||= speedLowerBound
        lowerBound ||= speedLowerBound
      }
    }
    if (modelPriced < totalWithLegacy.total) unknownModels.add(model)
    modelSummaries.push({
      model,
      tokens: serializeTokens(totalWithLegacy),
      apiEquivalentMicroUsd: modelPriced > 0n ? roundAttoUsdToMicroUsd(modelAtto).toString() : null,
      pricedTokens: modelPriced.toString(),
      unpricedTokens: modelUnpriced.toString(),
      lowerBound: modelLowerBound,
      source: summaryIdentityComplete && summaryBaseIdentities.size === 1 && summaryPrice?.base
        ? {
            componentId: summaryPrice.base.componentId,
            source: summaryPrice.base.source,
            sourceUrl: summaryPrice.base.sourceUrl,
            sourceSha256: summaryPrice.base.sourceSha256,
            effectiveAt: summaryPrice.base.effectiveAt,
            observedAt: summaryPrice.base.observedAt,
            quality: summaryPrice.base.quality
          }
        : undefined
    })
  }

  modelSummaries.sort((left, right) => compareDecimalStrings(right.tokens.total, left.tokens.total))
  const accountDenominator = authoritativeAccountTokens !== null && authoritativeAccountTokens > 0n ? authoritativeAccountTokens : null
  const coveragePercent = accountDenominator === null
    ? null
    : percent(totalPricedTokens, accountDenominator)
  const localCoveragePercent = accountDenominator === null ? null : percent(localTokens, accountDenominator)
  const priceCoveragePercent = localTokens > 0n ? percent(totalPricedTokens, localTokens) : null
  const recordedTierTokens = tierTotals.standard.shortTokens + tierTotals.standard.longTokens + tierTotals.standard.unknownTokens + tierTotals.fast.shortTokens + tierTotals.fast.longTokens + tierTotals.fast.unknownTokens + tierTotals.unknown.shortTokens + tierTotals.unknown.longTokens + tierTotals.unknown.unknownTokens
  const knownTierTokens = recordedTierTokens - (tierTotals.unknown.shortTokens + tierTotals.unknown.longTokens + tierTotals.unknown.unknownTokens)
  const tierCoveragePercent = recordedTierTokens > 0n ? percent(knownTierTokens, recordedTierTokens) : null
  const recordedFastTokens = tierTotals.fast.shortTokens + tierTotals.fast.longTokens + tierTotals.fast.unknownTokens
  const verifiedFastTokens = tierTotals.fast.premiumVerifiedTokens
  const fastRateCoveragePercent = recordedFastTokens > 0n ? percent(verifiedFastTokens, recordedFastTokens) : null

  return {
    attoUsd: totalAttoUsd,
    cost: {
      microUsd: totalPricedTokens > 0n ? roundAttoUsdToMicroUsd(totalAttoUsd).toString() : null,
      coveragePercent,
      pricedTokens: totalPricedTokens.toString(),
      unknownModels: [...unknownModels].sort(),
      localCoveragePercent,
      priceCoveragePercent,
      tierCoveragePercent,
      fastRateCoveragePercent,
      lowerBound,
      unpricedTokens: totalUnpricedTokens.toString(),
      unknownSpeedTokens: unknownSpeedTokens.toString(),
      sourceConflicts: (priceBook.conflicts ?? []).map((conflict) => ({ model: conflict.model, component: conflict.component })),
      tiers: {
        standard: serializeTier(tierTotals.standard),
        fast: serializeTier(tierTotals.fast),
        unknown: serializeTier(tierTotals.unknown)
      }
    },
    modelSummaries
  }
}

function pricingBaseIdentity(price: StoredModelPrice): string | null {
  const base = price.base
  if (!base) return null
  return JSON.stringify({
    componentId: base.componentId ?? null,
    source: base.source ?? null,
    sourceUrl: base.sourceUrl ?? null,
    sourceSha256: base.sourceSha256 ?? null,
    sourceCommit: base.sourceCommit ?? null,
    effectiveAt: base.effectiveAt ?? null,
    quality: base.quality ?? null,
    short: {
      inputMicroUsdPerMillion: price.short.inputMicroUsdPerMillion ?? null,
      cachedInputMicroUsdPerMillion: price.short.cachedInputMicroUsdPerMillion ?? null,
      cacheWriteMicroUsdPerMillion: price.short.cacheWriteMicroUsdPerMillion ?? null,
      outputMicroUsdPerMillion: price.short.outputMicroUsdPerMillion ?? null
    }
  })
}

function isPricingSegmentStable(
  segment: PricingSegment,
  priceBook: StoredPriceBook,
  pricingLedger: PersistentState['pricingLedger']
): boolean {
  const usage = segment.usage
  const bySpeed = usage.bySpeed && Object.keys(usage.bySpeed).length > 0
    ? usage.bySpeed
    : { standard: { short: usage.short, long: usage.long, unknown: usage.unknown, eventCount: usage.eventCount, firstEventAt: usage.firstEventAt, lastEventAt: usage.lastEventAt } }
  for (const speed of ['standard', 'fast', 'unknown'] as const) {
    const speedUsage = bySpeed[speed]
    if (!speedUsage) continue
    const firstEventAt = speedUsage.firstEventAt ?? usage.firstEventAt ?? priceBook.updatedAt
    const lastEventAt = speedUsage.lastEventAt ?? usage.lastEventAt ?? firstEventAt
    const first = resolveEffectiveModelPricing(priceBook, segment.model, firstEventAt, pricingLedger)
    const last = resolveEffectiveModelPricing(priceBook, segment.model, lastEventAt, pricingLedger)
    if (effectivePricingIdentity(first, speed) !== effectivePricingIdentity(last, speed)) return false
  }
  return true
}

function effectivePricingIdentity(
  effective: ReturnType<typeof resolveEffectiveModelPricing>,
  speed: ServiceTier
): string {
  const price = effective.price
  const fast = speed === 'fast' && effective.fastFact
    ? {
        model: effective.fastFact.model,
        numerator: effective.fastFact.numerator,
        denominator: effective.fastFact.denominator,
        source: pricingComponentIdentity(effective.fastFact.source)
      }
    : null
  return JSON.stringify({
    resolvedKey: effective.resolvedKey ?? null,
    hasEffectiveBase: effective.hasEffectiveBase,
    hasEffectiveLong: effective.hasEffectiveLong,
    longContextThreshold: effective.longContextThreshold?.toString() ?? null,
    short: pricingSetIdentity(price?.short ?? null),
    long: pricingSetIdentity(price?.long ?? null),
    base: pricingComponentIdentity(price?.base),
    longComponent: pricingComponentIdentity(price?.longComponent),
    fast
  })
}

function pricingSetIdentity(value: StoredModelPrice['short'] | null): Record<string, string | null> | null {
  if (!value) return null
  return {
    input: value.inputMicroUsdPerMillion,
    cachedInput: value.cachedInputMicroUsdPerMillion,
    cacheWriteInput: value.cacheWriteMicroUsdPerMillion,
    output: value.outputMicroUsdPerMillion
  }
}

function pricingComponentIdentity(
  value: NonNullable<StoredModelPrice['base']> | undefined
): Record<string, string | null> | null {
  if (!value) return null
  return {
    componentId: value.componentId,
    source: value.source,
    sourceUrl: value.sourceUrl,
    sourceSha256: value.sourceSha256,
    sourceCommit: value.sourceCommit,
    effectiveAt: value.effectiveAt,
    quality: value.quality
  }
}

function removeTukeyOutliers(sorted: bigint[]): bigint[] {
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const lower = q1 - (iqr * 3n) / 2n
  const upper = q3 + (iqr * 3n) / 2n
  const filtered = sorted.filter((value) => value >= lower && value <= upper)
  return filtered.length > 0 ? filtered : sorted
}

function quantile(sorted: bigint[], percentile: number): bigint {
  const index = Math.round((sorted.length - 1) * percentile)
  return sorted[index] ?? 0n
}

function periodLabel(key: PeriodKey): string {
  if (key === 'today') return 'Today'
  if (key === 'week') return 'Last 7 days'
  return 'Last 30 days'
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function parseNonNegativeTokenCount(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^\d+$/u.test(value)) return null
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

function compareBigInt(left: bigint, right: bigint): number {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareDecimalStrings(left: string, right: string): number {
  return compareBigInt(safeBigInt(left), safeBigInt(right))
}

function percent(numerator: bigint, denominator: bigint): number | null {
  if (denominator <= 0n) return null
  const bounded = numerator < 0n ? 0n : numerator > denominator ? denominator : numerator
  return Number((bounded * 10_000n) / denominator) / 100
}

function isServiceTier(value: string): value is ServiceTier {
  return value === 'standard' || value === 'fast' || value === 'unknown'
}

function minIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return left < right ? left : right
}

function maxIso(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right
  if (!right) return left
  return left > right ? left : right
}

function serializeTier(value: { shortTokens: bigint; longTokens: bigint; unknownTokens: bigint; pricedTokens: bigint; unpricedTokens: bigint; lowerBound: boolean }): {
  shortTokens: string
  longTokens: string
  unknownTokens: string
  pricedTokens: string
  unpricedTokens: string
  lowerBound: boolean
} {
  return {
    shortTokens: value.shortTokens.toString(),
    longTokens: value.longTokens.toString(),
    unknownTokens: value.unknownTokens.toString(),
    pricedTokens: value.pricedTokens.toString(),
    unpricedTokens: value.unpricedTokens.toString(),
    lowerBound: value.lowerBound
  }
}

function collectPricingComponents(priceBook: StoredPriceBook): NonNullable<DashboardSnapshot['freshness']['pricingComponents']> {
  const components = new Map<string, NonNullable<DashboardSnapshot['freshness']['pricingComponents']>[number]>()
  for (const price of Object.values(priceBook.models)) {
    for (const component of [price.base, price.longComponent]) {
      if (!component || components.has(component.componentId)) continue
      components.set(component.componentId, {
        componentId: component.componentId,
        source: component.source,
        sourceUrl: component.sourceUrl,
        sourceSha256: component.sourceSha256,
        effectiveAt: component.effectiveAt,
        observedAt: component.observedAt,
        quality: component.quality
      })
    }
  }
  return [...components.values()]
}

export const aggregationInternals = {
  aggregateDailyModels,
  aggregateCycles,
  sumModels,
  calculateCostSummary,
  pricingBaseIdentity,
  percent
}
