import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'

// Install a fake `window.api` (the preload bridge) for renderer component tests. Only the
// methods a test needs are supplied; the rest are auto-stubbed so an accidental call is
// observable rather than a crash. Import is TYPE-ONLY (the real preload module calls
// contextBridge at load time, which has no meaning in jsdom).
//
// TS-4 (full-audit 2026-07-10): the auto-stub used to mint a FRESH `vi.fn()` on every
// property access, so an unmocked `window.api.*` call rendered as success-with-`undefined`
// and a repeat-lookup spy assertion (`expect(window.api.x).not.toHaveBeenCalled()`) passed
// vacuously against a spy nobody had ever held. Now each accessed name gets ONE cached
// spy (stable identity across lookups), every call to an unmocked method warns once per
// name, and `assertNoUnexpectedApiCalls()` fails a test that made one.
//
// #832: the check is the DEFAULT for every renderer suite. `tests/setup.ts` registers an `afterEach` that
// runs it, after the file's own `afterEach(cleanup)` (hooks run in reverse registration order), so a
// screen's unmount calls are covered and a new suite is safe without remembering to opt in. A suite may
// still call it itself (a better error site; a throw consumes the record, so the shared hook stays quiet).
// A suite that calls unmocked methods ON PURPOSE (`stubApi.test.ts`) ends each row with
// `forgetUnexpectedApiCalls()`.

/** Auto-stubs handed out for names NOT supplied to `stubApi` — one stable spy per name. */
let autoStubs = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
/** Unmocked names that were actually CALLED (not merely looked up) since the last stubApi(). */
let unexpectedCalls = new Map<string, number>()
let warnedNames = new Set<string>()

export function stubApi(overrides: Partial<PreloadApi>): void {
  // Fresh bookkeeping per install (tests call stubApi in their setup, so this is per-test).
  autoStubs = new Map()
  unexpectedCalls = new Map()
  warnedNames = new Set()
  const fallback = new Proxy(overrides, {
    get(target, prop) {
      if (prop in target) return (target as Record<PropertyKey, unknown>)[prop]
      let stub = autoStubs.get(prop)
      if (!stub) {
        const name = String(prop)
        stub = vi.fn(() => {
          unexpectedCalls.set(name, (unexpectedCalls.get(name) ?? 0) + 1)
          if (!warnedNames.has(name)) {
            warnedNames.add(name)
            console.warn(
              `stubApi: unmocked window.api.${name}() was called — it resolves to undefined. ` +
                `Supply it in stubApi({ … }) or gate with assertNoUnexpectedApiCalls().`
            )
          }
          return undefined
        })
        autoStubs.set(prop, stub)
      }
      return stub
    }
  })
  ;(window as unknown as { api: PreloadApi }).api = fallback as unknown as PreloadApi
}

/**
 * Teeth: fail if any auto-stubbed (i.e. not supplied to `stubApi`) method was
 * CALLED since the last `stubApi()` install. Names that were only looked up but never
 * invoked don't count — existence probes are harmless.
 */
export function assertNoUnexpectedApiCalls(): void {
  if (unexpectedCalls.size === 0) return
  const list = [...unexpectedCalls.entries()]
    .map(([name, count]) => `${name} (${count} call${count === 1 ? '' : 's'})`)
    .join(', ')
  unexpectedCalls = new Map() // reported once: a later check (the shared hook, the next row) starts clean
  throw new Error(
    `Unmocked window.api methods were called: ${list}. Supply them in stubApi({ … }).`
  )
}

/** Drop the record of unmocked calls: only for a suite that makes them on purpose (`stubApi.test.ts`). */
export function forgetUnexpectedApiCalls(): void {
  unexpectedCalls = new Map()
}
