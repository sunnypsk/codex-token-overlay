import { contextBridge, ipcRenderer } from 'electron'
import type { DashboardSnapshot, OverlayBridge } from '../shared/contracts.js'

const bridge: OverlayBridge = {
  getSnapshot: () => ipcRenderer.invoke('overlay:get-snapshot') as Promise<DashboardSnapshot>,
  refresh: () => ipcRenderer.invoke('overlay:refresh') as Promise<DashboardSnapshot>,
  setExpanded: (expanded) =>
    ipcRenderer.invoke('overlay:set-expanded', Boolean(expanded)) as Promise<DashboardSnapshot>,
  setAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('overlay:set-always-on-top', Boolean(alwaysOnTop)) as Promise<DashboardSnapshot>,
  setStartAtLogin: (startAtLogin) =>
    ipcRenderer.invoke('overlay:set-start-at-login', Boolean(startAtLogin)) as Promise<DashboardSnapshot>,
  hide: () => ipcRenderer.invoke('overlay:hide') as Promise<void>,
  quit: () => ipcRenderer.invoke('overlay:quit') as Promise<void>,
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: DashboardSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on('overlay:snapshot', handler)
    return () => ipcRenderer.removeListener('overlay:snapshot', handler)
  }
}

contextBridge.exposeInMainWorld('codexOverlay', bridge)
