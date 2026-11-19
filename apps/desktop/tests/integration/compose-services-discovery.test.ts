import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PF-4 (full-audit 2026-07-10): initBackend's synchronous `composeServices` used to run a fresh
// manifest walk + YAML parse per role resolution — back-to-back, before the window exists. It
// now discovers ONCE and threads the result into every role resolver. The spy wrapper below
// keeps the REAL discovery (this test runs over a real temp drive layout) and only counts the
// walks; the per-action call sites — `composeTranslator` (issue #40) and `refreshTranscriberSlot` (issue #497) — must keep re-discovering.

const { discoverCalls } = vi.hoisted(() => ({ discoverCalls: vi.fn() }))
vi.mock('../../src/main/services/models', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/models')>()
  return {
    ...orig,
    discoverManifests: (dir: string) => {
      discoverCalls(dir)
      return orig.discoverManifests(dir)
    }
  }
})

import {
  composeServices,
  composeTranslator,
  refreshTranscriberSlot,
  type TranscriberSlot
} from '../../src/main/services/compose-services'
import { whisperCliBinaryName, whisperCliDir } from '../../src/main/services/transcriber'
import { llamaServerBinaryName, llamaServerDir } from '../../src/main/services/runtime/sidecar'
import { rawManifest, writeDriveFile, writeManifest } from '../helpers/manifest-fixtures'

/** A minimal VALID manifest per role. */
const roleManifest = (id: string, role: string, runtime = 'llama_cpp', format = 'gguf'): Record<string, unknown> =>
  rawManifest({ id, role, format, runtime, local_path: `models/${role}/${id}.bin` })

function tempDrive(): { root: string; manifestsDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-discovery-'))
  const manifestsDir = join(root, 'model-manifests')
  mkdirSync(manifestsDir, { recursive: true })
  for (const m of [
    roleManifest('embed-test', 'embeddings'),
    roleManifest('rerank-test', 'reranker'),
    roleManifest('whisper-test', 'transcriber', 'whisper_cpp', 'ggml'),
    roleManifest('translate-test', 'translation')
  ]) {
    writeManifest(manifestsDir, `${m.id}.yaml`, m)
  }
  return { root, manifestsDir }
}

describe('composeServices — one discovery per composition pass (PF-4)', () => {
  it('walks the manifests dir exactly ONCE for all role resolutions', () => {
    const { root, manifestsDir } = tempDrive()
    discoverCalls.mockClear()
    // Wave 8 ruling (b)(G)/NF-1: composeServices's two reranker callbacks are now required —
    // no sidecar binary is provisioned in this fixture, so their values never matter, only that
    // the wire compiles and is threaded through (proven functionally in
    // reranker-callbacks-composition.test.ts).
    const services = composeServices({
      rootPath: root,
      manifestsDir,
      bundledManifestsDir: null,
      rerankerDevicePosture: () => 'cpu',
      rerankerRequestCeiling: () => Infinity,
      checkModel: async () => 'ok'
    })
    expect(discoverCalls).toHaveBeenCalledTimes(1)
    expect(discoverCalls).toHaveBeenCalledWith(manifestsDir)
    // Behavior identical: with no sidecar binaries provisioned, the selections are what the
    // per-role discovery produced before — a mock embedder, null for everything else.
    expect(services.embedder).toBeTruthy()
    expect(services.reranker).toBeNull()
    expect(services.transcriber).toBeNull()
    expect(services.translator).toBeNull()
  })

  it('the per-action composeTranslator call site (issue #40) still re-discovers', () => {
    const { root, manifestsDir } = tempDrive()
    discoverCalls.mockClear()
    composeTranslator({ rootPath: root, manifestsDir, checkModel: async () => 'ok' }) // no `discovered` — a download just landed
    expect(discoverCalls).toHaveBeenCalledTimes(1)
  })

  it('the per-action refreshTranscriberSlot call site (issue #497) re-discovers too', () => {
    const { root, manifestsDir } = tempDrive()
    discoverCalls.mockClear()
    // No `discovered` — a speech-model download or a whisper.cpp install just changed the drive.
    const ctx = {
      transcriber: null,
      paths: { rootPath: root },
      manifestsDir,
      bundledManifestsDir: null,
      isDev: false,
      checkModel: async () => 'ok' as const
    }
    expect(refreshTranscriberSlot(ctx)).toBe(false) // no binary in the fixture
    expect(discoverCalls).toHaveBeenCalledTimes(1)
  })

  it('a null manifests dir walks nothing and still composes the fallbacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-discovery-'))
    discoverCalls.mockClear()
    const services = composeServices({
      rootPath: root,
      manifestsDir: null,
      bundledManifestsDir: null,
      rerankerDevicePosture: () => 'cpu',
      rerankerRequestCeiling: () => Infinity,
      checkModel: async () => 'ok'
    })
    expect(discoverCalls).not.toHaveBeenCalled()
    expect(services.embedder).toBeTruthy()
    expect(services.reranker).toBeNull()
    expect(services.transcriber).toBeNull()
    expect(services.translator).toBeNull()
  })
})

// #848 (round 1, S5): the manifest flagged `default_for_role` is THE embedder even when its file is missing and another
// embeddings model is installed. The app then composes the mock embedder (search finds nothing until the default is
// back; the AI Model screen offers its download) instead of silently switching to another model, whose vectors are a
// different space from the index the default built (rag-design "Embedding during ingestion", "Which manifest is the
// embedder"). Installed-first was the declined option D of research D §3.2 (G-12 chose the flag).
describe('composeServices — the flagged embedder is the embedder, present or not (#848)', () => {
  function drive(defaultPresent: boolean): { root: string; manifestsDir: string } {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-default-'))
    const manifestsDir = join(root, 'model-manifests')
    mkdirSync(manifestsDir, { recursive: true })
    mkdirSync(llamaServerDir(root), { recursive: true })
    writeFileSync(join(llamaServerDir(root), llamaServerBinaryName()), '') // never spawned: the embedder starts lazily
    const embed = (id: string, flagged: boolean): Record<string, unknown> =>
      rawManifest({ id, role: 'embeddings', local_path: `models/embeddings/${id}.gguf`, ...(flagged ? { default_for_role: true } : {}) })
    writeManifest(manifestsDir, 'a-installed.yaml', embed('a-installed', false))
    writeManifest(manifestsDir, 'z-default.yaml', embed('z-default', true))
    writeDriveFile(root, 'models/embeddings/a-installed.gguf', 'weight')
    if (defaultPresent) writeDriveFile(root, 'models/embeddings/z-default.gguf', 'weight')
    return { root, manifestsDir }
  }
  const embedderId = (d: { root: string; manifestsDir: string }): string =>
    composeServices({
      rootPath: d.root,
      manifestsDir: d.manifestsDir,
      bundledManifestsDir: null,
      rerankerDevicePosture: () => 'cpu',
      rerankerRequestCeiling: () => Infinity,
      checkModel: async () => 'ok'
    }).embedder.id

  it('a missing default file composes the mock embedder, never the other installed embedder', () => {
    expect(embedderId(drive(true))).toBe('z-default')
    expect(embedderId(drive(false))).toBe('mock-embedder')
  })
})

// #913: the start check reaches every non-chat role through `composeServices` (and the transcriber's mid-session
// refresh), bound to that role's model and hashing choice: G-4 (d2) hashes the search and voice models before their
// first start, the reranker and translation read the cache only. Each service runs the check before it spawns, so a
// `damaged` verdict proves the wire without a real binary: the placeholder binaries below are never started.
describe('composeServices — the start check reaches every role (#913)', () => {
  function provisioned(): { root: string; manifestsDir: string } {
    const { root, manifestsDir } = tempDrive()
    for (const [role, id] of [
      ['embeddings', 'embed-test'],
      ['reranker', 'rerank-test'],
      ['transcriber', 'whisper-test'],
      ['translation', 'translate-test']
    ]) {
      writeDriveFile(root, `models/${role}/${id}.bin`, 'weights')
    }
    mkdirSync(llamaServerDir(root), { recursive: true })
    writeFileSync(join(llamaServerDir(root), llamaServerBinaryName()), '')
    mkdirSync(whisperCliDir(root), { recursive: true })
    writeFileSync(join(whisperCliDir(root), whisperCliBinaryName()), '')
    return { root, manifestsDir }
  }

  it('each service asks it before its first start, with its own model and hashing choice, and refuses on damaged', async () => {
    const { root, manifestsDir } = provisioned()
    const asked: Array<[string, boolean]> = []
    const checkModel = vi.fn(async (modelId: string, opts: { hash: boolean; signal?: AbortSignal; manifest?: { id: string } }) => {
      asked.push([modelId, opts.hash])
      return 'damaged' as const
    })
    const services = composeServices({
      rootPath: root,
      manifestsDir,
      bundledManifestsDir: null,
      rerankerDevicePosture: () => 'cpu',
      rerankerRequestCeiling: () => Infinity,
      checkModel
    })
    expect(checkModel).not.toHaveBeenCalled() // composing starts nothing

    await expect(services.embedder.embed(['x'])).rejects.toMatchObject({ name: 'EmbedderError', kind: 'start' })
    await expect(services.reranker!.rerank('q', ['a', 'b'])).rejects.toThrow(/failed its check/)
    await expect(services.translator!.translate({ sourceLang: 'de', targetLang: 'en', text: 'Hallo' })).rejects.toMatchObject({
      name: 'TranslationStartError',
      modelDamaged: true
    })
    const workDir = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-check-'))
    await expect(services.transcriber!.transcribe(join(workDir, 'a.wav'), { workDir })).rejects.toThrow(/failed its file check/)
    expect(asked).toEqual([
      ['embed-test', true],
      ['rerank-test', false],
      ['translate-test', false],
      ['whisper-test', true]
    ])
    // #913 code review: each carries the manifest its service was composed from, so no check re-reads the folder.
    expect(checkModel.mock.calls.map(([id, opts]) => [id, opts.manifest?.id])).toEqual(asked.map(([id]) => [id, id]))

    // The transcriber a mid-session install refreshes into an empty slot gets the same check.
    const ctx: TranscriberSlot = {
      transcriber: null,
      paths: { rootPath: root },
      manifestsDir,
      bundledManifestsDir: null,
      isDev: false,
      checkModel
    }
    expect(refreshTranscriberSlot(ctx)).toBe(true)
    await expect(ctx.transcriber!.transcribe(join(workDir, 'b.wav'), { workDir })).rejects.toThrow(/failed its file check/)
    expect(asked.at(-1)).toEqual(['whisper-test', true])
    await Promise.all([services.embedder.stop?.(), services.reranker!.stop?.(), services.translator!.stop()])
  })
})
