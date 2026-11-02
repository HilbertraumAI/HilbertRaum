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
// + docs/drive-layout.md.

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

// F-05 (full audit 2026-07-16): --with-assets used to fetch models + the llama.cpp and
// whisper.cpp runtimes but NEVER the `ocr` family, so every DIY drive shipped with an empty
// ocr/ dir and scanned-PDF/photo OCR was silently unavailable (open issue #59). Only
// build-commercial-drive fetched it. There is no canonical TS plan for the with-assets fetch
// CALL SET (drive.ts holds the layout and the config shapes only — the with-assets
// orchestration lives solely in the two shells, per docs/packaging.md), so this parity net
// pins the invariant directly against the two scripts: both siblings' --with-assets block must
// invoke fetch-runtime for the ocr family, or a Windows-vs-mac/linux drive drifts on OCR again.
describe('prepare-drive --with-assets fetches the OCR family in both siblings (F-05)', () => {
  it('prepare-drive.ps1 invokes fetch-runtime with -Family ocr', () => {
    expect(ps1Text).toMatch(/Family\s*=\s*'ocr'/)
    expect(ps1Text).toContain('Invoke-FetchScript $fetchRuntime $ocrArgs')
  })

  it('prepare-drive.sh invokes fetch-runtime with --family ocr', () => {
    expect(shText).toMatch(/--family ocr\b/)
  })
})
