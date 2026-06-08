/// <reference types="vite/client" />
import type { PreloadApi } from '../preload/index'

declare global {
  interface Window {
    api: PreloadApi
  }
}

export {}
