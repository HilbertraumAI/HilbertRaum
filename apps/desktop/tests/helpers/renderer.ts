import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'

// Install a fake `window.api` (the preload bridge) for renderer component tests. Only the
// methods a test needs are supplied; the rest are auto-stubbed as `vi.fn()` so an
// accidental call is observable rather than a crash. Import is TYPE-ONLY (the real preload
// module calls contextBridge at load time, which has no meaning in jsdom).
export function stubApi(overrides: Partial<PreloadApi>): void {
  const fallback = new Proxy(overrides, {
    get(target, prop: string) {
      if (prop in target) return (target as Record<string, unknown>)[prop]
      return vi.fn()
    }
  })
  ;(window as unknown as { api: PreloadApi }).api = fallback as unknown as PreloadApi
}
