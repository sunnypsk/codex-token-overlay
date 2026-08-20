import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  calculateModelCost,
  calculateModelCostDetailed,
  canonicalPricingHash,
  createBundledPriceBook,
  FAST_PRICE_FACTS,
  fastFactForModel,
  fetchStructuredPriceBook,
  fetchTextWithTimeout,
  mergePricingSources,
  normalizeLiteLLMPriceBook,
  normalizeModelsDevPriceBook,
  reduceRational,
  roundAttoUsdToMicroUsd,
  resolveEffectiveModelPricing,
  type FastPriceFact
} from '../../src/main/pricing.js'
import { zeroTokens } from '../../src/main/token-math.js'

describe('structured pricing v2 contracts', () => {
  it('converts LiteLLM USD/token to integer microUSD/M and leaves missing writes absent', () => {
    const models = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: '0.000002',
        cache_read_input_token_cost: '0.0000002',
        output_cost_per_token: '0.000012'
      }
    })
    expect(models['gpt-5.4']?.short).toEqual({
      inputMicroUsdPerMillion: '2000000',
      cachedInputMicroUsdPerMillion: '200000',
      cacheWriteMicroUsdPerMillion: null,
      outputMicroUsdPerMillion: '12000000'
    })
  })

  it('uses an explicit complete LiteLLM long component without treating capacity as a rate discriminator', () => {
    const base = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        max_input_tokens: 1000000,
        long_context: {
          input_cost_per_token: 0.000004,
          cache_read_input_token_cost: 0.0000004,
          output_cost_per_token: 0.000024,
          max_input_tokens: 1000000
        }
      }
    })
    const supplement = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000004,
        cache_read_input_token_cost: 0.0000004,
        output_cost_per_token: 0.000024,
        max_input_tokens: 1000000
      }
    })
    const merged = mergePricingSources({ base, longSupplement: supplement })
    expect(merged.models['gpt-5.4']?.long?.inputMicroUsdPerMillion).toBe('4000000')
    expect(merged.conflicts).toHaveLength(0)
    expect(normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        max_input_tokens: 1000000,
        max_tokens: 1000000
      }
    })['gpt-5.4']?.long).toBeNull()
  })

  it('uses the verified 272K contract threshold instead of long-row capacity', () => {
    const model = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        max_input_tokens: 1_000_000,
        max_tokens: 131_072,
        long_context: {
          input_cost_per_token: 0.000004,
          cache_read_input_token_cost: 0.0000004,
          output_cost_per_token: 0.000024,
          max_input_tokens: 1_000_000
        }
      }
    })['gpt-5.4']!
    expect(model.longContextThreshold).toBe('272000')
    const book = createBundledPriceBook()
    book.models['gpt-5.4'] = {
      ...book.models['gpt-5.4']!,
      short: model.short,
      long: model.long,
      longContextThreshold: model.longContextThreshold
    }
    expect(resolveEffectiveModelPricing(book, 'gpt-5.4', '2026-08-19T02:00:00.000Z').longContextThreshold).toBe(272000n)
  })

  it('records divergent complete long components while retaining LiteLLM precedence', () => {
    const base = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        long_context: { input_cost_per_token: 0.000004, cache_read_input_token_cost: 0.0000004, output_cost_per_token: 0.000024 }
      }
    })
    const divergent = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        long_context: { input_cost_per_token: 0.000007, cache_read_input_token_cost: 0.0000007, output_cost_per_token: 0.000042 }
      }
    })
    const merged = mergePricingSources({ base, longSupplement: divergent })
    expect(merged.models['gpt-5.4']?.long?.inputMicroUsdPerMillion).toBe('4000000')
    expect(merged.conflicts).toEqual([expect.objectContaining({ model: 'gpt-5.4', component: 'long' })])
  })

  it('keeps realistic Sol/Terra/Luna LiteLLM bases and atomically adds pinned long rates', () => {
    const base = normalizeLiteLLMPriceBook({
      'gpt-5.6-sol': { input_cost_per_token: 0.000005, cache_read_input_token_cost: 0.0000005, output_cost_per_token: 0.00003, max_input_tokens: 1000000, max_tokens: 131072, litellm_provider: 'openai' },
      'gpt-5.6-terra': { input_cost_per_token: 0.000002, cache_read_input_token_cost: 0.0000002, output_cost_per_token: 0.000012, max_input_tokens: 1000000, max_tokens: 131072, litellm_provider: 'openai' },
      'gpt-5.6-luna': { input_cost_per_token: 0.0000002, cache_read_input_token_cost: 0.00000002, output_cost_per_token: 0.0000012, max_input_tokens: 1000000, max_tokens: 131072, litellm_provider: 'codex' }
    })
    const supplement = normalizeModelsDevPriceBook(JSON.parse(readFileSync(join(process.cwd(), 'assets', 'pricing', 'models-dev-long.json'), 'utf8')))
    const merged = mergePricingSources({ base, longSupplement: supplement })
    expect(merged.conflicts).toEqual([])
    expect(merged.models['gpt-5.6-sol']).toMatchObject({ short: { inputMicroUsdPerMillion: '5000000' }, long: { inputMicroUsdPerMillion: '10000000' }, longContextThreshold: '272000' })
    expect(merged.models['gpt-5.6-terra']).toMatchObject({ short: { inputMicroUsdPerMillion: '2000000' }, long: { inputMicroUsdPerMillion: '4000000' } })
    expect(merged.models['gpt-5.6-luna']).toMatchObject({ short: { inputMicroUsdPerMillion: '200000' }, long: { inputMicroUsdPerMillion: '400000' } })
  })

  it('prices each bucket and rounds once at the microUSD boundary', () => {
    const book = createBundledPriceBook()
    const usage = {
      short: {
        input: 1_000n,
        cachedInput: 600n,
        cacheWriteInput: 100n,
        output: 100n,
        reasoningOutput: 40n,
        total: 1_100n
      },
      long: zeroTokens()
    }
    const result = calculateModelCost(usage, book.models['gpt-5.6-sol'])
    expect(result.microUsd).toBe(5425n)
    expect(result.pricedTokens).toBe(1_100n)
    expect(roundAttoUsdToMicroUsd(500_000_000_000n)).toBe(1n)
  })

  it('keeps the legacy cost wrapper exact while exposing detailed pricing separately', () => {
    const book = createBundledPriceBook()
    const usage = { short: { ...zeroTokens(), input: 1n, total: 1n }, long: zeroTokens() }
    expect(calculateModelCost(usage, book.models['gpt-5.6-sol'])).toEqual({ microUsd: 5n, pricedTokens: 1n })
    expect(calculateModelCostDetailed(usage, book.models['gpt-5.6-sol']).attoUsd).toBe(5_000_000_000_000n)
  })

  it('uses a reduced Fast rational and marks missing premium as a lower bound', () => {
    expect(reduceRational(10n, 4n)).toEqual({ numerator: 5n, denominator: 2n })
    const book = createBundledPriceBook()
    const usage = { short: { ...zeroTokens(), input: 3n, total: 3n }, long: zeroTokens() }
    const result = calculateModelCostDetailed(usage, book.models['gpt-5.5'], {
      fast: true,
      fastFact: null
    })
    expect(result.lowerBound).toBe(true)
    expect(result.pricedTokens).toBe(3n)
    expect(fastFactForModel('gpt-5.5', book)?.numerator).toBe('5')
  })

  it('checks Fast rational divisibility after atto-rate conversion', () => {
    const book = createBundledPriceBook()
    const usage = { short: { ...zeroTokens(), input: 3n, total: 3n }, long: zeroTokens() }
    const exact = calculateModelCostDetailed(usage, book.models['gpt-5.5'], {
      fast: true,
      fastFact: { ...fastFactForModel('gpt-5.5', book)!, numerator: '5', denominator: '2' }
    })
    expect(exact.lowerBound).toBe(false)
    expect(exact.attoUsd).toBe(37_500_000_000_000n)
    const nonExact = calculateModelCostDetailed(usage, book.models['gpt-5.5'], {
      fast: true,
      fastFact: { ...fastFactForModel('gpt-5.5', book)!, numerator: '1', denominator: '3' }
    })
    expect(nonExact.lowerBound).toBe(true)
    expect(nonExact.attoUsd).toBe(15_000_000_000_000n)
  })

  it('shares one in-flight refresh between concurrent manual callers', async () => {
    let calls = 0
    let updates = 0
    let book = createBundledPriceBook()
    const { PricingService } = await import('../../src/main/pricing.js')
    const service = new PricingService(
      () => book,
      (next) => { book = next },
      () => { updates += 1 },
      async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      }
    )
    await Promise.all([service.refreshIfDue(true), service.refreshIfDue(true)])
    expect(calls).toBe(1)
    expect(updates).toBe(1)
  })

  it('bootstraps stale/legacy books immediately while a fresh verified book obeys the interval', async () => {
    const { PricingService } = await import('../../src/main/pricing.js')
    const fresh = createBundledPriceBook('2026-08-19T00:00:00.000Z')
    fresh.stale = false
    fresh.sourceQuality = 'verified'
    fresh.checkedAt = new Date().toISOString()
    let freshCalls = 0
    const freshService = new PricingService(() => fresh, () => undefined, () => undefined, async () => {
      freshCalls += 1
      return new Response('{}', { status: 200 })
    })
    await freshService.refreshIfDue()
    expect(freshCalls).toBe(0)

    const stale = { ...fresh, sourceQuality: 'legacy' as const, models: { broken: {} as never } }
    const saved: { book?: ReturnType<typeof createBundledPriceBook> } = {}
    const staleService = new PricingService(() => stale, (next) => { saved.book = next }, () => undefined, async () => new Response('{}', { status: 200 }))
    await staleService.refreshIfDue()
    expect(saved.book?.sourceQuality).toBe('embedded')
    expect(saved.book?.models['gpt-5.6-sol']?.long).toBeDefined()
  })

  it('preserves stale verified last-good pricing across repeated refresh failures', async () => {
    const { PricingService } = await import('../../src/main/pricing.js')
    let book = createBundledPriceBook('2026-08-18T00:00:00.000Z')
    book.models['gpt-5.4'] = { ...book.models['gpt-5.4']!, short: { ...book.models['gpt-5.4']!.short, inputMicroUsdPerMillion: '777' } }
    book.payloadSha256 = canonicalPricingHash(book.models)
    book.sourceQuality = 'verified'
    book.stale = true
    book.checkedAt = '2026-08-18T00:00:00.000Z'
    let calls = 0
    const service = new PricingService(
      () => book,
      (next) => { book = next },
      () => undefined,
      async () => {
        calls += 1
        return new Response('{}', { status: 200 })
      }
    )
    await service.refreshIfDue()
    await service.refreshIfDue()
    expect(calls).toBe(2)
    expect(book.sourceQuality).toBe('verified')
    expect(book.models['gpt-5.4']?.short.inputMicroUsdPerMillion).toBe('777')
  })

  it('refreshes changed models.dev misses even when LiteLLM is 304', async () => {
    const previous = createBundledPriceBook('2026-08-19T00:00:00.000Z')
    previous.sourceCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    previous.sourceEffectiveAt = '2026-08-18T00:00:00.000Z'
    previous.commitEtag = 'commit-old'
    previous.sourceEtag = 'raw-old'
    previous.liveModelsDevPayloadSha256 = 'old-payload'
    previous.liveModelsDevObservedAt = '2026-08-18T00:00:00.000Z'
    const now = '2026-08-19T04:00:00.000Z'
    const calls: string[] = []
    const result = await fetchStructuredPriceBook(previous, async (url) => {
      calls.push(url)
      if (url.includes('api.github.com')) return new Response(null, { status: 304, headers: { etag: 'commit-new' } })
      if (url.includes('raw.githubusercontent.com')) return new Response(null, { status: 304, headers: { etag: 'raw-new' } })
      return new Response(JSON.stringify({ openai: { models: {
        'gpt-5.99-live': { cost: { input: 1, cache_read: 0.1, output: 2 }, limit: { max_input_tokens: 272000 } }
      } } }), { status: 200, headers: { etag: 'live-new' } })
    }, now)
    expect(calls.some((url) => url === 'https://models.dev/api.json')).toBe(true)
    expect(result.book.models['gpt-5.99-live']).toBeDefined()
    expect(result.book.liveModelsDevObservedAt).toBe(now)
    expect(result.book.liveModelsDevPayloadSha256).not.toBe('old-payload')
    expect(result.book.payloadSha256).not.toBe(previous.payloadSha256)
  })

  it('keeps an all-304 semantic pricing refresh as a no-op', async () => {
    const previous = createBundledPriceBook('2026-08-19T00:00:00.000Z')
    previous.sourceCommit = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    previous.sourceEffectiveAt = '2026-08-18T00:00:00.000Z'
    previous.commitEtag = 'commit-old'
    previous.sourceEtag = 'raw-old'
    const result = await fetchStructuredPriceBook(previous, async () => new Response(null, { status: 304 }), '2026-08-19T04:00:00.000Z')
    expect(result.notModified).toBe(true)
    expect(result.book.payloadSha256).toBe(previous.payloadSha256)
    expect(result.book.updatedAt).toBe(previous.updatedAt)
  })

  it('aborts a partial streaming body instead of accepting the first chunk', async () => {
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"partial":true'))
      },
      cancel() {
        cancelled = true
      }
    })
    await expect(fetchTextWithTimeout('https://models.dev/api.json', 20, async () => new Response(body))).rejects.toMatchObject({ name: 'AbortError' })
    expect(cancelled).toBe(true)
  })

  it('produces a stable semantic hash independent of object insertion order', () => {
    const book = createBundledPriceBook()
    const reordered = Object.fromEntries(Object.entries(book.models).reverse())
    expect(canonicalPricingHash(book.models)).toBe(canonicalPricingHash(reordered))
  })

  it('asserts runtime embedded constants match bundled fixtures and manifest integrity', () => {
    const fixture = JSON.parse(readFileSync(join(process.cwd(), 'assets', 'pricing', 'litellm-openai.json'), 'utf8')) as Record<string, Record<string, unknown>>
    const fastFixture = JSON.parse(readFileSync(join(process.cwd(), 'assets', 'pricing', 'fast-facts.json'), 'utf8')) as Record<string, { numerator: string; denominator: string }>
    const manifest = JSON.parse(readFileSync(join(process.cwd(), 'assets', 'pricing', 'snapshot-manifest.json'), 'utf8')) as { sources: Array<{ name: string; sha256: string; url: string }> }
    const normalized = normalizeLiteLLMPriceBook(fixture)
    const bundled = createBundledPriceBook()
    for (const model of Object.keys(normalized)) {
      expect(bundled.models[model]?.short.inputMicroUsdPerMillion).toBe(normalized[model]?.short.inputMicroUsdPerMillion)
    }
    for (const [model, fact] of Object.entries(fastFixture)) {
      expect(FAST_PRICE_FACTS[model]?.numerator.toString()).toBe(fact.numerator)
      expect(FAST_PRICE_FACTS[model]?.denominator.toString()).toBe(fact.denominator)
    }
    const fastManifest = manifest.sources.find((source) => source.name === 'Fast facts')!
    expect(fastManifest.url).toMatch(/^https:\/\//u)
    expect(fastManifest.sha256).toBe('668966f33b5afde6656c8e0ec29bc929042fce1f5428b33f4cca11280a5a0e4e')
  })

  it('rejects decimal precision that cannot be represented exactly at the unit scale', () => {
    expect(() => normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: '1e-13',
        cache_read_input_token_cost: '0.0000002',
        output_cost_per_token: '0.000012'
      }
    })).toThrow(/excess precision/u)
    expect(normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: '2e-6',
        cache_read_input_token_cost: '2E-7',
        output_cost_per_token: '1.2e-5'
      }
    })['gpt-5.4']?.short.inputMicroUsdPerMillion).toBe('2000000')
    expect(normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: '1e-12',
        cache_read_input_token_cost: '2e-7',
        output_cost_per_token: '1.2e-5'
      }
    })['gpt-5.4']?.short.inputMicroUsdPerMillion).toBe('1')
  })

  it('selects an effective historical revision through a verified alias', () => {
    const book = createBundledPriceBook()
    const historical = {
      ...book.models['gpt-5.6']!,
      longContextThreshold: '200000',
      base: { ...book.models['gpt-5.6']!.base!, effectiveAt: '2026-08-19T00:00:00.000Z' },
      longComponent: { ...book.models['gpt-5.6']!.longComponent!, effectiveAt: '2026-08-19T00:00:00.000Z' }
    }
    const beforeCurrent = resolveEffectiveModelPricing(
      book,
      'gpt-5.6-codex',
      '2026-08-19T02:00:00.000Z',
      [{ effectiveAt: '2026-08-19T00:00:00.000Z', models: { 'gpt-5.6': historical } }]
    )
    expect(beforeCurrent.longContextThreshold).toBe(200000n)
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6', '2026-08-18T23:00:00.000Z').price).toBeUndefined()
  })

  it('rejects copied canonical components while preserving separators and verified aliases', () => {
    const book = createBundledPriceBook()
    book.models['gpt-5.4-injected'] = { ...book.models['gpt-5.6']! }
    expect(resolveEffectiveModelPricing(book, 'gpt-5.4-injected', '2026-08-19T02:00:00.000Z').price).toBeUndefined()
    expect(resolveEffectiveModelPricing(book, 'openai/gpt-5.4', '2026-08-19T02:00:00.000Z').price).toBeDefined()
    expect(resolveEffectiveModelPricing(book, 'openai/gpt-5.6-codex', '2026-08-19T02:00:00.000Z').price).toBeDefined()

    const invalidSource = {
      ...book,
      models: {
        ...book.models,
        'gpt-5.4': {
          ...book.models['gpt-5.4']!,
          base: { ...book.models['gpt-5.4']!.base!, source: 'untrusted' as never }
        }
      }
    }
    expect(resolveEffectiveModelPricing(invalidSource, 'gpt-5.4', '2026-08-19T02:00:00.000Z').price).toBeUndefined()
  })

  it('preserves the canonical key when an eligible historical base is future or malformed', () => {
    const book = createBundledPriceBook()
    const modelId = 'gpt-5.4'
    const canonical = book.models[modelId]!
    delete book.models[modelId]
    const ledgerEntry = (model: typeof canonical) => [{
      effectiveAt: '2026-08-18T00:00:00.000Z',
      observedAt: '2026-08-18T01:00:00.000Z',
      models: { [modelId]: model }
    }]
    const future = {
      ...canonical,
      base: { ...canonical.base!, effectiveAt: '2026-08-20T00:00:00.000Z' }
    }
    const malformed = {
      ...canonical,
      base: { ...canonical.base!, effectiveAt: 'not-a-date' }
    }
    const futureResult = resolveEffectiveModelPricing(book, modelId, '2026-08-19T02:00:00.000Z', ledgerEntry(future))
    const malformedResult = resolveEffectiveModelPricing(book, modelId, '2026-08-19T02:00:00.000Z', ledgerEntry(malformed))
    expect(futureResult.resolvedKey).toBe(modelId)
    expect(futureResult.price).toBeUndefined()
    expect(futureResult.hasEffectiveBase).toBe(false)
    expect(malformedResult.resolvedKey).toBe(modelId)
    expect(malformedResult.price).toBeUndefined()
    expect(malformedResult.hasEffectiveBase).toBe(false)

    const noEligibleRevision = resolveEffectiveModelPricing(book, modelId, '2026-08-17T23:00:00.000Z', ledgerEntry(canonical))
    expect(noEligibleRevision.resolvedKey).toBeUndefined()
  })

  it('selects the latest whole same-effective revision and fails closed for a malformed winner', () => {
    const book = createBundledPriceBook()
    const canonical = book.models['gpt-5.6']!
    const effectiveAt = '2026-08-19T00:00:00.000Z'
    const revision = (input: string, baseAt = effectiveAt) => ({
      ...canonical,
      short: { ...canonical.short, inputMicroUsdPerMillion: input },
      base: canonical.base ? { ...canonical.base, effectiveAt: baseAt } : undefined,
      longComponent: canonical.longComponent ? { ...canonical.longComponent, effectiveAt: baseAt } : undefined
    })
    const entry = (model: ReturnType<typeof revision>, observedAt?: string | null) => ({
      effectiveAt,
      ...(observedAt === undefined ? {} : { observedAt }),
      models: { 'gpt-5.6': model }
    })
    const malformed = revision('9000000', 'not-a-date')
    const valid = revision('7000000')

    const selected = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(malformed, '2026-08-19T01:00:00.000Z'), entry(valid, '2026-08-19T02:00:00.000Z')]
    )
    expect(selected.price?.short.inputMicroUsdPerMillion).toBe('7000000')

    const malformedWinner = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(valid, '2026-08-19T01:00:00.000Z'), entry(malformed, '2026-08-19T02:00:00.000Z')]
    )
    expect(malformedWinner.price).toBeUndefined()
    expect(malformedWinner.hasEffectiveBase).toBe(false)
  })

  it('orders same-effective revisions by valid observedAt, then append position', () => {
    const book = createBundledPriceBook()
    const canonical = book.models['gpt-5.6']!
    const effectiveAt = '2026-08-19T00:00:00.000Z'
    const revision = (input: string) => ({
      ...canonical,
      short: { ...canonical.short, inputMicroUsdPerMillion: input },
      base: canonical.base ? { ...canonical.base, effectiveAt } : undefined,
      longComponent: canonical.longComponent ? { ...canonical.longComponent, effectiveAt } : undefined
    })
    const entry = (model: ReturnType<typeof revision>, observedAt?: string | null) => ({
      effectiveAt,
      ...(observedAt === undefined ? {} : { observedAt }),
      models: { 'gpt-5.6': model }
    })

    // The newer observed revision is appended after the older one.
    const observedOrder = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(revision('1000000'), '2026-08-19T01:00:00.000Z'), entry(revision('2000000'), '2026-08-19T03:00:00.000Z')]
    )
    expect(observedOrder.price?.short.inputMicroUsdPerMillion).toBe('2000000')

    // A valid observedAt beats an invalid one even when the invalid entry is newer.
    const validObserved = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(revision('3000000'), '2026-08-19T03:00:00.000Z'), entry(revision('4000000'), 'bad-date')]
    )
    expect(validObserved.price?.short.inputMicroUsdPerMillion).toBe('3000000')

    const appendTie = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(revision('5000000')), entry(revision('6000000'), 'bad-date')]
    )
    expect(appendTie.price?.short.inputMicroUsdPerMillion).toBe('6000000')

    const equalObserved = resolveEffectiveModelPricing(
      book,
      'gpt-5.6',
      '2026-08-19T02:00:00.000Z',
      [entry(revision('7000000'), '2026-08-19T01:00:00.000Z'), entry(revision('8000000'), '2026-08-19T01:00:00.000Z')]
    )
    expect(equalObserved.price?.short.inputMicroUsdPerMillion).toBe('8000000')
  })

  it('fails closed for invalid event/provenance/ledger timestamps', () => {
    const book = createBundledPriceBook()
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6', 'not-a-date').price).toBeUndefined()
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6', Number.NaN).price).toBeUndefined()
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6', Number.POSITIVE_INFINITY).price).toBeUndefined()
    const malformedBase = { ...book, models: { ...book.models, 'gpt-5.6': { ...book.models['gpt-5.6']!, base: { ...book.models['gpt-5.6']!.base!, effectiveAt: 'bad-date' } } } }
    expect(resolveEffectiveModelPricing(malformedBase, 'gpt-5.6', '2026-08-19T02:00:00.000Z').price).toBeUndefined()
    const malformedLong = { ...book, models: { ...book.models, 'gpt-5.6': { ...book.models['gpt-5.6']!, longComponent: { ...book.models['gpt-5.6']!.longComponent!, effectiveAt: 'bad-date' } } } }
    expect(resolveEffectiveModelPricing(malformedLong, 'gpt-5.6', '2026-08-19T02:00:00.000Z').longContextThreshold).toBeNull()
    const malformedFast = { ...book, fastFacts: { ...book.fastFacts, 'gpt-5.6-sol': { ...book.fastFacts!['gpt-5.6-sol']!, source: { ...book.fastFacts!['gpt-5.6-sol']!.source, effectiveAt: 'bad-date' } } } }
    expect(fastFactForModel('gpt-5.6-sol', malformedFast)).toBeNull()
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6', '2026-08-19T02:00:00.000Z', [{ effectiveAt: 'future', models: {} }]).price).toBeUndefined()
  })

  it('does not apply a future Fast fact before its effectiveAt', () => {
    const book = createBundledPriceBook()
    const canonicalFact = book.fastFacts?.['gpt-5.6-sol']
    if (!canonicalFact) throw new Error('Missing canonical Fast fact fixture')
    const futureFact: FastPriceFact = {
      ...canonicalFact,
      source: { ...canonicalFact.source, effectiveAt: '2026-08-20T00:00:00.000Z' }
    }
    book.fastFacts = { ...book.fastFacts, 'gpt-5.6-sol': futureFact }
    expect(fastFactForModel('gpt-5.6-sol', book, '2026-08-19T23:59:59.000Z')).toBeNull()
    expect(fastFactForModel('gpt-5.6-sol', book, '2026-08-20T00:00:00.000Z')?.numerator).toBe('2')
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6-sol', '2026-08-19T23:59:59.000Z').fastFact).toBeNull()
    expect(resolveEffectiveModelPricing(book, 'gpt-5.6-sol', '2026-08-20T00:00:00.000Z').fastFact?.numerator).toBe('2')
  })

  it('treats malformed Fast rational strings as Standard lower-bound without throwing', () => {
    const book = createBundledPriceBook()
    const usage = { short: { ...zeroTokens(), input: 3n, total: 3n }, long: zeroTokens() }
    const valid = fastFactForModel('gpt-5.6-sol', book)
    if (!valid) throw new Error('Missing canonical Fast fact fixture')
    const malformedPairs: Array<[string, string]> = [['abc', '1'], ['1', '0'], ['1', '-1'], ['01', '1'], ['1', '9'.repeat(61)]]
    for (const [numerator, denominator] of malformedPairs) {
      const malformed: FastPriceFact = { ...valid, numerator, denominator }
      expect(fastFactForModel('gpt-5.6-sol', { ...book, fastFacts: { ...book.fastFacts, 'gpt-5.6-sol': malformed } })).toBeNull()
      const result = calculateModelCostDetailed(usage, book.models['gpt-5.6-sol'], { fast: true, fastFact: malformed })
      expect(result.lowerBound).toBe(true)
      expect(result.microUsd).toBe(15n)
    }
  })
})
