import type {
  CapacityEstimate,
  DashboardSnapshot,
  FreshnessStatus,
  ModelUsageSummary,
  PeriodKey,
  PeriodSummary,
  QuotaProjection,
  RateLimitBucket,
  ResetSummary,
  TokenBreakdown
} from '../shared/contracts.js'
import {
  calculateModelCostDetailed,
  fastFactForModel,
  normalizeModelId,
  resolveModelPrice,
  roundAttoUsdToMicroUsd,
  type ContextUsage,
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
  startOfHongKongDay,
  startOfHongKongMonth,
  startOfHongKongWeek
} from './time.js'

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

type ModelsBig = Record<string, ModelAggregateBig>

interface AggregatedCycle {
  limitId: string
  resetsAt: number
  windowDurationMins: number
  models: ModelsBig
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
  const dateKeys = dateKeysBetween(startMs, endMs)
  const models = aggregateDailyModels(state, new Set(dateKeys))
  const localTokens = sumModels(models)
  const today = hongKongDateKey(endMs)
  let authoritativeTokens = 0n
  let accountTokens = 0n
  let usedAccount = false
  let usedLocal = false
  let liveAccountSyncPending = false

  for (const dateKey of dateKeys) {
    const accountValue = state.account.dailyUsageBuckets[dateKey]
    if (accountValue !== undefined) {
      const accountDay = safeBigInt(accountValue)
      authoritativeTokens += accountDay
      accountTokens += accountDay
      usedAccount = true
      continue
    }
    const localForDay = sumModels(aggregateDailyModels(state, new Set([dateKey]))).total
    authoritativeTokens += localForDay
    if (localForDay > 0n) usedLocal = true
    if (dateKey === today) liveAccountSyncPending = true
  }

  const source = usedAccount && usedLocal ? 'mixed' : usedAccount ? 'account' : 'local'
  const { cost, modelSummaries } = calculateCostSummary(models, usedAccount ? accountTokens : null, state.priceBook)

  return {
    key,
    label: periodLabel(key),
    startAt: formatHongKongIso(startMs),
    endAt: formatHongKongIso(endMs),
    tokens: serializeTokens(localTokens),
    authoritativeTokens: authoritativeTokens.toString(),
    source,
    liveAccountSyncPending,
    cost,
    models: modelSummaries
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

export function estimateQuotaProjection(
  usedPercent: number | null,
  startsAtMs: number | null,
  resetsAtMs: number | null,
  nowMs = Date.now()
): QuotaProjection {
  const unavailable: QuotaProjection = {
    status: 'unavailable',
    projectedUsedPercent: null
  }
  if (
    usedPercent === null ||
    startsAtMs === null ||
    resetsAtMs === null ||
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(startsAtMs) ||
    !Number.isFinite(resetsAtMs) ||
    !Number.isFinite(nowMs) ||
    resetsAtMs <= startsAtMs ||
    nowMs < startsAtMs ||
    nowMs >= resetsAtMs
  ) {
    return unavailable
  }

  const normalizedUsedPercent = Math.max(0, usedPercent)
  if (normalizedUsedPercent === 0) {
    return { status: 'lasts-until-reset', projectedUsedPercent: 0 }
  }

  const elapsedMs = nowMs - startsAtMs
  if (elapsedMs <= 0) return unavailable
  const elapsedFraction = elapsedMs / (resetsAtMs - startsAtMs)
  const projection = normalizedUsedPercent / elapsedFraction
  if (!Number.isFinite(projection)) return unavailable

  const projectedUsedPercent = Math.round(projection * 10) / 10
  const status =
    projectedUsedPercent > 100
      ? 'exhausts-before-reset'
      : projectedUsedPercent === 100
        ? 'full-at-reset'
        : 'lasts-until-reset'
  return { status, projectedUsedPercent }
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
      capacity: estimateCapacity(aggregateCycles(state), null)
    }
  }

  const cycles = aggregateCycles(state)
  const current =
    cycles.find(
      (cycle) => cycle.limitId === main.limitId && cycle.resetsAt === Math.trunc(window.resetsAt)
    ) ?? null
  const tokens = current ? sumModels(current.models) : zeroTokens()
  const resetMs = Math.trunc(window.resetsAt) * 1_000
  const startMs = resetMs - window.windowDurationMins * 60 * 1_000

  return {
    limitId: main.limitId,
    usedPercent: window.usedPercent,
    startsAt: new Date(startMs).toISOString(),
    resetsAt: new Date(resetMs).toISOString(),
    tokensSinceReset: serializeTokens(tokens),
    projection: estimateQuotaProjection(window.usedPercent, startMs, resetMs, nowMs),
    capacity: estimateCapacity(cycles, current)
  }
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

function aggregateCycles(state: PersistentState): AggregatedCycle[] {
  const cycles = new Map<string, AggregatedCycle>()
  for (const session of Object.values(state.sessions)) {
    for (const [key, stored] of Object.entries(session.legacyCycles ?? {})) {
      const cycle = cycles.get(key) ?? {
        limitId: stored.limitId,
        resetsAt: stored.resetsAt,
        windowDurationMins: stored.windowDurationMins,
        models: {},
        usedPercents: new Set<number>()
      }
      mergeStoredModels(cycle.models, stored.models, true)
      for (const percent of stored.usedPercents) cycle.usedPercents.add(percent)
      cycles.set(key, cycle)
    }
    for (const [key, stored] of Object.entries(session.cycles)) {
      const cycle = cycles.get(key) ?? {
        limitId: stored.limitId,
        resetsAt: stored.resetsAt,
        windowDurationMins: stored.windowDurationMins,
        models: {},
        usedPercents: new Set<number>()
      }
      mergeStoredModels(cycle.models, stored.models, session.legacyUnpriced === true && !session.legacyCycles)
      for (const percent of stored.usedPercents) cycle.usedPercents.add(percent)
      cycles.set(key, cycle)
    }
  }
  return [...cycles.values()]
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
  priceBook: StoredPriceBook
): {
  cost: PeriodSummary['cost']
  modelSummaries: ModelUsageSummary[]
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

  for (const [model, usage] of Object.entries(models)) {
    const combined = addTokens(addTokens(usage.short, usage.long), usage.unknown ?? zeroTokens())
    const totalWithLegacy = usage.legacy
      ? addTokens(combined, addTokens(addTokens(usage.legacy.short, usage.legacy.long), usage.legacy.unknown ?? zeroTokens()))
      : combined
    localTokens += totalWithLegacy.total
    const segments: Array<{ usage: ModelAggregateSlice; legacy: boolean }> = [
      { usage, legacy: false },
      ...(usage.legacy ? [{ usage: usage.legacy, legacy: true }] : [])
    ]
    let modelAtto = 0n
    let modelPriced = 0n
    let modelUnpriced = 0n
    let modelLowerBound = false
    let summaryPrice: ReturnType<typeof resolveModelPrice> | undefined
    for (const segment of segments) {
      const segmentUsage = segment.usage
      const price = segment.legacy ? undefined : resolveModelPrice(priceBook, model, { exactOnly: false })
      if (price) summaryPrice = price
      const bySpeed = segmentUsage.bySpeed && Object.keys(segmentUsage.bySpeed).length > 0
        ? segmentUsage.bySpeed
        : { standard: { short: segmentUsage.short, long: segmentUsage.long, unknown: segmentUsage.unknown, eventCount: segmentUsage.eventCount } }
      for (const speed of ['standard', 'fast', 'unknown'] as const) {
        const speedUsage = bySpeed[speed]
        if (!speedUsage) continue
        const speedUnknown = speedUsage.unknown ?? zeroTokens()
        const speedTokens = addTokens(addTokens(speedUsage.short, speedUsage.long), speedUnknown)
        const fastFact = !segment.legacy && speed === 'fast' && speedUsage.firstEventAt
          ? fastFactForModel(model, priceBook, speedUsage.firstEventAt)
          : null
        const baseEffective = price?.base?.effectiveAt
        const longEffective = price?.longComponent?.effectiveAt
        const beforeBase = Boolean(baseEffective && speedUsage.firstEventAt && speedUsage.firstEventAt < baseEffective)
        const beforeLong = Boolean(longEffective && speedUsage.long.total > 0n && speedUsage.firstEventAt && speedUsage.firstEventAt < longEffective)
        const effectivePrice = segment.legacy || beforeBase || beforeLong ? undefined : price
        const result = calculateModelCostDetailed(
          { short: speedUsage.short, long: speedUsage.long },
          effectivePrice,
          { fast: speed === 'fast', fastFact }
        )
        const isUnknownSpeed = speed === 'unknown'
        const unknownContextTokens = speedUnknown.total
        const speedUnpricedTokens = (result.unpricedTokens ?? 0n) + unknownContextTokens
        const speedLowerBound = result.lowerBound === true || isUnknownSpeed || unknownContextTokens > 0n || segment.legacy
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
      source: summaryPrice?.base
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
  if (key === 'week') return 'This week'
  return 'This month'
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
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
  percent
}
