// Vitest setup, applied to every test file. Registers @testing-library/jest-dom matchers
// (toBeInTheDocument, toBeDisabled, …). Harmless in node-env tests — it only augments
// `expect`; jsdom is opted into per-file by the renderer tests' `@vitest-environment` docblock.
import '@testing-library/jest-dom/vitest'

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
    hasPointerCapture?: () => boolean
    setPointerCapture?: () => void
    releasePointerCapture?: () => void
  }
  el.scrollIntoView ??= () => {}
  el.hasPointerCapture ??= () => false
  el.setPointerCapture ??= () => {}
  el.releasePointerCapture ??= () => {}
}
