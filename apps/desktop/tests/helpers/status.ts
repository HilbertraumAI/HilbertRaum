import type { AppStatus, DriveStatus } from '../../src/shared/types'

// T-2 (frontend audit 2026-08-09, #147): shared TYPED fixtures for the two status shapes the
// renderer suites used to stub as partial `{} as never` bags — a field rename now reddens
// typecheck here once instead of drifting silently in a dozen files. Override per test.

/** A complete AppStatus with calm defaults; override the fields a test cares about. */
export function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return {
    appName: 'HilbertRaum',
    appVersion: '0.0.0-test',
    offlineMode: true,
    networkAllowed: false,
    activeModelId: null,
    hardwareProfile: 'UNKNOWN',
    workspaceMode: 'plaintext_dev',
    workspaceReady: true,
    machineRamGb: 32,
    dictationAvailable: false,
    ocrAvailable: false,
    translationAvailable: false,
    ...over
  } as AppStatus
}

/** A complete DriveStatus for a plain dev checkout; override per test. */
export function driveStatus(over: Partial<DriveStatus> = {}): DriveStatus {
  return {
    rootPath: 'X:/drive',
    workspacePath: 'X:/drive/workspace',
    modelsPath: 'X:/drive/models',
    logsPath: 'X:/drive/logs',
    isPreparedDrive: false,
    writable: true,
    freeBytes: 10_000_000_000,
    imagesBytes: 0,
    platform: 'win32',
    arch: 'x64',
    ...over
  } as DriveStatus
}
