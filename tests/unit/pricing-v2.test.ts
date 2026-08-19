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

  it('keeps a complete LiteLLM long component ahead of a supplement', () => {
    const base = normalizeLiteLLMPriceBook({
      'gpt-5.4': {
        input_cost_per_token: 0.000002,
        cache_read_input_token_cost: 0.0000002,
        output_cost_per_token: 0.000012,
        max_input_tokens: 272000
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
