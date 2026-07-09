import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { composeTranslator } from '../../src/main/services/compose-services'
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
