import { contextBridge, ipcRenderer } from 'electron'
import type { QuotaSnapshot, OverlayBridge } from '../shared/contracts.js'

const bridge: OverlayBridge = {
  getSnapshot: () => ipcRenderer.invoke('overlay:get-snapshot') as Promise<QuotaSnapshot>,
  refresh: () => ipcRenderer.invoke('overlay:refresh') as Promise<QuotaSnapshot>,
  setExpanded: (expanded) =>
    ipcRenderer.invoke('overlay:set-expanded', Boolean(expanded)) as Promise<QuotaSnapshot>,
  setAlwaysOnTop: (alwaysOnTop) =>
    ipcRenderer.invoke('overlay:set-always-on-top', Boolean(alwaysOnTop)) as Promise<QuotaSnapshot>,
  setStartAtLogin: (startAtLogin) =>
    ipcRenderer.invoke('overlay:set-start-at-login', Boolean(startAtLogin)) as Promise<QuotaSnapshot>,
  hide: () => ipcRenderer.invoke('overlay:hide') as Promise<void>,
  quit: () => ipcRenderer.invoke('overlay:quit') as Promise<void>,
  onSnapshot: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: QuotaSnapshot): void => {
      listener(snapshot)
    }
    ipcRenderer.on('overlay:snapshot', handler)
    return () => ipcRenderer.removeListener('overlay:snapshot', handler)
  }
}

contextBridge.exposeInMainWorld('codexOverlay', bridge)
