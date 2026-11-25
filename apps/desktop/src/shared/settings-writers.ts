import type { AppSettings } from './types'

// Who may write each settings key through `settings:update` (#868). The renderer is the untrusted
// side of the IPC boundary (security-model.md, "Least-privilege hardening"): a key that only the main
// process writes must not be settable by a renderer bug or a compromised renderer, even with a
// well-formed value. The write gate (`services/settings.ts`) checks a value's SHAPE; this table
// decides whether the renderer may write the key at all.
//
// `satisfies Record<keyof AppSettings, …>` on the object literal fails typecheck on a missing key and
// on an extra one, so a new settings key cannot ship until someone decides who writes it.
//
// - `renderer`: a screen writes it (Settings, the Local API card, Skills, Chat, AI Model), or it is a
//   retrieval tuning key no screen writes but a maintainer may set in the running app (`contextTokens`
//   and the four `rag*` numbers; the write gate bounds them).
// - `main`: only main-process code writes it, through `updateSettings(db, …)` directly: the
//   workspace's mode (WorkspaceController), the active model ids (`models:select` / `runtime:use`,
//   which check that the model exists and has the role), the benchmark, placement and GPU records,
//   and the checksum cache (a forged entry would let a weights file skip its re-hash).
export type SettingsWriter = 'renderer' | 'main'

export const SETTINGS_WRITERS = {
  allowNetwork: 'renderer',
  workspaceMode: 'main',
  activeModelId: 'main',
  activeEmbeddingModelId: 'main',
  developerMode: 'renderer',
  contextTokens: 'renderer',
  contextTokensOverride: 'renderer',
  ragTopKInitial: 'renderer',
  ragTopKFinal: 'renderer',
  ragMaxContextTokens: 'renderer',
  ragMinSimilarity: 'renderer',
  ragRerankWideScope: 'renderer',
  lastBenchmark: 'main',
  benchmarkHistory: 'main',
  modelPlacements: 'main',
  gpuMode: 'renderer',
  gpuAutoDisabled: 'main',
  gpuAutoDisabledEngine: 'main',
  gpuLastError: 'main',
  gpuProbe: 'main',
  autoStartActiveModel: 'renderer',
  checksumCache: 'main',
  theme: 'renderer',
  uiLanguage: 'renderer',
  skillsAutoFireEnabled: 'renderer',
  skillInfoSeen: 'renderer',
  chatCompactionEnabled: 'renderer',
  localApiEnabled: 'renderer',
  localApiPort: 'renderer',
  localApiTokenRequired: 'renderer'
} as const satisfies Record<keyof AppSettings, SettingsWriter>

type Writers = typeof SETTINGS_WRITERS

/** The settings keys a renderer patch may carry. */
export type RendererSettingsKey = { [K in keyof Writers]: Writers[K] extends 'renderer' ? K : never }[keyof Writers]

/** The settings keys only the main process writes; `settings:update` drops them from a patch. */
export type MainSettingsKey = Exclude<keyof AppSettings, RendererSettingsKey>

/** What `window.api.updateSettings` accepts: a patch of renderer-owned keys only. */
export type RendererSettingsPatch = Partial<Pick<AppSettings, RendererSettingsKey>>
