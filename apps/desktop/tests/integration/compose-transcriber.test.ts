import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeTranscriber,
  refreshTranscriberSlot,
  shouldReplaceTranscriber
} from '../../src/main/services/compose-services'
import {
  WhisperCliTranscriber,
  whisperCliBinaryName,
  whisperCliDir,
  type Transcriber
} from '../../src/main/services/transcriber'

// Issue #497 — the post-install transcriber re-selection, the transcriber twin of the issue-#40
// translator hook (compose-translator.test.ts). `composeTranscriber` is the ONE construction
// `composeServices` (startup) and the two mid-session hooks (a completed speech-model download,
// a completed whisper.cpp engine install) share, driven here over a REAL temp drive layout
// (manifest YAML + binary + weight files, no mocks): null while binary or weights are absent, a
// live selection the moment both are on the drive — the restart-free activation the issue asks for.

/** A minimal VALID transcriber manifest (JSON is YAML — discoverManifests parses it fine). */
const MANIFEST = {
  id: 'whisper-test',
  display_name: 'Whisper (test)',
  family: 'whisper',
  role: 'transcriber',
  format: 'ggml',
  runtime: 'whisper_cpp',
  license: 'mit',
  size_on_disk_gb: 0.1,
  recommended_min_ram_gb: 1,
  recommended_ram_gb: 2,
  recommended_context_tokens: 0, // the CLI takes none — the shipped manifest says 0 too
  local_path: 'models/transcriber/whisper-test.bin',
  sha256: 'REPLACE_WITH_REAL_HASH',
  recommended_profiles: [],
  license_review: {
    status: 'approved',
    reviewed_by: 'test',
    reviewed_at: '2026-09-21',
    notes: ''
  }
}

function tempDrive(): { root: string; manifestsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-transcriber-'))
  const manifestsDir = join(root, 'model-manifests')
  mkdirSync(manifestsDir, { recursive: true })
  writeFileSync(join(manifestsDir, 'whisper-test.yaml'), JSON.stringify(MANIFEST))
  return { root, manifestsDir }
}

function installBinary(root: string): void {
  const binDir = whisperCliDir(root)
  mkdirSync(binDir, { recursive: true })
  writeFileSync(join(binDir, whisperCliBinaryName()), '')
}

function installWeight(root: string): void {
  const dir = join(root, 'models', 'transcriber')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'whisper-test.bin'), 'ggml-bytes')
}

describe('composeTranscriber (issue #497 — post-install re-selection)', () => {
  it('returns null while the weight is absent, then a live Transcriber once the GGML lands', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)

    // The startup composition on a drive WITHOUT the speech model — the tester's step 1.
    expect(composeTranscriber({ rootPath: root, manifestsDir })).toBeNull()

    // The download completes (weight renamed into place) → the hook re-runs THIS — and the
    // selection flips without a restart.
    installWeight(root)
    const transcriber = composeTranscriber({ rootPath: root, manifestsDir })
    expect(transcriber).not.toBeNull()
    expect(transcriber?.id).toBe('whisper-test')
  })

  it('returns null while the whisper-cli binary is absent, then a live Transcriber once the engine is installed', () => {
    const { root, manifestsDir } = tempDrive()
    installWeight(root)

    // The weights were provisioned, the voice engine was not — the "Install voice engine" case.
    expect(composeTranscriber({ rootPath: root, manifestsDir })).toBeNull()
    installBinary(root)
    expect(composeTranscriber({ rootPath: root, manifestsDir })?.id).toBe('whisper-test')
  })

  it('returns null with no manifests dir (every role falls back)', () => {
    const { root } = tempDrive()
    installBinary(root)
    installWeight(root)
    expect(composeTranscriber({ rootPath: root, manifestsDir: null })).toBeNull()
  })
})

// #504: the shipped whisper manifest declares the Silero VAD model as a second REQUIRED file
// (`files[]`). Over a real temp layout: the transcriber stays null until BOTH files are present,
// and the composed CLI backend knows the VAD path (found by name among the required files).
describe('composeTranscriber — the Silero VAD file as the second required file (#504)', () => {
  const VAD_NAME = 'ggml-silero-v5.1.2.bin'
  function tempDriveWithVad(): { root: string; manifestsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-transcriber-vad-'))
    const manifestsDir = join(root, 'model-manifests')
    mkdirSync(manifestsDir, { recursive: true })
    writeFileSync(
      join(manifestsDir, 'whisper-test.yaml'),
      JSON.stringify({
        ...MANIFEST,
        files: [{ local_path: `models/transcriber/${VAD_NAME}`, sha256: 'REPLACE_WITH_REAL_HASH' }]
      })
    )
    return { root, manifestsDir }
  }

  it('stays null with the weight alone, and composes with the VAD path once the second file lands', () => {
    const { root, manifestsDir } = tempDriveWithVad()
    installBinary(root)
    installWeight(root)
    expect(composeTranscriber({ rootPath: root, manifestsDir })).toBeNull()

    writeFileSync(join(root, 'models', 'transcriber', VAD_NAME), 'vad-bytes')
    const transcriber = composeTranscriber({ rootPath: root, manifestsDir })
    expect(transcriber).toBeInstanceOf(WhisperCliTranscriber)
    expect((transcriber as WhisperCliTranscriber).vadModelPath).toBe(join(root, 'models', 'transcriber', VAD_NAME))
  })

  it('a weight-only manifest composes without a VAD path (drives from before #504 keep working)', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)
    installWeight(root)
    const transcriber = composeTranscriber({ rootPath: root, manifestsDir })
    expect((transcriber as WhisperCliTranscriber).vadModelPath).toBeNull()
  })
})

/** A minimal live Transcriber fake — the interface `AppContext.transcriber` carries. */
function fakeTranscriber(): Transcriber {
  return {
    id: 'live-instance',
    transcribe: async () => []
  }
}

describe('shouldReplaceTranscriber (#497 — only a null slot is ever re-composed)', () => {
  it('replaces a null/undefined slot', () => {
    expect(shouldReplaceTranscriber(null)).toBe(true)
    expect(shouldReplaceTranscriber(undefined)).toBe(true)
  })

  it('NEVER replaces a live instance (it may hold an in-flight whisper child the lock/quit teardowns reach through ctx)', () => {
    expect(shouldReplaceTranscriber(fakeTranscriber())).toBe(false)
  })
})

describe('refreshTranscriberSlot (#497 — the hook body both install paths share)', () => {
  function slot(root: string, manifestsDir: string | null, transcriber: Transcriber | null = null) {
    return { transcriber, paths: { rootPath: root }, manifestsDir, isDev: false }
  }

  it('fills a null slot once binary + weights are present, and reports the flip', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)
    installWeight(root)
    const ctx = slot(root, manifestsDir)
    expect(refreshTranscriberSlot(ctx)).toBe(true)
    expect(ctx.transcriber?.id).toBe('whisper-test')
  })

  it('leaves a null slot null (and reports no flip) while the drive still lacks binary or weights', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root) // no weight yet — e.g. a download of a DIFFERENT role fired the hook
    const ctx = slot(root, manifestsDir)
    expect(refreshTranscriberSlot(ctx)).toBe(false)
    expect(ctx.transcriber).toBeNull()
  })

  it('leaves a LIVE instance untouched — same object, no re-composition', () => {
    const { root, manifestsDir } = tempDrive()
    installBinary(root)
    installWeight(root)
    const live = fakeTranscriber()
    const ctx = slot(root, manifestsDir, live)
    expect(refreshTranscriberSlot(ctx)).toBe(false)
    expect(ctx.transcriber).toBe(live)
  })

  it('never throws — a fault is swallowed and logged, so the translator refresh behind it still runs', () => {
    // The download manager wraps the WHOLE onModelInstalled hook in one swallowing try/catch
    // (downloads.ts), so a throw here would silently skip the issue-#40 translator refresh that
    // follows in main/index.ts. A context whose paths cannot be read is the cheapest fault.
    const ctx = {
      transcriber: null as Transcriber | null,
      get paths(): { rootPath: string } {
        throw new Error('paths unreadable')
      },
      manifestsDir: null,
      isDev: false
    }
    expect(() => refreshTranscriberSlot(ctx)).not.toThrow()
    expect(refreshTranscriberSlot(ctx)).toBe(false)
    expect(ctx.transcriber).toBeNull()
  })
})
