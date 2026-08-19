import { Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import type { OverlaySettings } from '../shared/contracts.js'

export interface TrayActions {
  toggleVisibility: () => void
  setAlwaysOnTop: (value: boolean) => void
  setStartAtLogin: (value: boolean) => void
  refresh: () => void
  quit: () => void
}

export class OverlayTray {
  private tray: Tray

  constructor(
    private settings: OverlaySettings,
    private readonly actions: TrayActions
  ) {
    this.tray = new Tray(createTrayIcon())
    this.tray.setToolTip('Codex Token Overlay')
    this.tray.on('click', actions.toggleVisibility)
    this.rebuildMenu()
  }

  updateSettings(settings: OverlaySettings): void {
    this.settings = settings
    this.rebuildMenu()
  }

  setToolTip(text: string): void {
    this.tray.setToolTip(text)
  }

  destroy(): void {
    this.tray.destroy()
  }

  private rebuildMenu(): void {
    const template: MenuItemConstructorOptions[] = [
      { label: 'Show / Hide', click: this.actions.toggleVisibility },
      { type: 'separator' },
      {
        label: 'Always on top',
        type: 'checkbox',
        checked: this.settings.alwaysOnTop,
        click: (item) => this.actions.setAlwaysOnTop(item.checked)
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: this.settings.startAtLogin,
        click: (item) => this.actions.setStartAtLogin(item.checked)
      },
      { label: 'Refresh now', click: this.actions.refresh },
      { type: 'separator' },
      { label: 'Quit', click: this.actions.quit }
    ]
    this.tray.setContextMenu(Menu.buildFromTemplate(template))
  }
}

function createTrayIcon() {
  const width = 16
  const height = 16
  const pixels = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = x - 7.5
      const dy = y - 7.5
      const distance = Math.sqrt(dx * dx + dy * dy)
      const onRing = distance >= 4.4 && distance <= 6.8
      const onCore = distance < 2.2
      if (!onRing && !onCore) continue
      const offset = (y * width + x) * 4
      pixels[offset] = 255
      pixels[offset + 1] = onCore ? 210 : 145
      pixels[offset + 2] = onCore ? 110 : 118
      pixels[offset + 3] = 255
    }
  }
  return nativeImage.createFromBuffer(pixels, { width, height, scaleFactor: 1 })
}
