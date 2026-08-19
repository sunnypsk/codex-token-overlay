import { describe, expect, it } from 'vitest'
import {
  addTokens,
  fromUnknownTokenUsage,
  subtractCumulativeTokens,
  uncachedInput,
  zeroTokens
} from '../../src/main/token-math.js'

describe('token math', () => {
  it('subtracts cumulative counters without double-counting reasoning tokens', () => {
    const previous = fromUnknownTokenUsage({
      input_tokens: 100,
      cached_input_tokens: 60,
      cache_write_input_tokens: 0,
      output_tokens: 20,
      reasoning_output_tokens: 8,
      total_tokens: 120
    })!
    const current = fromUnknownTokenUsage({
      input_tokens: 175,
      cached_input_tokens: 100,
      cache_write_input_tokens: 5,
      output_tokens: 35,
      reasoning_output_tokens: 15,
      total_tokens: 210
    })!

    expect(subtractCumulativeTokens(current, previous)).toEqual({
      input: 75n,
      cachedInput: 40n,
      cacheWriteInput: 5n,
      output: 15n,
      reasoningOutput: 7n,
      total: 90n
    })
  })

  it('treats a decreased cumulative counter as a reset', () => {
    const previous = { ...zeroTokens(), input: 500n, output: 50n, total: 550n }
    const current = { ...zeroTokens(), input: 20n, output: 2n, total: 22n }
    expect(subtractCumulativeTokens(current, previous)).toEqual(current)
  })

  it('clamps uncached input and adds complete breakdowns', () => {
    const left = {
      input: 100n,
      cachedInput: 80n,
      cacheWriteInput: 30n,
      output: 5n,
      reasoningOutput: 2n,
      total: 105n
    }
    expect(uncachedInput(left)).toBe(0n)
    expect(addTokens(left, zeroTokens())).toEqual(left)
  })
})
