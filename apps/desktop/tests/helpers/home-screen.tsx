import { Profiler, type ProfilerOnRenderCallback } from 'react'
import { render } from '@testing-library/react'
import { vi, type Mock } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import { I18nProvider } from '../../src/renderer/i18n'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import type { PreflightResult } from '../../src/shared/types'
import { stubApi } from './renderer'
import { appStatus, runtimeStatus } from './status'

// Home with every mount-time bridge call supplied, calm by default: a selected model running, no
// documents, no packs, a healthy drive, nothing moved. So `assertNoUnexpectedApiCalls()` has teeth.

const HEALTHY_PREFLIGHT: PreflightResult = {
  rootPath: 'X:/drive',
  writable: true,
  freeBytes: null,
  slowDriveWarning: null,
  problems: []
}

export function stubHomeApi(over: Partial<PreloadApi> = {}): { firePerformanceChanged(): void } {
  let subscriber: (() => void) | null = null
  stubApi({
    getAppStatus: vi.fn(async () => appStatus({ activeModelId: 'qwen3-chat' })),
    listDocuments: vi.fn(async () => []),
    listKnowledgePacks: vi.fn(async () => []),
    runPreflight: vi.fn(async () => HEALTHY_PREFLIGHT),
    getRuntimeStatus: vi.fn(async () => runtimeStatus({ modelId: 'qwen3-chat' })),
    getMovedDriveNotice: vi.fn(async () => null),
    onPerformanceChanged: vi.fn((cb: () => void) => {
      subscriber = cb
      return () => {
        subscriber = null
      }
    }),
    onEngineProblemsChanged: vi.fn(() => () => {}),
    ...over
  })
  return { firePerformanceChanged: () => subscriber?.() }
}

/**
 * `onRender` counts commits of the screen's subtree. It sees the screen's own state updates, which
 * a memo wrapper (`render-counter.ts`) cannot: the poll's `setRuntime` is one of those.
 */
export function renderHome(
  opts: { onRender?: ProfilerOnRenderCallback } = {}
): { onNavigate: Mock<(screen: string) => void> } {
  const onNavigate = vi.fn<(screen: string) => void>()
  render(
    <I18nProvider>
      <Profiler id="home" onRender={opts.onRender ?? (() => {})}>
        <HomeScreen onNavigate={onNavigate} />
      </Profiler>
    </I18nProvider>
  )
  return { onNavigate }
}
