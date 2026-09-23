import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

test('shows only quota percentages in both overlay sizes', async ({}, testInfo) => {
  const executablePath = process.env.PACKAGED_EXE
  const userDataPath = testInfo.outputPath('user-data')
  await mkdir(userDataPath, { recursive: true })
  const now = Date.now()
  const resetsAt = Math.floor((now + 30 * 60_000) / 1_000)
  const observations = [
    { at: new Date(now - 29 * 60_000).toISOString(), usedPercent: 2.5 },
    ...Array.from({ length: 24 }, (_, index) => ({
      at: new Date(now - (23 - index) * 60_000).toISOString(), usedPercent: (index + 1) * 3.125
    }))
  ]
  await writeFile(resolve(userDataPath, 'quota-state.json'), JSON.stringify({
    version: 1,
    settings: { alwaysOnTop: true, startAtLogin: false, expanded: false },
    window: { x: null, y: null },
    rateLimitsSyncedAt: new Date(now).toISOString(),
    quotaHistory: { limitId: 'codex', resetsAt, windowDurationMins: 60, observations },
    rateLimits: [{
      limitId: 'codex', limitName: 'Codex', planType: null, rateLimitReachedType: null,
      primary: { usedPercent: 75, windowDurationMins: 60, resetsAt }, secondary: null
    }, {
      limitId: 'extra', limitName: 'Other limit', planType: null, rateLimitReachedType: null,
      primary: { usedPercent: 10, windowDurationMins: 60, resetsAt }, secondary: null
    }]
  }), 'utf8')
  const env = { ...process.env, CODEX_OVERLAY_E2E: '1', CODEX_OVERLAY_E2E_USER_DATA: userDataPath,
    CODEX_OVERLAY_E2E_FIXTURE: '1' }
  const electronApp = await electron.launch(
    executablePath
      ? { executablePath, args: [], env }
      : { args: ['.'], cwd: resolve('.'), env }
  )

  try {
    const page = await electronApp.firstWindow()
    await expect(page).toHaveTitle('Codex Token Overlay')
    await expect(page.locator('.usage-ring')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Expand overlay' })).toBeVisible()
    await expect(page.locator('.quota-projection-copy')).toBeVisible()
    await expect(page.locator('body')).not.toContainText(/token|pricing|cost|model|trend|today/i)
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible() ?? false)).toBe(true)
    const collapsed = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())
    expect(collapsed?.width).toBe(340)
    expect(collapsed?.height).toBe(88)
    await page.screenshot({ path: testInfo.outputPath('collapsed-overlay.png') })

    await page.getByRole('button', { name: 'Expand overlay' }).click()
    await expect(page.getByText('CURRENT RESET WINDOW')).toBeVisible()
    await expect(page.getByText('CURRENT-WEEK PACE')).toBeVisible()
    await expect(page.getByRole('progressbar', { name: 'Codex quota used' })).toBeVisible()
    await expect(page.getByRole('img', { name: /Codex quota used percentage trend/ })).toBeVisible()
    await expect(page.locator('.trend-observed')).toHaveCount(2)
    await expect(page.locator('.trend-isolated-point')).toHaveCount(1)
    await expect(page.locator('.trend-projected')).toHaveCount(1)
    await expect(page.locator('.trend-end-label')).toContainText('%')
    const graphForecast = (await page.locator('.trend-end-label').textContent()) ?? ''
    expect(Number.parseFloat(graphForecast)).toBeGreaterThan(100)
    await expect(page.locator('.projection-row strong')).toContainText(graphForecast)
    await expect(page.getByText('Observed', { exact: true })).toBeVisible()
    await expect(page.getByText('Projected', { exact: true })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible()
    await expect(page.locator('body')).not.toContainText(/token|pricing|cost|model|today/i)
    const expanded = await electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBounds())
    expect(expanded?.width).toBe(380)
    expect(expanded?.height).toBe(500)
    const layout = await page.evaluate(() => {
      const doc = (globalThis as unknown as {
        document: {
          documentElement: { clientWidth: number }
          querySelector: (selector: string) => { scrollWidth: number; scrollHeight: number } | null
        }
      }).document
      return {
        width: doc.documentElement.clientWidth,
        scrollWidth: doc.querySelector('.expanded-shell')?.scrollWidth ?? 0,
        scrollHeight: doc.querySelector('.expanded-shell')?.scrollHeight ?? 0
      }
    })
    expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width + 1)
    expect(layout.scrollHeight).toBeLessThanOrEqual(expanded!.height + 1)
    await page.screenshot({ path: testInfo.outputPath('expanded-overlay.png') })

    await page.locator('.trend-last-point').hover({ force: true })
    await expect(page.getByRole('tooltip')).toContainText('75%')
    await expect(page.getByRole('tooltip')).toContainText('HKT')
    await page.screenshot({ path: testInfo.outputPath('trend-tooltip.png') })

    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.locator('.spin')).toHaveCount(0, { timeout: 20_000 })
    await page.getByRole('button', { name: 'Collapse' }).click()
    await expect(page.getByRole('button', { name: 'Expand overlay' })).toBeVisible()
  } finally {
    await electronApp.close()
  }

  const saved = JSON.parse(await readFile(resolve(userDataPath, 'quota-state.json'), 'utf8')) as Record<string, unknown>
  expect(Object.keys(saved).sort()).toEqual(['quotaHistory', 'rateLimits', 'rateLimitsSyncedAt', 'settings', 'version', 'window'])
  expect((saved.quotaHistory as { observations: unknown[] }).observations.length).toBeGreaterThanOrEqual(3)
})
