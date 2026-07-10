import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeTranslator, shouldReplaceTranslator } from '../../src/main/services/compose-services'
import type { Translator } from '../../src/main/services/translation'
import { llamaOsDir, llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'

// Issue #40 — the post-download translator re-selection. `composeTranslator` is the ONE
// construction `composeServices` (startup) and `AppContext.onModelInstalled` (a completed in-app
// download) share, so this drives it over a REAL temp drive layout (manifest YAML + binary +
// weight files, no mocks): null while the weight is absent, a live selection the moment the GGUF
// lands — exactly the restart-free activation the issue asks for.

/** A minimal VALID translation manifest (JSON is YAML — discoverManifests parses it fine). */
const MANIFEST = {
  id: 'translategemma-test',
  display_name: 'TranslateGemma (test)',
  family: 'translategemma',
  role: 'translation',
  format: 'gguf',
  runtime: 'llama_cpp',
  license: 'gemma',
  size_on_disk_gb: 0.1,
  recommended_min_ram_gb: 1,
  recommended_ram_gb: 2,
  recommended_context_tokens: 4096,
  local_path: 'models/translation/tg-test.gguf',
  sha256: 'REPLACE_WITH_REAL_HASH',
  recommended_profiles: [],
  license_review: {
    status: 'approved',
    reviewed_by: 'test',
    reviewed_at: '2026-07-09',
    notes: ''
  }
}

function tempDrive(): { root: string; manifestsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-translator-'))
  const manifestsDir = join(root, 'model-manifests')
  mkdirSync(manifestsDir, { recursive: true })
  writeFileSync(join(manifestsDir, 'translategemma-test.yaml'), JSON.stringify(MANIFEST))
  return { root, manifestsDir }
}

function installBinary(root: string): void {
  const binDir = join(root, 'runtime', 'llama.cpp', llamaOsDir())
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, llamaServerBinaryName()), '')
}

function installWeight(root: string): void {
  const dir = join(root, 'models', 'translation')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'tg-test.gguf'), 'gguf-bytes')
}

describe('composeTranslator (issue #40 — post-download re-selection)', () => {
  it('returns null while the weight is absent, then a live Translator once the GGUF lands', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)

    // The startup composition on a drive WITHOUT the translation weight — issue #40's step 1.
    expect(composeTranslator({ rootPath: root, manifestsDir })).toBeNull()

    // The download completes (weight renamed into place) → onModelInstalled re-runs THIS —
    // and the selection flips without a restart.
    installWeight(root)
    const translator = composeTranslator({ rootPath: root, manifestsDir })
    expect(translator).not.toBeNull()
    expect(translator?.modelId).toBe('translategemma-test')
    expect(translator?.contextWindow()).toBe(4096) // the manifest's recommended_context_tokens
  })

  it('stays null when only the weight (no llama-server binary) is present', () => {
    const { root, manifestsDir } = tempDrive()
    installWeight(root)
    expect(composeTranslator({ rootPath: root, manifestsDir })).toBeNull()
  })

  it('returns null with no manifests dir (every role falls back)', () => {
    const { root } = tempDrive()
    installBinary(root)
    installWeight(root)
    expect(composeTranslator({ rootPath: root, manifestsDir: null })).toBeNull()
  })
})

/** A minimal live Translator fake — the interface `AppContext.translator` carries. */
function fakeTranslator(overrides: Partial<Translator> = {}): Translator {
  return {
    modelId: 'live-instance',
    contextWindow: () => 4096,
    translate: async () => 'ok',
    stop: async () => undefined,
    ...overrides
  }
}

// full-audit 2026-07-10 BE-7: the onModelInstalled refresh (main/index.ts) replaces the slot
// per THIS rule — a startFailed-latched instance (corrupt GGUF) no longer blocks the
// delete-and-re-download repair until an app restart.
describe('shouldReplaceTranslator (BE-7 — latched instances repairable without restart)', () => {
  it('replaces a null/undefined slot (the original #40 case)', () => {
    expect(shouldReplaceTranslator(null)).toBe(true)
    expect(shouldReplaceTranslator(undefined)).toBe(true)
  })

  it('NEVER replaces a live instance — with or without a latch reporter', () => {
    expect(shouldReplaceTranslator(fakeTranslator({ isStartFailed: () => false }))).toBe(false)
    expect(shouldReplaceTranslator(fakeTranslator())).toBe(false) // no reporter → assumed live
  })

  it('replaces a startFailed-latched instance, and re-composition yields a FRESH working translator', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)
    installWeight(root) // the user deleted the corrupt GGUF and re-downloaded — weights are back
    const latched = fakeTranslator({ isStartFailed: () => true })
    expect(shouldReplaceTranslator(latched)).toBe(true)
    // The refresh path re-runs composeTranslator — the replacement is a live, un-latched selection.
    const fresh = composeTranslator({ rootPath: root, manifestsDir })
    expect(fresh).not.toBeNull()
    expect(fresh?.modelId).toBe('translategemma-test')
    expect(fresh?.isStartFailed?.()).toBe(false) // the fresh instance starts un-latched
  })
})
