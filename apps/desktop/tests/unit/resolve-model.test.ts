import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'
import { tempRoot } from '../helpers/db-fixtures'
import { discovered, manifestsDirWith, rawManifest, validManifest } from '../helpers/manifest-fixtures'

// M-A3 (audit-2026-06-13): the one resolver that replaced the three copy-paste bodies. Real discovery over a real temp
// dir and the real path functions: the spy below only counts walks, so a `manifestFiles` regression reaches these rows.
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

import { resolveModelByRole } from '../../src/main/services/resolve-model'

const ROOT = 'C:/drive'
const onDrive = (rel: string): string => join(ROOT, rel)
const roleManifest = (id: string, role: string, contextTokens = 4096): Record<string, unknown> =>
  rawManifest({ id, role, recommended_context_tokens: contextTokens, local_path: `models/${role}/${id}.gguf` })

const catalog = (): string =>
  manifestsDirWith(
    roleManifest('qwen3-chat', 'chat'),
    roleManifest('e5-embed', 'embeddings', 512),
    roleManifest('bge-rerank', 'reranker', 8192),
    roleManifest('whisper-base', 'transcriber', 0)
  )

describe('resolveModelByRole (M-A3)', () => {
  beforeEach(() => {
    discoverCalls.mockClear()
  })

  it('returns null when there is no manifests dir', () => {
    expect(resolveModelByRole(null, ROOT, 'embeddings')).toBeNull()
    expect(discoverCalls).not.toHaveBeenCalled()
  })

  it('resolves the model for the role with id + weight path + contextTokens', () => {
    const dir = catalog()
    expect(resolveModelByRole(dir, ROOT, 'embeddings')).toEqual({
      id: 'e5-embed',
      modelPath: onDrive('models/embeddings/e5-embed.gguf'),
      requiredPaths: [onDrive('models/embeddings/e5-embed.gguf')],
      contextTokens: 512
    })
    expect(resolveModelByRole(dir, ROOT, 'reranker')).toMatchObject({
      id: 'bge-rerank',
      contextTokens: 8192
    })
  })

  it('omits contextTokens when includeContextTokens:false (the transcriber)', () => {
    const m = resolveModelByRole(catalog(), ROOT, 'transcriber', {
      includeContextTokens: false
    })
    expect(m).toEqual({
      id: 'whisper-base',
      modelPath: onDrive('models/transcriber/whisper-base.gguf'),
      requiredPaths: [onDrive('models/transcriber/whisper-base.gguf')]
    })
    expect(m).not.toHaveProperty('contextTokens')
  })

  // #310: the primary stays the `--model` argument; requiredPaths carries the whole weight.
  it('reports every required file of a multi-file weight (#310)', () => {
    const dir = manifestsDirWith(
      rawManifest({
        id: 'sharded-embed',
        role: 'embeddings',
        recommended_context_tokens: 512,
        local_path: 'models/embeddings/e-00001-of-00002.gguf',
        files: [{ local_path: 'models/embeddings/e-00002-of-00002.gguf', sha256: 'REPLACE_WITH_REAL_HASH' }]
      })
    )
    expect(resolveModelByRole(dir, ROOT, 'embeddings')).toEqual({
      id: 'sharded-embed',
      modelPath: onDrive('models/embeddings/e-00001-of-00002.gguf'),
      requiredPaths: [onDrive('models/embeddings/e-00001-of-00002.gguf'), onDrive('models/embeddings/e-00002-of-00002.gguf')],
      contextTokens: 512
    })
  })

  it('returns null when no manifest matches the role', () => {
    expect(resolveModelByRole(manifestsDirWith(roleManifest('qwen3-chat', 'chat')), ROOT, 'reranker')).toBeNull()
  })

  // PF-4 (full-audit 2026-07-10): composeServices discovers once per composition pass and
  // threads the result in — the resolver must then NOT re-walk the manifests dir. A directory
  // that does not exist, so only `discovered` can answer.
  it('uses caller-provided discovered manifests without re-discovering (PF-4)', () => {
    const m = validManifest({ id: 'e5-embed', role: 'embeddings', recommended_context_tokens: 512, local_path: 'models/embeddings/e5-embed.gguf' })
    expect(resolveModelByRole('C:/m', ROOT, 'embeddings', { discovered: [discovered(m)] })).toEqual({
      id: 'e5-embed',
      modelPath: onDrive('models/embeddings/e5-embed.gguf'),
      requiredPaths: [onDrive('models/embeddings/e5-embed.gguf')],
      contextTokens: 512
    })
    expect(discoverCalls).not.toHaveBeenCalled()
  })

  it('never throws — a manifest-layer failure reads as "no model"', () => {
    // The walk throws ENOENT for real…
    expect(resolveModelByRole(join(tempRoot('resolve'), 'missing'), ROOT, 'embeddings')).toBeNull()
    expect(discoverCalls).toHaveBeenCalledOnce()
    // …and so does the path guard, on a manifest that bypassed the validator.
    const escaping = { ...validManifest({ role: 'embeddings' }), localPath: '../../etc/passwd' }
    expect(resolveModelByRole('C:/m', ROOT, 'embeddings', { discovered: [discovered(escaping)] })).toBeNull()
  })
})
