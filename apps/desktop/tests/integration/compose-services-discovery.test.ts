import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// PF-4 (full-audit 2026-07-10): initBackend's synchronous `composeServices` used to run a fresh
// manifest walk + YAML parse per role resolution — back-to-back, before the window exists. It
// now discovers ONCE and threads the result into every role resolver. The spy wrapper below
// keeps the REAL discovery (this test runs over a real temp drive layout) and only counts the
// walks; the per-action `composeTranslator` call site (issue #40) must keep re-discovering.

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

import { composeServices, composeTranslator } from '../../src/main/services/compose-services'

/** A minimal VALID manifest per role (JSON is YAML — discoverManifests parses it fine). */
function roleManifest(id: string, role: string, runtime = 'llama_cpp', format = 'gguf') {
  return {
    id,
    display_name: `${id} (test)`,
    family: 'test-family',
    role,
    format,
    runtime,
    license: 'apache-2.0',
    size_on_disk_gb: 0.1,
    recommended_min_ram_gb: 1,
    recommended_ram_gb: 2,
    recommended_context_tokens: 4096,
    local_path: `models/${role}/${id}.bin`,
    sha256: 'REPLACE_WITH_REAL_HASH',
    recommended_profiles: [],
    license_review: { status: 'approved', reviewed_by: 'test', reviewed_at: '2026-07-10', notes: '' }
  }
}

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
    writeFileSync(join(manifestsDir, `${m.id}.yaml`), JSON.stringify(m))
  }
  return { root, manifestsDir }
}

describe('composeServices — one discovery per composition pass (PF-4)', () => {
  it('walks the manifests dir exactly ONCE for all role resolutions', () => {
    const { root, manifestsDir } = tempDrive()
    discoverCalls.mockClear()
    const services = composeServices({ rootPath: root, manifestsDir })
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
    composeTranslator({ rootPath: root, manifestsDir }) // no `discovered` — a download just landed
    expect(discoverCalls).toHaveBeenCalledTimes(1)
  })

  it('a null manifests dir walks nothing and still composes the fallbacks', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-discovery-'))
    discoverCalls.mockClear()
    const services = composeServices({ rootPath: root, manifestsDir: null })
    expect(discoverCalls).not.toHaveBeenCalled()
    expect(services.embedder).toBeTruthy()
    expect(services.reranker).toBeNull()
    expect(services.transcriber).toBeNull()
    expect(services.translator).toBeNull()
  })
})
