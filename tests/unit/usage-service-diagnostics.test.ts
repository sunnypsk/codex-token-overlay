import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

const { PricingDiagnostics } = await import('../../src/main/pricing-diagnostics.js')
const { UsageService } = await import('../../src/main/usage-service.js')
const { createDefaultState } = await import('../../src/main/state.js')

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('UsageService diagnostics shutdown', () => {
  it('drains a queued diagnostic write before stop resolves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-usage-diagnostics-stop-'))
    roots.push(root)
    const logs = join(root, 'logs')
    const diagnostics = new PricingDiagnostics(logs, { log: () => undefined })
    const queued = diagnostics.emit(createDefaultState())
    const service = new UsageService(root, logs, diagnostics)
    await service.stop()
    await queued
    const content = await readFile(diagnostics.filePath, 'utf8')
    expect(JSON.parse(content.trim()).event).toBe('pricing-diagnostic.v1')
  })

  it('does not hang shutdown when a diagnostics flush is stuck', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-usage-diagnostics-timeout-'))
    roots.push(root)
    const flush = vi.fn(() => new Promise<void>(() => undefined))
    const diagnostics = { emit: vi.fn(), flush, filePath: join(root, 'secret-log-path') } as unknown as InstanceType<typeof PricingDiagnostics>
    const service = new UsageService(root, join(root, 'logs'), diagnostics, 30)
    const started = Date.now()
    await service.stop()
    expect(flush).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(500)
  })
})
