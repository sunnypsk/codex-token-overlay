import { BrowserWindow, screen, type Rectangle } from 'electron'
import { join } from 'node:path'
import type { QuotaStateStore } from './quota-state.js'

const COLLAPSED_SIZE = { width: 340, height: 88 }
const EXPANDED_SIZE = { width: 380, height: 300 }
const SCREEN_MARGIN = 20

export class OverlayWindow {
  private window: BrowserWindow | null = null
  private allowClose = false
  private moveSaveTimer: NodeJS.Timeout | null = null

  constructor(private readonly store: QuotaStateStore) {}

  create(): BrowserWindow {
    const state = this.store.get()
    const size = state.settings.expanded ? EXPANDED_SIZE : COLLAPSED_SIZE
    const position = resolvePosition(state.window, size)
    const preloadPath = join(__dirname, '../preload/index.js')

    this.window = new BrowserWindow({
      ...size,
      ...position,
      frame: false,
      transparent: false,
      backgroundColor: '#10131a',
      backgroundMaterial: 'acrylic',
      show: false,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: state.settings.alwaysOnTop,
      hasShadow: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false
      }
    })
    this.window.setAlwaysOnTop(state.settings.alwaysOnTop, 'floating')
    this.window.setMenuBarVisibility(false)

    this.window.webContents.on('preload-error', (_event, path, error) => {
      console.error(`Preload failed at ${path}:`, error)
    })
    this.window.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.error(`Renderer failed to load ${url} (${code}): ${description}`)
    })
    this.window.webContents.on('render-process-gone', (_event, details) => {
      console.error('Renderer process exited:', details)
    })

    this.window.on('close', (event) => {
      if (!this.allowClose) {
        event.preventDefault()
        this.window?.hide()
      }
    })
    this.window.on('move', () => this.schedulePositionSave())
    this.window.on('closed', () => {
      this.window = null
    })

    if (process.env.ELECTRON_RENDERER_URL) {
      void this.window.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
      void this.window.loadFile(join(__dirname, '../renderer/index.html'))
    }
    this.window.once('ready-to-show', () => this.window?.showInactive())
    return this.window
  }

  get(): BrowserWindow | null {
    return this.window
  }

  show(): void {
    if (!this.window) return
    this.window.show()
    this.window.focus()
  }

  hide(): void {
    this.window?.hide()
  }

  toggleVisibility(): void {
    if (!this.window) return
    if (this.window.isVisible()) this.window.hide()
    else this.show()
  }

  setExpanded(expanded: boolean): void {
    if (!this.window) return
    const size = expanded ? EXPANDED_SIZE : COLLAPSED_SIZE
    const currentBounds = this.window.getBounds()
    this.window.setBounds(clampBounds({ ...currentBounds, ...size }), true)
  }

  setAlwaysOnTop(alwaysOnTop: boolean): void {
    this.window?.setAlwaysOnTop(alwaysOnTop, 'floating')
  }

  prepareToClose(): void {
    this.allowClose = true
    if (this.moveSaveTimer) clearTimeout(this.moveSaveTimer)
    this.moveSaveTimer = null
    this.savePosition()
  }

  private schedulePositionSave(): void {
    if (this.moveSaveTimer) clearTimeout(this.moveSaveTimer)
    this.moveSaveTimer = setTimeout(() => {
      this.moveSaveTimer = null
      this.savePosition()
    }, 300)
  }

  private savePosition(): void {
    if (!this.window || this.window.isDestroyed()) return
    const { x, y } = this.window.getBounds()
    this.store.update((state) => {
      state.window = { x, y }
    }, true)
  }
}

function resolvePosition(
  stored: { x: number | null; y: number | null },
  size: { width: number; height: number }
): { x: number; y: number } {
  if (stored.x !== null && stored.y !== null) {
    const candidate = { x: stored.x, y: stored.y, ...size }
    if (screen.getAllDisplays().some((display) => intersects(candidate, display.workArea))) {
      const clamped = clampBounds(candidate)
      return { x: clamped.x, y: clamped.y }
    }
  }
  const workArea = screen.getPrimaryDisplay().workArea
  return {
    x: workArea.x + workArea.width - size.width - SCREEN_MARGIN,
    y: workArea.y + SCREEN_MARGIN
  }
}

function clampBounds(bounds: Rectangle): Rectangle {
  const display = screen.getDisplayMatching(bounds)
  const area = display.workArea
  return {
    width: bounds.width,
    height: bounds.height,
    x: Math.min(Math.max(bounds.x, area.x), area.x + Math.max(0, area.width - bounds.width)),
    y: Math.min(Math.max(bounds.y, area.y), area.y + Math.max(0, area.height - bounds.height))
  }
}

function intersects(left: Rectangle, right: Rectangle): boolean {
  return !(
    left.x + left.width <= right.x ||
    right.x + right.width <= left.x ||
    left.y + left.height <= right.y ||
    right.y + right.height <= left.y
  )
}

export const overlayWindowConstants = {
  COLLAPSED_SIZE,
  EXPANDED_SIZE,
  SCREEN_MARGIN
}
