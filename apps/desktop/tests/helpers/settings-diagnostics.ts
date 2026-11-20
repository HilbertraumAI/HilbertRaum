import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import { ENGINE_INSTALLED } from './model-fixtures'

// What the Settings Diagnostics tab and its siblings (the engine line, the Acceleration line) read from the
// engine that its suites used to leave unmocked (#832): the engine status, calm (installed, no version
// string, so the report carries no engine versions) and the engine-problem subscription. `over` spreads
// last. A suite still stubs the rest of the tab (`getAppStatus`, `getDriveStatus`, `getPerformance`, …).

/** `getEngineStatus` answers an installed engine; `onEngineProblemsChanged` returns a no-op unsubscribe. */
export function diagnosticsEngineStubs(over: Partial<PreloadApi> = {}): Partial<PreloadApi> {
  return {
    getEngineStatus: vi.fn<PreloadApi['getEngineStatus']>(async () => ENGINE_INSTALLED),
    onEngineProblemsChanged: vi.fn<PreloadApi['onEngineProblemsChanged']>(() => () => {}),
    ...over
  }
}
