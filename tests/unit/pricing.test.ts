import { describe, expect, it } from 'vitest'
import {
  calculateModelCost,
  parseModelPricingMarkdown,
  parsePricingMarkdown,
  PricingService
} from '../../src/main/pricing.js'
import { zeroTokens } from '../../src/main/token-math.js'
import { createDefaultState } from '../../src/main/state.js'

const pricingFixture = `
# Pricing

Standard

| Model | Input | Cached input | Cache writes | Output | Input | Cached input | Cache writes | Output |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | $10.00 | $1.00 | $12.50 | $45.00 |
| gpt-5.6-luna | $0.20 | $0.02 | $0.25 | $1.20 | $0.40 | $0.04 | $0.50 | $1.80 |

All models
`

describe('pricing', () => {
  it('parses the first Standard short/long context table', () => {
    const models = parsePricingMarkdown(pricingFixture)
    expect(models['gpt-5.6-sol']?.short.inputMicroUsdPerMillion).toBe('5000000')
    expect(models['gpt-5.6-sol']?.long?.outputMicroUsdPerMillion).toBe('45000000')
    expect(models['gpt-5.6-luna']?.short.cachedInputMicroUsdPerMillion).toBe('20000')
  })

  it('prices uncached, cached, cache-write, and output tokens separately', () => {
    const price = parsePricingMarkdown(pricingFixture)['gpt-5.6-sol']!
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
    expect(calculateModelCost(usage, price)).toEqual({ microUsd: 5_425n, pricedTokens: 1_100n })
  })

  it('derives long-context and cache-write rates from model documentation', () => {
    const markdown = `
Input $5.00
Cached input $0.50
Output $30.00
Prompts with >272K input tokens are priced at 2x input and 1.5x output for the full request.
Cache writes are billed at 1.25x the uncached input token rate.
`
    const parsed = parseModelPricingMarkdown('gpt-5.6-sol', markdown)
    expect(parsed?.short.cacheWriteMicroUsdPerMillion).toBe('6250000')
    expect(parsed?.long?.inputMicroUsdPerMillion).toBe('10000000')
    expect(parsed?.long?.outputMicroUsdPerMillion).toBe('45000000')
    expect(parsed?.longContextThreshold).toBe('272000')
  })

  it('keeps the last-known-good book and marks it stale after a failed daily refresh', async () => {
    let book = createDefaultState().priceBook
    book.stale = false
    const service = new PricingService(
      () => book,
      (next) => void (book = next),
      () => undefined,
      async () => new Response('Forbidden', { status: 403 })
    )

    await service.refreshIfDue(true)
    expect(book.stale).toBe(true)
    expect(book.message).toContain('HTTP 403')
    expect(book.models['gpt-5.6-sol']).toBeDefined()
  })

  it('uses the official-browser document fallback after a direct fetch is blocked', async () => {
    let book = createDefaultState().priceBook
    const service = new PricingService(
      () => book,
      (next) => void (book = next),
      () => undefined,
      async () => new Response('Forbidden', { status: 403 }),
      async () => pricingFixture
    )

    await service.refreshIfDue(true)
    expect(book.stale).toBe(false)
    expect(book.message).toBeNull()
    expect(book.models['gpt-5.6-luna']?.short.outputMicroUsdPerMillion).toBe('1200000')
  })
})
