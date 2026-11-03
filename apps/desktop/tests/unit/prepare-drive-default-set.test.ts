import { describe, it, expect } from 'vitest'
import { repoText } from '../helpers/repo-files'
import { extractScriptArray } from '../helpers/script-legs'
import { committedManifests } from '../helpers/catalog'

// DOC-N4 (full audit 2026-06-28): the default-set model-id list is NOT in `assets.ts` — it lives
// only in the two `prepare-drive` shells (`$DefaultModelIds` in the .ps1, `DEFAULT_MODEL_IDS` in the
// .sh), which `--with-assets` provisions by default. There is no single source of truth the two
// import, so they can silently drift. This parity test pins the documented invariant: the two lists
// must match exactly (same ids, same order), id by id: the parser closes on a line that is exactly
// `)`, because the first `)` in either file sits in a comment on the first id. See docs/packaging.md
// + docs/drive-layout.md. That `--with-assets` fetches these ids, then both runtimes and the OCR files
// (F-05), is run on both twins in tests/integration/script-orchestration.test.ts.

const ps1Text = repoText('scripts', 'prepare-drive.ps1')
const shText = repoText('scripts', 'prepare-drive.sh')
const ps1 = extractScriptArray(ps1Text, '$DefaultModelIds = @(')
const sh = extractScriptArray(shText, 'DEFAULT_MODEL_IDS=(')

describe('prepare-drive default model set parity (DOC-N4)', () => {
  it('the .ps1 and .sh default-set ids match exactly (same ids, same order)', () => {
    // If this fails, one of scripts/prepare-drive.{ps1,sh} was edited without the other —
    // a Windows vs macOS/Linux drive would then provision a different default set.
    expect(ps1).toHaveLength(5)
    expect(sh).toEqual(ps1)
  })

  it('every default-set id is a committed manifest --with-assets can actually fetch', () => {
    const byId = new Map(committedManifests().map((m) => [m.id, m]))
    for (const id of ps1) {
      const m = byId.get(id)
      expect(m, `${id}: no committed manifest`).toBeDefined()
      expect(m!.download, `${id}: no download block`).toBeDefined()
      expect(m!.download!.withdrawn, `${id}: source withdrawn`).toBeUndefined()
      expect(m!.licenseReview.status, `${id}: license review`).toBe('approved')
    }
  })
})
