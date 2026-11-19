import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checksumCacheStats,
  computeInstallState,
  createSettingsHashStore,
  invalidateChecksum
} from '../../src/main/services/models'
import { createModelStartCheck, rearmStartRefusals, type RearmTargets } from '../../src/main/services/model-start-check'
import { getSettings, updateSettings } from '../../src/main/services/settings'
import type { AppSettings } from '../../src/shared/types'
import { tempRoot } from '../helpers/db-fixtures'
import { manifestsDirWith, rawManifest, sha256, validManifest, writeDriveFile } from '../helpers/manifest-fixtures'
import { seededFreshDb } from '../helpers/seeded-db'

// #913 review S3: the start check `main/index.ts` builds and hands to every non-chat role, built by the exported
// factory so this row reads what production gets. What `checkModelBeforeStart` decides is pinned in models.test.ts;
// these pin the three things only the factory decides: which manifest (an id none names starts as before), which
// cache (the workspace store, so a "Check all model files" verdict outlives an app restart and the search and voice
// models are hashed once per workspace), and whose developer toggle (none while the workspace is locked).
describe('createModelStartCheck (#913 review S3)', () => {
  const REL = 'models/reranker/rr.gguf'

  function setup(manifest: Record<string, unknown> = {}) {
    const root = tempRoot('start-check-factory')
    const db = seededFreshDb('start-check-factory')
    const manifestsDir = manifestsDirWith(
      rawManifest({ id: 'rr', role: 'reranker', local_path: REL, sha256: sha256('reranker bytes'), ...manifest })
    )
    let settings: AppSettings | null = getSettings(db)
    const check = createModelStartCheck({
      manifestsDir,
      paths: { rootPath: root, configPath: join(root, 'config') },
      isDev: false,
      getSettings: () => settings,
      getDb: () => db
    })
    return { root, db, check, lock: () => (settings = null), reread: () => (settings = getSettings(db)) }
  }

  it('a model id no manifest names answers ok, and nothing is read or hashed', async () => {
    const { check } = setup()
    const before = checksumCacheStats.computed
    expect(await check('not-on-this-drive', { hash: true })).toBe('ok')
    expect(checksumCacheStats.computed).toBe(before)
  })

  it('reads the workspace store: a mismatch the in-memory cache no longer holds still refuses', async () => {
    const { root, db, check } = setup()
    const path = join(root, ...REL.split('/'))
    writeDriveFile(root, REL, 'reranker bytez') // a bit flip
    const m = validManifest({ id: 'rr', role: 'reranker', local_path: REL, sha256: sha256('reranker bytes') })
    // A full check earlier in this workspace wrote the verdict to the store; a restart emptied memory.
    const store = createSettingsHashStore(() => db, root)
    expect(await computeInstallState(m, root, { developerMode: false, hashStore: store })).toBe('checksum_failed')
    invalidateChecksum(path) // the in-memory entry only
    const before = checksumCacheStats.computed
    expect(await check('rr', { hash: false })).toBe('damaged')
    expect(checksumCacheStats.computed).toBe(before)
  })

  it('a locked workspace reads the developer toggle as off: a placeholder hash is refused until the unlock', async () => {
    const { root, db, check, lock, reread } = setup({ sha256: 'REPLACE_WITH_REAL_HASH' })
    writeDriveFile(root, REL, 'reranker bytes')
    // A drive policy that lets a developer start unverified files; this build is not a dev build.
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(
      join(root, 'config', 'policy.json'),
      JSON.stringify({ models: { allow_unverified_models: true, require_sha256_match: false } })
    )
    updateSettings(db, { developerMode: true })
    reread()
    expect(await check('rr', { hash: false })).toBe('ok') // the toggle is on
    lock()
    expect(await check('rr', { hash: false })).toBe('damaged') // locked: its settings can't be read
  })

  it('a check that comes with its service\'s manifest reads no manifest folder (#913 code review)', async () => {
    const root = tempRoot('start-check-factory')
    writeDriveFile(root, REL, 'reranker bytez') // a bit flip
    const m = validManifest({ id: 'rr', role: 'reranker', local_path: REL, sha256: sha256('reranker bytes') })
    expect(await computeInstallState(m, root, { developerMode: false })).toBe('checksum_failed') // a full check
    const check = createModelStartCheck({
      manifestsDir: null, // nothing to read: only the bound manifest can name the file
      paths: { rootPath: root, configPath: join(root, 'config') },
      isDev: false,
      getSettings: () => null,
      getDb: () => seededFreshDb('start-check-factory')
    })
    expect(await check('rr', { hash: false })).toBe('ok') // unbound: no manifest found, starts as before
    expect(await check('rr', { hash: false, manifest: m })).toBe('damaged')
  })
})

// #913 code review: the one re-arm helper. Unfiltered (the engine heal, `rearmLlamaConsumers`) it re-arms every role;
// filtered (a clean check or a download) only the roles whose model is in the list, so a check of an unrelated model
// leaves a latch, and a translator's session GPU fallback, alone.
describe('rearmStartRefusals (#913 code review)', () => {
  function targets() {
    const spies = { embedder: vi.fn(), reranker: vi.fn(), vision: vi.fn(), translator: vi.fn() }
    const ctx = {
      embedder: { id: 'e5', resetStartFailure: spies.embedder },
      reranker: { id: 'rr', resetStartFailure: spies.reranker },
      vision: { resetStartFailure: spies.vision },
      refreshTranslatorSlot: spies.translator
    } as unknown as RearmTargets
    const calls = (): string[] =>
      (Object.keys(spies) as Array<keyof typeof spies>).filter((k) => spies[k].mock.calls.length > 0)
    return { ctx, calls }
  }

  it.each([
    ['no filter (the engine heal)', undefined, ['embedder', 'reranker', 'vision', 'translator']],
    ['the search model', [{ id: 'e5', role: 'embeddings' }], ['embedder']],
    ['the re-ranking model', [{ id: 'rr', role: 'reranker' }], ['reranker']],
    ['an images model', [{ id: 'some-vision', role: 'vision' }], ['vision']],
    ['a translation model', [{ id: 'some-translation', role: 'translation' }], ['translator']],
    ['a chat model only', [{ id: 'qwen', role: 'chat' }], []],
    ['nothing checked clean', [], []]
  ] as const)('re-arms what was checked: %s', (_label, checked, expected) => {
    const { ctx, calls } = targets()
    rearmStartRefusals(ctx, checked)
    expect(calls()).toEqual(expected)
  })
})
