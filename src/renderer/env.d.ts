/// <reference types="vite/client" />

import type { OverlayBridge } from '../shared/contracts'

declare global {
  interface Window {
    codexOverlay: OverlayBridge
  }
}

export {}
