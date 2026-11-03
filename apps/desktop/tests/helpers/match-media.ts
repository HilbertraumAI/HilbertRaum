import { act } from '@testing-library/react'

// A firable `window.matchMedia` for jsdom, which has none. Theme, ReviewGateA11y and ReviewScreen each carried
// a copy; ChatRestructure needed a fourth (#743). Every query gets the same answer: each screen under test asks
// one query (the OS dark theme, the review drawer's 980 px, the chat history column's 1150 px). Install it
// before the render, and call `removeMatchMedia()` in an afterEach so other tests keep jsdom's
// no-matchMedia default (every production caller treats that as "wide" / "light").

export interface MatchMediaFake {
  /** Change the answer and tell every `change` listener, as a window resize across the breakpoint does. Runs
   *  inside `act`, so a screen's state update lands before the next assertion. */
  set(matches: boolean): void
}

/** Install the fake, answering `matches` until `set` changes it. */
export function fakeMatchMedia(matches: boolean): MatchMediaFake {
  let current = matches
  const listeners = new Map<(event: MediaQueryListEvent) => void, string>()
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      get matches() {
        return current
      },
      media: query,
      onchange: null,
      addEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => listeners.set(fn, query),
      removeEventListener: (_type: string, fn: (event: MediaQueryListEvent) => void) => listeners.delete(fn),
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false
    })
  })
  return {
    set(next) {
      act(() => {
        current = next
        for (const [fn, media] of [...listeners]) fn({ matches: next, media } as MediaQueryListEvent)
      })
    }
  }
}

/** Remove the fake (jsdom has no `matchMedia` of its own). */
export function removeMatchMedia(): void {
  delete (window as { matchMedia?: unknown }).matchMedia
}
