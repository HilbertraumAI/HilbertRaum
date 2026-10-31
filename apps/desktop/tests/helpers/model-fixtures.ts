import { vi } from 'vitest'
import type { PreloadApi } from '../../src/preload'
import {
  DEFAULT_SETTINGS,
  type DownloadJob,
  type EngineDownloadJob,
  type EngineStatus,
  type ModelDownloadInfo,
  type ModelInfo,
  type OcrInstallStatus,
  type PolicyStatus
} from '../../src/shared/types'
import { stubApi } from './renderer'
import { appStatus, makePolicyStatus, runtimeStatus } from './status'

// Typed fixtures for the Models renderer suites and the pure library rules. `window` is touched only
// inside `stubModelsApi`, so a node-environment suite (unit/model-library) can import `modelInfo`.

/**
 * A complete `ModelInfo`: chat, llama_cpp, not on the drive, not recommended. `insufficientRam` and
 * `download` stay ABSENT: "absent means runnable" and "a manual entry has no download block" are rows.
 */
export function modelInfo(over: Partial<ModelInfo> = {}): ModelInfo {
  return {
    id: 'm',
    displayName: 'M',
    family: 'qwen3.8',
    role: 'chat',
    format: 'gguf',
    runtime: 'llama_cpp',
    license: 'apache-2.0',
    sizeOnDiskGb: 16,
    recommendedMinRamGb: 24,
    recommendedRamGb: 32,
    recommendedContextTokens: 8192,
    localPath: 'models/chat/m.gguf',
    state: 'missing',
    recommended: false,
    ...over
  }
}

export const OBTAINABLE_DOWNLOAD: ModelDownloadInfo = {
  url: 'https://example.test/weights.gguf',
  sizeBytes: 1000,
  licenseUrl: null,
  licenseApproved: true
}

/** #196: the pinned upstream file is gone; the row explains instead of offering a button. */
export const WITHDRAWN_DOWNLOAD: ModelDownloadInfo = {
  ...OBTAINABLE_DOWNLOAD,
  withdrawn: 'the publisher removed it'
}

export function downloadJob(over: Partial<DownloadJob> = {}): DownloadJob {
  return {
    jobId: 'j1',
    modelId: 'm',
    status: 'downloading',
    receivedBytes: 0,
    totalBytes: 100,
    unverified: false,
    error: null,
    ...over
  }
}

export function engineJob(over: Partial<EngineDownloadJob> = {}): EngineDownloadJob {
  return {
    jobId: 'e1',
    status: 'downloading',
    receivedBytes: 100_000_000,
    totalBytes: 400_000_000,
    unverified: false,
    binaryPath: null,
    error: null,
    ...over
  }
}

/** The chat engine is fetchable and not on the drive: the screen's "Install AI engine" banner. */
export const ENGINE_MISSING: EngineStatus = {
  installed: false,
  available: true,
  version: null,
  backend: null,
  missingFamilies: ['llama_cpp']
}

const ENGINE_INSTALLED: EngineStatus = {
  installed: true,
  available: true,
  version: null,
  backend: null,
  missingFamilies: []
}

/** A drive with no usable OCR source list: the AI Model screen's OCR row stays hidden. */
const NO_OCR_SOURCES: OcrInstallStatus = {
  available: false,
  languages: [],
  totalBytes: 0,
  sourceHost: null,
  license: 'Apache-2.0'
}

/** The policy allows downloads and the user's setting is on. */
export function downloadsAllowedPolicy(): PolicyStatus {
  return makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: true })
}

/**
 * Everything `ModelsScreen` calls at mount, idle: an empty catalog, no job to adopt, engine in place,
 * nothing running. So `assertNoUnexpectedApiCalls()` has teeth in a suite that uses this.
 */
export function stubModelsApi(over: Partial<PreloadApi> = {}): void {
  stubApi({
    listModels: vi.fn(async (): Promise<ModelInfo[]> => []),
    getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS })),
    getPolicy: vi.fn(async () => downloadsAllowedPolicy()),
    getAppStatus: vi.fn(async () => appStatus({ machineRamGb: 32 })),
    getEngineStatus: vi.fn(async () => ENGINE_INSTALLED),
    getRuntimeStatus: vi.fn(async () =>
      runtimeStatus({ running: false, modelId: null, port: null, healthy: false, message: '' })
    ),
    listDownloadJobs: vi.fn(async (): Promise<DownloadJob[]> => []),
    onModelVerifyProgress: vi.fn(() => () => {}),
    getOcrInstallStatus: vi.fn(async () => NO_OCR_SOURCES),
    onEngineProblemsChanged: vi.fn(() => () => {}),
    ...over
  })
}
