import { describe, expect, it } from 'vitest'
import { formatProjectedPercent } from '../../src/shared/quota-projection.js'

describe('projection formatting', () => {
  it('formats readable percentages and caps oversized projections', () => {
    expect(formatProjectedPercent(null)).toBe('N/A')
    expect(formatProjectedPercent(74)).toBe('74%')
    expect(formatProjectedPercent(74.26)).toBe('74.3%')
    expect(formatProjectedPercent(10_080)).toBe('>999%')
  })
})
