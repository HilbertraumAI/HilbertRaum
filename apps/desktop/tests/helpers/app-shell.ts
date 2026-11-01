import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import { DEFAULT_SETTINGS, type WorkspaceStateInfo } from '../../src/shared/types'
import { STOPPED_RUNTIME, appStatus, makePolicyStatus, preflightResult } from './status'

// Bridge stubs for the suites that render Home or the whole App, calm by default. Imports no renderer
// module, so a suite that mocks a screen, or proves one loads lazily, can use it. Home's and Models'
// reads carry no tolerance for a missing channel: the preload ships inside the app, so a stub that
// leaves one out fails at the call instead of reading as "nothing to say".

/** The dev workspace a plain App render unlocks into. */
export const UNLOCKED_DEV_WORKSPACE: WorkspaceStateInfo = {
  state: 'unlocked',
  mode: 'plaintext_dev',
  plaintextAllowed: true,
  encryptionRequired: false
}

/** What Home reads at mount: no documents, no packs, a healthy drive, nothing moved, no model running. */
export function homeReadStubs(): Partial<PreloadApi> {
  return {
    getAppStatus: vi.fn(async () => appStatus()),
    getRuntimeStatus: vi.fn(async () => STOPPED_RUNTIME),
    listDocuments: vi.fn(async () => []),
    listKnowledgePacks: vi.fn(async () => []),
    runPreflight: vi.fn(async () => preflightResult()),
    getMovedDriveNotice: vi.fn(async () => null),
    onPerformanceChanged: vi.fn(() => () => {}),
    onEngineProblemsChanged: vi.fn(() => () => {})
  }
}

/** The App shell's boot reads plus Home's, for `stubApi`: an unlocked dev workspace, offline, default settings. */
export function appShellStubs(over: Partial<PreloadApi> = {}): Partial<PreloadApi> {
  return {
    ...homeReadStubs(),
    getWorkspaceState: vi.fn(async () => UNLOCKED_DEV_WORKSPACE),
    getPolicy: vi.fn(async () => makePolicyStatus({ policyFilePresent: false, driveFilePresent: false })),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    onRuntimeNotice: vi.fn(() => () => {}),
    ...over
  }
}
