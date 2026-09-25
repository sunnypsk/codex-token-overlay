import { describe, expect, it } from 'vitest'
import { writeFile, mkdir, mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { estimateQuotaProjection } from '../../src/shared/quota-projection.js'
import { parseRateLimitBuckets } from '../../src/main/app-server-client.js'
import { buildQuotaSnapshot } from '../../src/main/quota-snapshot.js'
import { createDefaultQuotaState, QuotaStateStore } from '../../src/main/quota-state.js'
import { recordQuotaObservation } from '../../src/main/quota-history.js'
import { splitObservationSegments, splitProjectedSegments } from '../../src/shared/quota-trend.js'

describe.skipIf(!process.env.NATIVE_TEST_EXE)('native implementation parity', () => {
  it('migrates partial legacy settings with the same defaults as v0.1.15', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'native-legacy-parity-'))
    try {
      const legacy = {version: 1, settings: {expanded: true}, window: {x: 450}, sessions: {}, account: {}, priceBook: {}}
      const native = resolve(root, 'native'), reference = resolve(root, 'reference')
      for (const folder of [native, reference]) {
        await mkdir(folder)
        await writeFile(resolve(folder, 'usage-state.json'), JSON.stringify(legacy))
      }
      const expected = await new QuotaStateStore(resolve(reference, 'quota-state.json'), resolve(reference, 'usage-state.json')).load()
      execFileSync(process.env.NATIVE_TEST_EXE!, ['--roundtrip', resolve(native, 'quota-state.json'), resolve(native, 'output.json')])
      expect(JSON.parse(await readFile(resolve(native, 'output.json'), 'utf8'))).toEqual(expected)
      expect(await readFile(resolve(native, 'usage-state.json'), 'utf8')).toBe(JSON.stringify(legacy))
    } finally { await rm(root, {recursive: true, force: true}) }
  })
  it('reads native-written state back through the existing TypeScript store', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'native-quota-parity-'))
    try {
      const original = createDefaultQuotaState()
      original.settings.expanded = true
      original.settings.startAtLogin = false
      original.window = {x: 85, y: 120}
      original.quotaHistory = {limitId: 'codex', resetsAt: 2_000_000_000, windowDurationMins: 10080,
        observations: [{at: new Date(2_000_000_000_000 - 120000).toISOString(), usedPercent: 25},
          {at: new Date(2_000_000_000_000 - 60000).toISOString(), usedPercent: 26, projectedUsedPercent: null}]}
      const source = resolve(root, 'input.json'), target = resolve(root, 'quota-state.json')
      const nativeInput = {...original, window: {...original.window,
        nativeAnchor: {device: 'DISPLAY-test', dipX: 85, dipY: 120, offsetX: 85, offsetY: 120}}}
      await writeFile(source, JSON.stringify(nativeInput))
      execFileSync(process.env.NATIVE_TEST_EXE!, ['--roundtrip', source, target])
      const store = new QuotaStateStore(target, resolve(root, 'usage-state.json'))
      expect(await store.load()).toEqual(original)
      expect(await readFile(source, 'utf8')).toBe(JSON.stringify(nativeInput))
    } finally { await rm(root, {recursive: true, force: true}) }
  })
  it('matches existing TypeScript quota contracts', async () => {
    const at = Date.UTC(2026, 8, 25, 0)
    const cases: Record<string, unknown>[] = []
    for (const used of [null, -1, 0, 0.05, 25, 50, 75, 100, 125]) {
      for (const offset of [-1, 0, 1, 3_600_000, 7_200_000]) {
        const start = at, reset = at + 7_200_000, time = at + offset
        cases.push({name: `projection ${used}/${offset}`, kind: 'projection', used, start, reset, at: time,
          expected: estimateQuotaProjection(used, start, reset, time)})
      }
    }
    const bucket = (limitId: string, usedPercent: number) => ({limitId, limitName: null, planType: null,
      rateLimitReachedType: null, primary: {usedPercent, windowDurationMins: 120, resetsAt: (at + 3_600_000) / 1000}, secondary: null})
    for (const input of [null, {}, {rateLimits: bucket('codex', 25)},
      {rateLimitsByLimitId: {other: bucket('extra', 10), codex: bucket('codex', 25)}},
      {rateLimitsByLimitId: {bad: null}, rateLimits: bucket('codex', 0)},
      {rateLimits: {...bucket('codex', 25), primary: {usedPercent: '25'}}}]) {
      cases.push({name: 'rate limit parsing', kind: 'parse', input, expected: parseRateLimitBuckets(input)})
    }
    const state = createDefaultQuotaState()
    state.rateLimits = [bucket('codex', 25), bucket('extra', 10)]
    state.rateLimitsSyncedAt = new Date(at).toISOString()
    for (const offset of [0, 1_000, 60_000, 240_000, 180_000]) {
      const before = structuredClone(state)
      recordQuotaObservation(state, at + offset)
      cases.push({name: `observe ${offset}`, kind: 'observe', state: before, at: at + offset, expected: structuredClone(state)})
    }
    for (const shift of [0, 1, 60, 61, 3600]) {
      const copy = structuredClone(state)
      copy.rateLimits[0]!.primary!.resetsAt += shift
      for (const connection of ['online', 'offline', 'connecting'] as const) {
        for (const offset of [0, 120_000, 120_001, 3_600_000]) {
          cases.push({name: `snapshot ${shift}/${connection}/${offset}`, kind: 'snapshot', state: copy, connection,
            at: at + offset, expected: buildQuotaSnapshot(copy, {appServer: connection, message: null}, at + offset)})
        }
      }
    }
    const points = state.quotaHistory!.observations
    delete points[0]!.projectedUsedPercent
    for (const forecasts of [false, true]) cases.push({name: 'gap segmentation', kind: 'segments', points, forecasts,
      expected: forecasts ? splitProjectedSegments(points) : splitObservationSegments(points)})
    await mkdir(resolve('build/native'), {recursive: true})
    const fixture = resolve('build/native/parity-fixtures.json')
    await writeFile(fixture, JSON.stringify(cases))
    const output = execFileSync(process.env.NATIVE_TEST_EXE!, ['--fixtures', fixture], {encoding: 'utf8'})
    expect(output).toContain(`${cases.length} parity cases passed`)
  })
})
