// Vitest setup, applied to every test file. Registers @testing-library/jest-dom matchers
// (toBeInTheDocument, toBeDisabled, …). Harmless in node-env tests — it only augments
// `expect`; jsdom is opted into per-file by the renderer tests' `@vitest-environment` docblock.
import '@testing-library/jest-dom/vitest'
import { hangBudgetMs } from './helpers/hang-budget'

// jsdom gaps that Radix's positioned primitives (DropdownMenu/Popover via floating-ui)
// rely on. Guarded so the node-env service tests are untouched.
if (typeof window !== 'undefined') {
  if (typeof window.ResizeObserver === 'undefined') {
    window.ResizeObserver = class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    } as unknown as typeof ResizeObserver
  }
  const el = window.Element.prototype as Element & {
    scrollIntoView?: () => void
    scrollTo?: () => void
    hasPointerCapture?: () => boolean
    setPointerCapture?: () => void
    releasePointerCapture?: () => void
  }
  el.scrollIntoView ??= () => {}
  // The chat Transcript pins itself to the newest message with `element.scrollTo`, which jsdom
  // lacks. This no-op replaced the local `beforeAll` stubs ~50 renderer suites carried (chat-ui
  // campaign). A test that ASSERTS scrolling installs its own spy over it, e.g.
  // `vi.spyOn(Element.prototype, 'scrollTo')` or an `HTMLElement.prototype` override.
  el.scrollTo ??= () => {}
  el.hasPointerCapture ??= () => false
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
  // testing-library's `waitFor` / `find*By*` give up after 1 s by default and never follow `testTimeout`
  // (#915). Raise the default once, so every bare wait gets the CI-aware hang budget; a literal
  // `timeout` on a wait is forbidden by repo-hygiene. A dynamic import, so a node-env file never
  // loads the DOM library; RTL's own `configure` merges and keeps this value.
  const { configure } = await import('@testing-library/dom')
  configure({ asyncUtilTimeout: hangBudgetMs(5_000) })
}
