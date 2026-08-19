import type { TokenBreakdown } from '../shared/contracts.js'

export interface BigTokenBreakdown {
  input: bigint
  cachedInput: bigint
  cacheWriteInput: bigint
  output: bigint
  reasoningOutput: bigint
  total: bigint
}

export const ZERO_TOKENS: BigTokenBreakdown = Object.freeze({
  input: 0n,
  cachedInput: 0n,
  cacheWriteInput: 0n,
  output: 0n,
  reasoningOutput: 0n,
  total: 0n
})

export function zeroTokens(): BigTokenBreakdown {
  return { ...ZERO_TOKENS }
}

export function addTokens(
  left: BigTokenBreakdown,
  right: BigTokenBreakdown
): BigTokenBreakdown {
  return {
    input: left.input + right.input,
    cachedInput: left.cachedInput + right.cachedInput,
    cacheWriteInput: left.cacheWriteInput + right.cacheWriteInput,
    output: left.output + right.output,
    reasoningOutput: left.reasoningOutput + right.reasoningOutput,
    total: left.total + right.total
  }
}

export function subtractCumulativeTokens(
  current: BigTokenBreakdown,
  previous: BigTokenBreakdown | null
): BigTokenBreakdown {
  if (!previous) return current

  const delta = {
    input: current.input - previous.input,
    cachedInput: current.cachedInput - previous.cachedInput,
    cacheWriteInput: current.cacheWriteInput - previous.cacheWriteInput,
    output: current.output - previous.output,
    reasoningOutput: current.reasoningOutput - previous.reasoningOutput,
    total: current.total - previous.total
  }

  const counterReset = Object.values(delta).some((value) => value < 0n)
  return counterReset ? current : delta
}

export function serializeTokens(tokens: BigTokenBreakdown): TokenBreakdown {
  return {
    input: tokens.input.toString(),
    cachedInput: tokens.cachedInput.toString(),
    cacheWriteInput: tokens.cacheWriteInput.toString(),
    output: tokens.output.toString(),
    reasoningOutput: tokens.reasoningOutput.toString(),
    total: tokens.total.toString()
  }
}

export function deserializeTokens(tokens: TokenBreakdown): BigTokenBreakdown {
  return {
    input: safeBigInt(tokens.input),
    cachedInput: safeBigInt(tokens.cachedInput),
    cacheWriteInput: safeBigInt(tokens.cacheWriteInput),
    output: safeBigInt(tokens.output),
    reasoningOutput: safeBigInt(tokens.reasoningOutput),
    total: safeBigInt(tokens.total)
  }
}

export function fromUnknownTokenUsage(value: unknown): BigTokenBreakdown | null {
  if (!isRecord(value)) return null

  const input = toBigInt(value.input_tokens)
  const cachedInput = toBigInt(value.cached_input_tokens)
  const cacheWriteInput = toBigInt(value.cache_write_input_tokens)
  const output = toBigInt(value.output_tokens)
  const reasoningOutput = toBigInt(value.reasoning_output_tokens)
  const total = toBigInt(value.total_tokens)

  if (input === null || output === null) return null

  return {
    input,
    cachedInput: cachedInput ?? 0n,
    cacheWriteInput: cacheWriteInput ?? 0n,
    output,
    reasoningOutput: reasoningOutput ?? 0n,
    total: total ?? input + output
  }
}

export function uncachedInput(tokens: BigTokenBreakdown): bigint {
  const result = tokens.input - tokens.cachedInput - tokens.cacheWriteInput
  return result > 0n ? result : 0n
}

export function scaleTokenTotal(tokens: BigTokenBreakdown, total: bigint): BigTokenBreakdown {
  if (tokens.total <= 0n || total <= 0n) return zeroTokens()

  const scale = (value: bigint): bigint => (value * total) / tokens.total
  const scaled = {
    input: scale(tokens.input),
    cachedInput: scale(tokens.cachedInput),
    cacheWriteInput: scale(tokens.cacheWriteInput),
    output: scale(tokens.output),
    reasoningOutput: scale(tokens.reasoningOutput),
    total
  }

  return scaled
}

function safeBigInt(value: string): bigint {
  try {
    return BigInt(value)
  } catch {
    return 0n
  }
}

function toBigInt(value: unknown): bigint | null {
  if (typeof value === 'bigint') return value >= 0n ? value : null
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value)
  return null
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
