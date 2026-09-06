import type {
  AppStatus,
  DriveStatus,
  ModelsPolicy,
  NetworkPolicy,
  PerformanceSnapshot,
  PolicyStatus,
  PrivacyPolicy,
  WorkspacePolicy
} from '../../src/shared/types'

// T-2 (frontend audit 2026-08-09, #147): shared TYPED fixtures for the status shapes the
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

/**
 * A complete `PerformanceSnapshot` for a machine that has never been checked — nothing
 * measured, nothing observed, no eligible graphics device. Sibling of the two above.
 *
 * Its reason to exist outside the Performance screen's own richer builder: since #327 the
 * Diagnostics "Acceleration" line reads its device from `currentGpu` here, not from
 * `settings.gpuProbe`, so every suite that renders the Diagnostics tab needs a typed
 * `performance:get` reply. Override `currentGpu` to name a card.
 */
export function performanceSnapshot(over: Partial<PerformanceSnapshot> = {}): PerformanceSnapshot {
  return {
    current: null,
    currentMachine: true,
    otherMachines: [],
    currentGpu: null,
    running: false,
    placement: {
      memoryClass: 'cpu',
      ramMb: null,
      vramMb: null,
      model: null,
      recommendedContextTokens: null,
      observed: null,
      observedMismatch: null,
      verdict: {
        kind: 'unknown',
        needMb: null,
        estimated: true,
        budgetMb: null,
        freeAtStartMb: null,
        workingMb: null,
        spillMb: null,
        gpuLayers: null,
        totalLayers: null
      },
      models: [],
      totals: { ramAllMb: null, bothOnCard: false }
    },
    observed: { lastAnswer: null, lastModelLoad: null, lastChecksum: null },
    ...over
  }
}

/**
 * A complete `PolicyStatus` with the derived network flags computed the way
 * `resolveNetwork`/`buildPolicyStatus` compute them — so a fixture can state the two
 * facts that matter (what the policy allows, what the user toggled) instead of hand-
 * spelling four flags that can silently contradict each other. Sibling of `appStatus`
 * and `driveStatus` above; the `makePolicyStatus` name is the one the P2 review item
 * used. Override any derived flag explicitly to test an impossible/legacy combination.
 */
export function makePolicyStatus(over: PolicyStatusOverrides = {}): PolicyStatus {
  const network: NetworkPolicy = {
    allowModelDownloads: false,
    allowUpdateChecks: false,
    allowTelemetry: false,
    allowLocalApi: true,
    ...over.network
  }
  const policy: PrivacyPolicy = {
    network,
    workspace: { encryptionRequired: false, allowPlaintextDevMode: true, ...over.workspace },
    models: {
      allowUnverifiedModels: true,
      requireManifest: true,
      requireSha256Match: false,
      ...over.models
    }
  }
  const allowNetworkSetting = over.allowNetworkSetting ?? false
  const networkAllowedByPolicy =
    over.networkAllowedByPolicy ?? (network.allowModelDownloads || network.allowUpdateChecks)
  const networkAllowed = over.networkAllowed ?? (networkAllowedByPolicy && allowNetworkSetting)
  return {
    policy,
    policyFilePresent: over.policyFilePresent ?? true,
    driveFilePresent: over.driveFilePresent ?? true,
    allowNetworkSetting,
    networkAllowedByPolicy,
    networkAllowed,
    offlineMode: over.offlineMode ?? !networkAllowed,
    telemetryAllowed: false
  }
}

export interface PolicyStatusOverrides {
  network?: Partial<NetworkPolicy>
  workspace?: Partial<WorkspacePolicy>
  models?: Partial<ModelsPolicy>
  allowNetworkSetting?: boolean
  policyFilePresent?: boolean
  driveFilePresent?: boolean
  /** Escape hatches for combinations the derivation would not produce. */
  networkAllowedByPolicy?: boolean
  networkAllowed?: boolean
  offlineMode?: boolean
}
