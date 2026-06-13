import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// MANUAL dictation smoke (Phase 37) — NOT CI.
//
// CI stays zero-network/zero-model/zero-binary/zero-mic, so this file is skipped
// unless HILBERTRAUM_DICTATION_SMOKE points at a provisioned drive root (the whisper-smoke
// shape). A REAL microphone cannot be driven from a test; what this proves on the
// real pinned binary + weights is the whole MAIN-PROCESS half of dictation: WAV
// bytes → `dictation:transcribe` handler → temp `.parse-dictation.wav` → real
// whisper-cli → text back, transient shredded.
//
//   HILBERTRAUM_DICTATION_SMOKE=<root with runtime/whisper.cpp/<os>/whisper-cli + models/transcriber/ggml-*.bin>
//   HILBERTRAUM_WHISPER_AUDIO=<dir with german.wav — the Phase-36 fixture dir; NEVER committed>
//   npx vitest run tests/manual/dictation-smoke.test.ts
//
// The renderer half (getUserMedia → MediaRecorder → OfflineAudioContext → WAV) needs a
// human with a microphone in the built app — see the Phase-37 eyeball notes.

const ipcState = vi.hoisted(() => ({ handlers: new Map<string, unknown>() }))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  }
}))

import { IPC } from '../../src/shared/ipc'
import { registerDictationIpc } from '../../src/main/ipc/registerDictationIpc'
import { documentsDir } from '../../src/main/services/ingestion'
import {
  createWhisperCliTranscriber,
  resolveWhisperCliPath
} from '../../src/main/services/transcriber'
import type { AppContext } from '../../src/main/services/context'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const ROOT = process.env.HILBERTRAUM_DICTATION_SMOKE?.trim() ?? ''
const AUDIO_DIR = process.env.HILBERTRAUM_WHISPER_AUDIO?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT) && AUDIO_DIR.length > 0 && existsSync(AUDIO_DIR)

const handlers = ipcState.handlers as unknown as IpcHandlers

function transcriberModel(root: string): string | null {
  const dir = join(root, 'models', 'transcriber')
  if (!existsSync(dir)) return null
  const bin = readdirSync(dir).find((f) => f.endsWith('.bin'))
  return bin ? join(dir, bin) : null
}

beforeEach(() => ipcState.handlers.clear())

describe.skipIf(!enabled)('Dictation smoke (manual, real whisper-cli over the dictation IPC)', () => {
  it(
    'turns real German WAV bytes into text through the dictation handler and shreds the transient',
    { timeout: 600_000 },
    async () => {
      const binPath = resolveWhisperCliPath(ROOT)
      const modelPath = transcriberModel(ROOT)
      expect(binPath, 'whisper-cli missing under runtime/whisper.cpp/<os>/').toBeTruthy()
      expect(modelPath, 'no .bin under models/transcriber/').toBeTruthy()
      const wavFixture = join(AUDIO_DIR, 'german.wav')
      expect(existsSync(wavFixture), `fixture missing: ${wavFixture}`).toBe(true)

      const workspacePath = mkdtempSync(join(tmpdir(), 'hilbertraum-dictation-smoke-'))
      const ctx = {
        paths: { workspacePath },
        transcriber: createWhisperCliTranscriber({
          id: 'smoke-whisper',
          binPath: binPath!,
          modelPath: modelPath!
        }),
        workspace: { isUnlocked: () => true }
      } as unknown as AppContext
      registerDictationIpc(ctx)

      // The renderer sends BYTES (D30) — feed the handler the fixture's bytes.
      const bytes = new Uint8Array(readFileSync(wavFixture))
      const { result } = await invoke(handlers, IPC.transcribeDictation, bytes)
      const text = result as string

      console.log(`[dictation] ${text.length} chars: ${text.slice(0, 200)}`)
      expect(text.length).toBeGreaterThan(10)
      // Transients are gone: the documents dir holds nothing after the call.
      expect(readdirSync(documentsDir(workspacePath))).toEqual([])
    }
  )
})
