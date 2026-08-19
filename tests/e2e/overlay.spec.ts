import { _electron as electron, expect, test } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'

type LayoutRect = { left: number; right: number; top: number; bottom: number }
type LayoutElement = {
  className: string
  style: { cssText: string }
  textContent: string | null
  children: LayoutElement[]
  append: (child: LayoutElement) => void
  remove: () => void
  getBoundingClientRect: () => LayoutRect
  querySelector: <T extends LayoutElement = LayoutElement>(selector: string) => T | null
  querySelectorAll: <T extends LayoutElement = LayoutElement>(selector: string) => T[]
}
type BrowserDocument = {
  documentElement: { clientWidth: number; clientHeight: number }
  createElement: (tag: 'div' | 'small' | 'span') => LayoutElement
}
type BrowserGlobal = {
  document: BrowserDocument & LayoutElement
  getComputedStyle: (element: LayoutElement) => {
    fontSize: string
    lineHeight: string
    color: string
    fontWeight: string
    display: string
    visibility: string
    opacity: string
  }
}
type TypographyMetrics = {
  fontSize: number
  lineHeight: number
  color: string
  fontWeight: string
}
type CapacityMetaSnapshot = TypographyMetrics & {
  text: string
  synthetic: boolean
  visible: boolean
  bounds: LayoutRect
  resetCardBounds: LayoutRect
  shellBounds: LayoutRect
  viewport: { width: number; height: number }
}
type TypographySnapshot = {
  breakdown: TypographyMetrics
  eyebrow: TypographyMetrics
  resetMeta: TypographyMetrics
  projection: TypographyMetrics
  capacityLabel: TypographyMetrics
  capacityMeta: CapacityMetaSnapshot
  secondary: TypographyMetrics
  freshness: TypographyMetrics
}
type LayoutSnapshot = {
  shell: { right: number; bottom: number }
  viewport: { width: number; height: number }
  overflowingChildren: string[]
  overflowingCardChildren: string[]
  overflowingEyebrows: string[]
}

test('renders live usage and toggles between collapsed and expanded views', async ({}, testInfo) => {
  const executablePath = process.env.PACKAGED_EXE
  const userDataPath = testInfo.outputPath('user-data')
  await mkdir(userDataPath, { recursive: true })
  const env = {
    ...process.env,
    CODEX_OVERLAY_E2E: '1',
    CODEX_OVERLAY_E2E_USER_DATA: userDataPath
  }
  const electronApp = await electron.launch(
    executablePath
      ? {
          executablePath,
          args: [],
          env
        }
      : {
          args: ['.'],
          cwd: resolve('.'),
          env
        }
  )

  try {
    const page = await electronApp.firstWindow()
    await expect(page).toHaveTitle('Codex Token Overlay')
    await expect(page.getByText('TODAY')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Expand overlay' })).toBeVisible()
    await expect(page.locator('.quota-projection-copy')).toBeVisible()
    await expect.poll(() => electronApp.evaluate(({ BrowserWindow }) => {
      return BrowserWindow.getAllWindows()[0]?.isVisible() ?? false
    })).toBe(true)

    const collapsed = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('No overlay BrowserWindow')
      return {
        bounds: window.getBounds(),
        visible: window.isVisible(),
        focusable: window.isFocusable(),
        alwaysOnTop: window.isAlwaysOnTop()
      }
    })
    expect(collapsed.bounds.width).toBe(340)
    expect(collapsed.bounds.height).toBe(88)
    expect(collapsed.visible).toBe(true)
    expect(collapsed.focusable).toBe(true)
    expect(collapsed.alwaysOnTop).toBe(true)

    await page.getByRole('button', { name: 'Expand overlay' }).click()
    await expect(page.getByText('ACCOUNT TOKENS')).toBeVisible()
    await expect(page.getByText('RESET WINDOW', { exact: true })).toBeVisible()
    await expect(page.getByText('CURRENT-WEEK PACE')).toBeVisible()
    await expect(page.locator('.projection-row')).toBeVisible()
    await expect(page.getByText('API-EQUIVALENT')).toBeVisible()

    await page.getByRole('button', { name: 'Refresh' }).click()
    await expect(page.locator('.spin')).toHaveCount(0, { timeout: 20_000 })
    const refreshed = await page.evaluate(() =>
      (globalThis as unknown as { codexOverlay: { getSnapshot: () => Promise<{ freshness: { pricingCheckedAt: string | null } }> } })
        .codexOverlay.getSnapshot()
    )
    expect(refreshed.freshness.pricingCheckedAt).not.toBeNull()

    const typography = await page.evaluate(() => {
      const browser = globalThis as unknown as BrowserGlobal
      const shell = browser.document.querySelector<LayoutElement>('.expanded-shell')
      if (!shell) throw new Error('No expanded overlay shell')

      const readMetrics = (element: LayoutElement): TypographyMetrics => {
        const style = browser.getComputedStyle(element)
        return {
          fontSize: Number.parseFloat(style.fontSize),
          lineHeight: Number.parseFloat(style.lineHeight),
          color: style.color,
          fontWeight: style.fontWeight
        }
      }

      const readActual = (selector: string): TypographyMetrics => {
        const element = shell.querySelector<LayoutElement>(selector)
        if (!element) throw new Error(`Missing expected ${selector}`)
        return readMetrics(element)
      }

      const readOrProbe = (selector: string, parentClass: string, childTag: 'div' | 'small' | 'span') => {
        const existing = shell.querySelector<LayoutElement>(selector)
        if (existing) return readMetrics(existing)

        const parent = browser.document.createElement('div')
        parent.className = parentClass
        parent.style.cssText = 'position: absolute; visibility: hidden; pointer-events: none;'
        const child = browser.document.createElement(childTag)
        child.textContent = 'Style probe'
        parent.append(child)
        shell.append(parent)
        const metrics = readMetrics(child)
        parent.remove()
        return metrics
      }

      const capacityRow = shell.querySelector<LayoutElement>('.capacity-row')
      const resetCard = shell.querySelector<LayoutElement>('.reset-card')
      if (!capacityRow || !resetCard) throw new Error('Missing capacity/reset card')
      const existingCapacityMeta = capacityRow.querySelector<LayoutElement>(':scope > small')
      let capacityMeta = existingCapacityMeta
      if (!capacityMeta) {
        capacityMeta = browser.document.createElement('small')
        capacityMeta.textContent = 'Median 6.85B · medium confidence · 2 cycles'
        capacityRow.append(capacityMeta)
      }
      const capacityMetaStyle = browser.getComputedStyle(capacityMeta)
      const capacityMetaBounds = capacityMeta.getBoundingClientRect()
      const resetCardBounds = resetCard.getBoundingClientRect()
      const shellBounds = shell.getBoundingClientRect()
      const viewport = {
        width: browser.document.documentElement.clientWidth,
        height: browser.document.documentElement.clientHeight
      }

      return {
        breakdown: readActual('.breakdown-grid span'),
        eyebrow: readActual('.eyebrow'),
        resetMeta: readActual('.reset-meta'),
        projection: readActual('.projection-row > span'),
        capacityLabel: readActual('.capacity-row > span'),
        capacityMeta: {
          ...readMetrics(capacityMeta),
          text: capacityMeta.textContent ?? '',
          synthetic: !existingCapacityMeta,
          visible:
            capacityMetaStyle.display !== 'none' &&
            capacityMetaStyle.visibility !== 'hidden' &&
            Number.parseFloat(capacityMetaStyle.opacity) > 0 &&
            capacityMetaBounds.right > capacityMetaBounds.left &&
            capacityMetaBounds.bottom > capacityMetaBounds.top,
          bounds: {
            left: capacityMetaBounds.left,
            right: capacityMetaBounds.right,
            top: capacityMetaBounds.top,
            bottom: capacityMetaBounds.bottom
          },
          resetCardBounds: {
            left: resetCardBounds.left,
            right: resetCardBounds.right,
            top: resetCardBounds.top,
            bottom: resetCardBounds.bottom
          },
          viewport,
          shellBounds: {
            left: shellBounds.left,
            right: shellBounds.right,
            top: shellBounds.top,
            bottom: shellBounds.bottom
          }
        },
        secondary: readOrProbe('.secondary-limits > div', 'secondary-limits', 'div'),
        freshness: readActual('.freshness-line')
      }
    })
    const typedTypography = typography as TypographySnapshot
    expect(typedTypography.breakdown.fontSize).toBeGreaterThanOrEqual(9)
    expect(typedTypography.eyebrow.fontSize).toBeGreaterThanOrEqual(10)
    expect(typedTypography.secondary.fontSize).toBeGreaterThanOrEqual(9)
    expect(typedTypography.freshness.fontSize).toBeGreaterThanOrEqual(9)
    expect(typedTypography.resetMeta.fontSize).toBeGreaterThanOrEqual(10)
    expect(typedTypography.projection.fontSize).toBeGreaterThanOrEqual(10)
    expect(typedTypography.capacityLabel.fontSize).toBeGreaterThanOrEqual(10)
    expect(typedTypography.capacityMeta.fontSize).toBeGreaterThanOrEqual(10)
    for (const metrics of Object.values(typedTypography)) {
      if (!('lineHeight' in metrics)) continue
      const lineHeightRatio = metrics.lineHeight / metrics.fontSize
      expect(lineHeightRatio).toBeGreaterThanOrEqual(1.24)
      expect(lineHeightRatio).toBeLessThanOrEqual(1.31)
    }
    expect(typedTypography.eyebrow.color).toBe(typedTypography.resetMeta.color)
    expect(typedTypography.capacityMeta.color).toBe(typedTypography.resetMeta.color)
    expect(typedTypography.capacityMeta.fontWeight).toBe('500')
    expect(typedTypography.capacityMeta.visible).toBe(true)
    if (typedTypography.capacityMeta.synthetic) {
      expect(typedTypography.capacityMeta.text).toBe('Median 6.85B · medium confidence · 2 cycles')
    }
    expect(typedTypography.capacityMeta.bounds.left).toBeGreaterThanOrEqual(typedTypography.capacityMeta.resetCardBounds.left - 1)
    expect(typedTypography.capacityMeta.bounds.right).toBeLessThanOrEqual(typedTypography.capacityMeta.resetCardBounds.right + 1)
    expect(typedTypography.capacityMeta.bounds.top).toBeGreaterThanOrEqual(typedTypography.capacityMeta.resetCardBounds.top - 1)
    expect(typedTypography.capacityMeta.bounds.bottom).toBeLessThanOrEqual(typedTypography.capacityMeta.resetCardBounds.bottom + 1)
    expect(typedTypography.capacityMeta.bounds.left).toBeGreaterThanOrEqual(typedTypography.capacityMeta.shellBounds.left - 1)
    expect(typedTypography.capacityMeta.bounds.right).toBeLessThanOrEqual(typedTypography.capacityMeta.shellBounds.right + 1)
    expect(typedTypography.capacityMeta.bounds.top).toBeGreaterThanOrEqual(typedTypography.capacityMeta.shellBounds.top - 1)
    expect(typedTypography.capacityMeta.bounds.bottom).toBeLessThanOrEqual(typedTypography.capacityMeta.shellBounds.bottom + 1)
    expect(typedTypography.capacityMeta.bounds.right).toBeLessThanOrEqual(typedTypography.capacityMeta.viewport.width + 1)
    expect(typedTypography.capacityMeta.bounds.bottom).toBeLessThanOrEqual(typedTypography.capacityMeta.viewport.height + 1)

    const layout = await page.evaluate(() => {
      const browser = globalThis as unknown as BrowserGlobal
      const shell = browser.document.querySelector<LayoutElement>('.expanded-shell')
      if (!shell) throw new Error('No expanded overlay shell')
      const shellBounds = shell.getBoundingClientRect()
      const viewport = { width: browser.document.documentElement.clientWidth, height: browser.document.documentElement.clientHeight }
      const overflowingChildren = Array.from(shell.children)
        .filter((child) => {
          const bounds = child.getBoundingClientRect()
          return (
            bounds.left < shellBounds.left - 1 ||
            bounds.right > shellBounds.right + 1 ||
            bounds.top < shellBounds.top - 1 ||
            bounds.bottom > shellBounds.bottom + 1
          )
        })
        .map((child) => child.className)
      const overflowingCardChildren = Array.from(shell.querySelectorAll<LayoutElement>('.reset-card, .models-card'))
        .flatMap((card) => {
          const cardBounds = card.getBoundingClientRect()
          return Array.from(card.children)
            .filter((child) => {
              const bounds = child.getBoundingClientRect()
              return (
                bounds.left < cardBounds.left - 1 ||
                bounds.right > cardBounds.right + 1 ||
                bounds.top < cardBounds.top - 1 ||
                bounds.bottom > cardBounds.bottom + 1
              )
            })
            .map((child) => child.className)
        })
      const overflowingEyebrows = Array.from(shell.querySelectorAll<LayoutElement>('.eyebrow'))
        .filter((eyebrow) => {
          const bounds = eyebrow.getBoundingClientRect()
          return (
            bounds.left < shellBounds.left - 1 ||
            bounds.right > shellBounds.right + 1 ||
            bounds.top < shellBounds.top - 1 ||
            bounds.bottom > shellBounds.bottom + 1
          )
        })
        .map((eyebrow) => eyebrow.textContent ?? '')
      return {
        shell: { right: shellBounds.right, bottom: shellBounds.bottom },
        viewport,
        overflowingChildren,
        overflowingCardChildren,
        overflowingEyebrows
      }
    })
    const typedLayout = layout as LayoutSnapshot
    expect(typedLayout.shell.right).toBeLessThanOrEqual(typedLayout.viewport.width + 1)
    expect(typedLayout.shell.bottom).toBeLessThanOrEqual(typedLayout.viewport.height + 1)
    expect(typedLayout.overflowingChildren).toEqual([])
    expect(typedLayout.overflowingCardChildren).toEqual([])
    expect(typedLayout.overflowingEyebrows).toEqual([])

    const expanded = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('No overlay BrowserWindow')
      return window.getBounds()
    })
    expect(expanded.width).toBe(380)
    expect(expanded.height).toBe(800)
    await page.screenshot({ path: testInfo.outputPath('expanded-overlay.png') })

    await page.getByRole('button', { name: 'Collapse' }).click()
    await expect(page.getByRole('button', { name: 'Expand overlay' })).toBeVisible()
    await expect(page.locator('.quota-projection-copy')).toBeVisible()
    const collapsedAgain = await electronApp.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0]
      if (!window) throw new Error('No overlay BrowserWindow')
      return window.getBounds()
    })
    expect(collapsedAgain.width).toBe(340)
    expect(collapsedAgain.height).toBe(88)
  } finally {
    await electronApp.close()
  }
})
