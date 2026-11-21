import { describe, it, expect, vi } from 'vitest'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

// #848: the manifest walk's order decides every first-of-role pick (the embedder, reranker, transcriber, translator),
// the ★ tie-breaks and which file wins a duplicate id. NTFS lists a folder sorted, but FAT/exFAT (a Kit), ext4 and APFS
// do not, so an unmocked row passes on Windows and proves nothing: a passthrough `node:fs` mock REVERSES every listing
// under the test's root (the fs-recording idiom of skills-ipc.test.ts; no production seam).
const order = vi.hoisted(() => ({ reverseUnder: '' }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const readdirSync = ((path: unknown, options?: unknown) => {
    const entries = (actual.readdirSync as unknown as (p: unknown, o?: unknown) => unknown[])(path, options)
    return order.reverseUnder !== '' && String(path).startsWith(order.reverseUnder) ? [...entries].reverse() : entries
  }) as unknown as typeof actual.readdirSync
  const mocked = { ...actual, readdirSync }
  return { ...mocked, default: mocked }
})

import { discoverManifests } from '../../src/main/services/models'
import { tempRoot } from '../helpers/db-fixtures'
import { rawManifest, writeManifest } from '../helpers/manifest-fixtures'

describe('discoverManifests walks in code-unit order (#848)', () => {
  it('returns the same order however the file system lists the folders and files', () => {
    const dir = tempRoot('manifest-order')
    mkdirSync(join(dir, 'embeddings'))
    mkdirSync(join(dir, 'chat'))
    writeManifest(join(dir, 'embeddings'), 'b-embed.yaml', rawManifest({ id: 'b-embed', role: 'embeddings' }))
    writeManifest(join(dir, 'embeddings'), 'a-embed.yaml', rawManifest({ id: 'a-embed', role: 'embeddings' }))
    // Code-unit order, not a locale's: 'B' (0x42) sorts before 'a' (0x61), on every OS and in every UI language.
    writeManifest(join(dir, 'embeddings'), 'B-upper.yaml', rawManifest({ id: 'B-upper', role: 'embeddings' }))
    writeManifest(join(dir, 'chat'), 'z-chat.yaml', rawManifest({ id: 'z-chat' }))
    // A duplicate id: the file first in that order wins, whichever the listing returns first.
    writeManifest(join(dir, 'embeddings'), 'c-dup.yaml', rawManifest({ id: 'a-embed', role: 'embeddings', display_name: 'Loser' }))
    const expected = ['z-chat', 'B-upper', 'a-embed', 'b-embed']

    const listed = discoverManifests(dir)
    order.reverseUnder = dir
    let reversed: ReturnType<typeof discoverManifests>
    try {
      reversed = discoverManifests(dir)
    } finally {
      order.reverseUnder = ''
    }
    for (const res of [listed, reversed]) {
      expect(res.manifests.map((m) => m.manifest.id)).toEqual(expected)
      expect(res.manifests.find((m) => m.manifest.id === 'a-embed')?.sourceFile).toBe(join(dir, 'embeddings', 'a-embed.yaml'))
      expect(res.errors).toHaveLength(1)
      expect(res.errors[0]).toContain('c-dup.yaml')
    }
  })
})
