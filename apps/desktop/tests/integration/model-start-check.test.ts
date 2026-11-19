import { describe, it, expect } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  checksumCacheStats,
  computeInstallState,
  createSettingsHashStore,
  invalidateChecksum
} from '../../src/main/services/models'
import { createModelStartCheck } from '../../src/main/services/model-start-check'
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
})
