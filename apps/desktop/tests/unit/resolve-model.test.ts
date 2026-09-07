import { describe, it, expect, vi, beforeEach } from 'vitest'

// M-A3 (audit-2026-06-13): the one resolver that replaced the three copy-paste bodies.
// Mock the manifests layer so the test is about role filtering + the contextTokens flag,
// not about a full valid-manifest fixture.

const discoverManifests = vi.fn()
const weightPath = vi.fn((root: string, m: { id: string }) => `${root}/weights/${m.id}.gguf`)
// #310: the resolver reports EVERY required file, so the availability ladder can refuse a
// half-present multi-file weight. The fake mirrors the real enumeration's shape.
const manifestFiles = vi.fn((root: string, m: { id: string; files?: Array<{ localPath: string }> }) => [
  { path: `${root}/weights/${m.id}.gguf`, sha: 'x', localPath: `weights/${m.id}.gguf`, kind: 'weight' },
  ...(m.files ?? []).map((f) => ({ path: `${root}/${f.localPath}`, sha: 'x', localPath: f.localPath, kind: 'extra' }))
])

vi.mock('../../src/main/services/models', () => ({
  discoverManifests: (...a: unknown[]) => discoverManifests(...a),
  weightPath: (...a: unknown[]) => weightPath(...(a as [string, { id: string }])),
  manifestFiles: (...a: unknown[]) => manifestFiles(...(a as [string, { id: string }]))
}))

import { resolveModelByRole } from '../../src/main/services/resolve-model'

function manifest(id: string, role: string, recommendedContextTokens = 4096, extras: string[] = []) {
  return {
    manifest: {
      id,
      role,
      recommendedContextTokens,
      ...(extras.length > 0 ? { files: extras.map((localPath) => ({ localPath })) } : {})
    }
  }
}

describe('resolveModelByRole (M-A3)', () => {
  beforeEach(() => {
    discoverManifests.mockReset()
    discoverManifests.mockReturnValue({
      manifests: [
        manifest('qwen3-chat', 'chat'),
        manifest('e5-embed', 'embeddings', 512),
        manifest('bge-rerank', 'reranker', 8192),
        manifest('whisper-base', 'transcriber', 0)
      ]
    })
  })

  it('returns null when there is no manifests dir', () => {
    expect(resolveModelByRole(null, 'C:/drive', 'embeddings')).toBeNull()
    expect(discoverManifests).not.toHaveBeenCalled()
  })

  it('resolves the model for the role with id + weight path + contextTokens', () => {
    expect(resolveModelByRole('C:/m', 'C:/drive', 'embeddings')).toEqual({
      id: 'e5-embed',
      modelPath: 'C:/drive/weights/e5-embed.gguf',
      requiredPaths: ['C:/drive/weights/e5-embed.gguf'],
      contextTokens: 512
    })
    expect(resolveModelByRole('C:/m', 'C:/drive', 'reranker')).toMatchObject({
      id: 'bge-rerank',
      contextTokens: 8192
    })
  })

  it('omits contextTokens when includeContextTokens:false (the transcriber)', () => {
    const m = resolveModelByRole('C:/m', 'C:/drive', 'transcriber', {
      includeContextTokens: false
    })
    expect(m).toEqual({
      id: 'whisper-base',
      modelPath: 'C:/drive/weights/whisper-base.gguf',
      requiredPaths: ['C:/drive/weights/whisper-base.gguf']
    })
    expect(m).not.toHaveProperty('contextTokens')
  })

  // #310: the primary stays the `--model` argument; requiredPaths carries the whole weight.
  it('reports every required file of a multi-file weight (#310)', () => {
    discoverManifests.mockReturnValue({
      manifests: [manifest('sharded-embed', 'embeddings', 512, ['models/embed/e-00002-of-00002.gguf'])]
    })
    expect(resolveModelByRole('C:/m', 'C:/drive', 'embeddings')).toEqual({
      id: 'sharded-embed',
      modelPath: 'C:/drive/weights/sharded-embed.gguf',
      requiredPaths: [
        'C:/drive/weights/sharded-embed.gguf',
        'C:/drive/models/embed/e-00002-of-00002.gguf'
      ],
      contextTokens: 512
    })
  })

  it('returns null when no manifest matches the role', () => {
    discoverManifests.mockReturnValue({ manifests: [manifest('qwen3-chat', 'chat')] })
    expect(resolveModelByRole('C:/m', 'C:/drive', 'reranker')).toBeNull()
  })

  // PF-4 (full-audit 2026-07-10): composeServices discovers once per composition pass and
  // threads the result in — the resolver must then NOT re-walk the manifests dir.
  it('uses caller-provided discovered manifests without re-discovering (PF-4)', () => {
    const discovered = [manifest('e5-embed', 'embeddings', 512)] as never
    expect(resolveModelByRole('C:/m', 'C:/drive', 'embeddings', { discovered })).toEqual({
      id: 'e5-embed',
      modelPath: 'C:/drive/weights/e5-embed.gguf',
      requiredPaths: ['C:/drive/weights/e5-embed.gguf'],
      contextTokens: 512
    })
    expect(discoverManifests).not.toHaveBeenCalled()
  })

  it('never throws — a manifest-layer failure reads as "no model"', () => {
    discoverManifests.mockImplementation(() => {
      throw new Error('corrupt manifests dir')
    })
    expect(resolveModelByRole('C:/m', 'C:/drive', 'embeddings')).toBeNull()
  })
})
