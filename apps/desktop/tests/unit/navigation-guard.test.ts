import { describe, it, expect, vi } from 'vitest'
import { installNavigationGuard } from '../../src/main/services/navigation-guard'

// SEC-3 (backend-audit-2026-06-27): in-app navigation must be blocked on BOTH `will-navigate`
// AND `will-redirect`. A server-side (3xx) or <meta refresh> redirect reaches a remote origin
// via `will-redirect` WITHOUT firing `will-navigate`, so guarding only `will-navigate` (the
// prior state) left the redirect path open. The installer attaches one deny-by-default predicate
// to both events.

type Listener = (...args: unknown[]) => void

/** A fake WebContents that records the listener registered per event, so a test can fire either. */
function fakeWebContents(): {
  target: { on(event: string, listener: Listener): unknown }
  fire(event: string, url: string): { prevented: boolean }
  registered: string[]
} {
  const handlers = new Map<string, Listener>()
  const registered: string[] = []
  return {
    target: {
      on(event, listener) {
        registered.push(event)
        handlers.set(event, listener)
        return undefined
      }
    },
    fire(event, url) {
      const listener = handlers.get(event)
      if (!listener) throw new Error(`no listener for ${event}`)
      const preventDefault = vi.fn()
      listener({ preventDefault }, url)
      return { prevented: preventDefault.mock.calls.length > 0 }
    },
    registered
  }
}

describe('installNavigationGuard', () => {
  it('registers BOTH will-navigate and will-redirect', () => {
    const wc = fakeWebContents()
    installNavigationGuard(wc.target, () => true)
    expect(wc.registered).toEqual(['will-navigate', 'will-redirect'])
  })

  it('blocks a remote-origin will-redirect (the SEC-3 case) on the main-window predicate', () => {
    const wc = fakeWebContents()
    // The prod main-window predicate: only the bundled file:// shell may navigate.
    installNavigationGuard(wc.target, (url) => url.startsWith('file://'))

    // A server/meta redirect to a remote origin → prevented on will-redirect.
    expect(wc.fire('will-redirect', 'https://evil.example/phish').prevented).toBe(true)
    // The same predicate also blocks a remote will-navigate…
    expect(wc.fire('will-navigate', 'https://evil.example/phish').prevented).toBe(true)
    // …and ALLOWS the app's own shell on both events.
    expect(wc.fire('will-redirect', 'file:///app/renderer/index.html').prevented).toBe(false)
    expect(wc.fire('will-navigate', 'file:///app/renderer/index.html').prevented).toBe(false)
  })

  it('a deny-all worker window (OCR rasterizer) blocks every navigation/redirect', () => {
    const wc = fakeWebContents()
    installNavigationGuard(wc.target, () => false)
    expect(wc.fire('will-navigate', 'file:///ocr.html').prevented).toBe(true)
    expect(wc.fire('will-redirect', 'https://evil.example/').prevented).toBe(true)
  })
})
