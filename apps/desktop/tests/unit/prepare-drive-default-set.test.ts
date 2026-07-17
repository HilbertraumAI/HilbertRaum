import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// DOC-N4 (full audit 2026-06-28): the default-set model-id list is NOT in `assets.ts` — it lives
// only in the two `prepare-drive` shells (`$DefaultModelIds` in the .ps1, `DEFAULT_MODEL_IDS` in the
// .sh), which `--with-assets` provisions by default. There is no single source of truth the two
// import, so they can silently drift. This parity test pins the documented invariant: the two lists
// must match exactly (same ids, same order). See docs/packaging.md + docs/drive-layout.md.

const ROOT = join(__dirname, '../../../..')
const PS1 = join(ROOT, 'scripts/prepare-drive.ps1')
const SH = join(ROOT, 'scripts/prepare-drive.sh')

/** Slice the text between the opening `(` after `marker` and the matching closing `)` line. */
function blockAfter(text: string, marker: string): string {
  const start = text.indexOf(marker)
  if (start < 0) throw new Error(`marker not found: ${marker}`)
  const open = text.indexOf('(', start)
  const close = text.indexOf(')', open)
  if (open < 0 || close < 0) throw new Error(`array block not found after: ${marker}`)
  return text.slice(open + 1, close)
}

/** PowerShell `$DefaultModelIds = @( 'a', 'b' )` — pull every single-quoted id, in order. */
function ps1Ids(text: string): string[] {
  const block = blockAfter(text, '$DefaultModelIds = @')
  return [...block.matchAll(/'([^']+)'/g)].map((m) => m[1])
}

/** Bash `DEFAULT_MODEL_IDS=( a  # comment )` — one bare id per line, comments stripped. */
function shIds(text: string): string[] {
  const block = blockAfter(text, 'DEFAULT_MODEL_IDS=')
  return block
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter((line) => line.length > 0)
}

describe('prepare-drive default model set parity (DOC-N4)', () => {
  const ps1 = ps1Ids(readFileSync(PS1, 'utf8'))
  const sh = shIds(readFileSync(SH, 'utf8'))

  it('extracts a non-empty default set from each shell', () => {
    expect(ps1.length).toBeGreaterThan(0)
    expect(sh.length).toBe(ps1.length)
  })

  it('the .ps1 and .sh default-set ids match exactly (same ids, same order)', () => {
    // If this fails, one of scripts/prepare-drive.{ps1,sh} was edited without the other —
    // a Windows vs macOS/Linux drive would then provision a different default set.
    expect(sh).toEqual(ps1)
  })
})

// F-05 (full audit 2026-07-16): --with-assets used to fetch models + the llama.cpp and
// whisper.cpp runtimes but NEVER the `ocr` family, so every DIY drive shipped with an empty
// ocr/ dir and scanned-PDF/photo OCR was silently unavailable (open issue #59). Only
// build-commercial-drive fetched it. There is no canonical TS plan for the with-assets fetch
// CALL SET (drive.ts planPrepareDrive models layout/config/copies only — the with-assets
// orchestration lives solely in the two shells, per docs/packaging.md), so this parity net
// pins the invariant directly against the two scripts: both siblings' --with-assets block must
// invoke fetch-runtime for the ocr family, or a Windows-vs-mac/linux drive drifts on OCR again.
describe('prepare-drive --with-assets fetches the OCR family in both siblings (F-05)', () => {
  const ps1 = readFileSync(PS1, 'utf8')
  const sh = readFileSync(SH, 'utf8')

  it('prepare-drive.ps1 invokes fetch-runtime with -Family ocr', () => {
    expect(ps1).toMatch(/Family\s*=\s*'ocr'/)
  })

  it('prepare-drive.sh invokes fetch-runtime with --family ocr', () => {
    expect(sh).toMatch(/--family ocr\b/)
  })
})
