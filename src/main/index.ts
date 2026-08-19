import { app, ipcMain } from 'electron'
import type { DashboardSnapshot } from '../shared/contracts.js'
import { OverlayTray } from './tray.js'
import { UsageService } from './usage-service.js'
import { OverlayWindow } from './window-manager.js'

const isE2e = process.env.CODEX_OVERLAY_E2E === '1'
const e2eUserDataPath = process.env.CODEX_OVERLAY_E2E_USER_DATA
const usesIsolatedE2eProfile = isE2e && Boolean(e2eUserDataPath)
if (usesIsolatedE2eProfile && e2eUserDataPath) app.setPath('userData', e2eUserDataPath)

if (!usesIsolatedE2eProfile && !app.requestSingleInstanceLock()) {
  app.quit()
} else {
  let service: UsageService | null = null
  let overlay: OverlayWindow | null = null
  let tray: OverlayTray | null = null
  let cleanupStarted = false

  app.on('second-instance', () => overlay?.show())

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.local.codextokenoverlay')
    service = new UsageService(app.getPath('userData'))
    await service.start()
    applyLoginSetting(service.getSnapshot().settings.startAtLogin)

    overlay = new OverlayWindow(service.store)
    const browserWindow = overlay.create()
    tray = createTray(service, overlay)
    registerIpc(service, overlay, () => tray, applyLoginSetting)

    service.on('snapshot', (snapshot: DashboardSnapshot) => {
      if (!browserWindow.isDestroyed()) browserWindow.webContents.send('overlay:snapshot', snapshot)
      tray?.updateSettings(snapshot.settings)
      const used = snapshot.reset.usedPercent
      tray?.setToolTip(used === null ? 'Codex Token Overlay' : `Codex usage: ${used.toFixed(0)}%`)
    })

    app.on('activate', () => overlay?.show())
  })

  app.on('before-quit', (event) => {
    if (cleanupStarted) return
    event.preventDefault()
    cleanupStarted = true
    overlay?.prepareToClose()
    void (async () => {
      await service?.stop()
      tray?.destroy()
      tray = null
      app.quit()
    })()
  })
}

function createTray(service: UsageService, overlay: OverlayWindow): OverlayTray {
  return new OverlayTray(service.getSnapshot().settings, {
    toggleVisibility: () => overlay.toggleVisibility(),
    setAlwaysOnTop: (value) => {
      service.updateSettings({ alwaysOnTop: value })
      overlay.setAlwaysOnTop(value)
    },
    setStartAtLogin: (value) => {
      service.updateSettings({ startAtLogin: value })
      applyLoginSetting(value)
    },
    refresh: () => void service.refresh(),
    quit: () => app.quit()
  })
}

function registerIpc(
  service: UsageService,
  overlay: OverlayWindow,
  getTray: () => OverlayTray | null,
  setLogin: (value: boolean) => void
): void {
  ipcMain.handle('overlay:get-snapshot', () => service.getSnapshot())
  ipcMain.handle('overlay:refresh', () => service.refresh())
  ipcMain.handle('overlay:set-expanded', (_event, expanded: boolean) => {
    const snapshot = service.updateSettings({ expanded: Boolean(expanded) })
    overlay.setExpanded(snapshot.settings.expanded)
    return snapshot
  })
  ipcMain.handle('overlay:set-always-on-top', (_event, value: boolean) => {
    const snapshot = service.updateSettings({ alwaysOnTop: Boolean(value) })
    overlay.setAlwaysOnTop(snapshot.settings.alwaysOnTop)
    getTray()?.updateSettings(snapshot.settings)
    return snapshot
  })
  ipcMain.handle('overlay:set-start-at-login', (_event, value: boolean) => {
    const snapshot = service.updateSettings({ startAtLogin: Boolean(value) })
    setLogin(snapshot.settings.startAtLogin)
    getTray()?.updateSettings(snapshot.settings)
    return snapshot
  })
  ipcMain.handle('overlay:hide', () => overlay.hide())
  ipcMain.handle('overlay:quit', () => app.quit())
}

function applyLoginSetting(openAtLogin: boolean): void {
  if (!app.isPackaged || process.env.CODEX_OVERLAY_E2E === '1') return
  app.setLoginItemSettings({ openAtLogin })
}
