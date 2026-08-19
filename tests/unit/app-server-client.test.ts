import { describe, expect, it } from 'vitest'
import { parseRateLimitBuckets } from '../../src/main/app-server-client.js'

describe('App Server contracts', () => {
  it('parses and orders multi-bucket rate limits', () => {
    const result = parseRateLimitBuckets({
      rateLimitsByLimitId: {
        codex_special: {
          limitId: 'codex_special',
          limitName: 'Special',
          primary: { usedPercent: 2, windowDurationMins: 10080, resetsAt: 2_000 }
        },
        codex: {
          limitId: 'codex',
          limitName: null,
          primary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: 1_000 },
          planType: 'pro'
        }
      }
    })

    expect(result).toHaveLength(2)
    expect(result[0]?.limitId).toBe('codex')
    expect(result[0]?.primary?.usedPercent).toBe(60)
    expect(result[1]?.limitName).toBe('Special')
  })

  it('ignores malformed buckets', () => {
    expect(parseRateLimitBuckets({ rateLimits: { primary: {} } })).toEqual([])
  })
})
