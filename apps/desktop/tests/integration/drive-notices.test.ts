import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildDriveNotices } from '../../../../scripts/lib/drive-notices.mjs'

// LIC-1 (full-audit 2026-07-12b): DRIVE-NOTICES.md is the drive-root license/attribution
// file for everything a prepared drive carries OUTSIDE the packaged app — the llama.cpp /
// whisper.cpp sidecar binaries (MIT, texts pinned under licenses/ because the upstream
// archives ship none), the SDL2.dll the whisper Windows archive bundles (zlib), the OCR
// traineddata (Apache-2.0), one attribution line per model manifest, and the app's own
// GPL source-availability statement. prepare-drive copies the COMMITTED file to the drive
// root and the sell gate requires it, so these tests keep it honest:
//  - freshness: the committed file must be byte-identical to a regeneration (the same
//    computation the generator runs — scripts/lib/drive-notices.mjs);
//  - coverage: every runtime family in runtime-sources.yaml and EVERY model manifest must
//    appear, both re-derived here straight from the YAML (independent of the generator's
//    own walk, so a generator bug that silently drops a manifest fails HERE, not just in
//    the byte-compare).

const REPO_ROOT = join(__dirname, '..', '..', '..', '..')
const NOTICES = join(REPO_ROOT, 'DRIVE-NOTICES.md')
const REGEN = 'run `node scripts/generate-drive-notices.mjs` and commit the result'

/** Recursively list *.yaml/*.yml under dir (independent of the generator's walk). */
function walkYaml(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkYaml(p))
    else if (/\.ya?ml$/i.test(entry.name)) out.push(p)
  }
  return out
}

describe('DRIVE-NOTICES.md ships and stays fresh (LIC-1)', () => {
  it('exists, is non-trivial, and is byte-clean (LF-only, no NUL, no BOM)', () => {
    expect(existsSync(NOTICES), `DRIVE-NOTICES.md missing — ${REGEN}`).toBe(true)
    const raw = readFileSync(NOTICES)
    expect(raw.byteLength).toBeGreaterThan(15 * 1024) // Apache-2.0 alone is ~11 KB
    expect(raw.includes(0), 'literal NUL byte in DRIVE-NOTICES.md').toBe(false)
    expect(raw.includes(0x0d), 'CR line ending in DRIVE-NOTICES.md').toBe(false)
    expect(raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf, 'UTF-8 BOM').toBe(false)
  })

  it('is byte-identical to a regeneration from the manifests + pinned licenses', () => {
    expect(
      readFileSync(NOTICES, 'utf8'),
      `DRIVE-NOTICES.md is STALE (a manifest, the runtime pin, or a pinned license text changed) — ${REGEN}`
    ).toBe(buildDriveNotices(REPO_ROOT))
  })

  it('covers every runtime family pinned in runtime-sources.yaml', () => {
    const sources = parse(
      readFileSync(join(REPO_ROOT, 'model-manifests', 'runtime-sources.yaml'), 'utf8')
    ) as Record<string, { version?: string }>
    const families = Object.keys(sources)
    expect(families.length).toBeGreaterThanOrEqual(3) // llama_cpp + whisper_cpp + ocr today
    const text = readFileSync(NOTICES, 'utf8')
    for (const family of families) {
      expect(
        text.includes(`runtime-family: ${family} ${sources[family].version}`),
        `runtime family ${family}@${sources[family].version} missing from the coverage block — ${REGEN}`
      ).toBe(true)
    }
  })

  it('carries an attribution line for EVERY model manifest (all roles)', () => {
    const text = readFileSync(NOTICES, 'utf8')
    const manifests = walkYaml(join(REPO_ROOT, 'model-manifests'))
      .map((p) => parse(readFileSync(p, 'utf8')) as Record<string, unknown>)
      .filter((m) => m && typeof m === 'object' && 'local_path' in m) // skip runtime-sources.yaml
    expect(manifests.length).toBeGreaterThanOrEqual(15) // the catalog today; grows only
    for (const m of manifests) {
      expect(
        text.includes(`model: ${m.id} ${m.license}`),
        `manifest ${m.id} missing from the coverage block — ${REGEN}`
      ).toBe(true)
      expect(
        text.includes(`(\`${m.id}\`)`),
        `manifest ${m.id} has no attribution line — ${REGEN}`
      ).toBe(true)
    }
  })

  it('carries the GPL source-availability statement and the pinned license texts', () => {
    const text = readFileSync(NOTICES, 'utf8')
    // GPLv3 §6 posture: the app's license + where the corresponding source lives.
    expect(text).toContain('GPL-3.0-or-later')
    expect(text).toContain('https://github.com/HilbertraumAI/HilbertRaum')
    // The pinned MIT text (llama.cpp/whisper.cpp binaries) is actually inlined…
    expect(text).toContain('Permission is hereby granted, free of charge')
    expect(text).toContain('Copyright (c) 2023-2024 The ggml authors')
    // …and the MIT model WEIGHTS carry their pinned upstream copyright lines (reviewer
    // should-fix: MIT attribution must not depend on resolving a URL on an offline product).
    expect(text).toContain('Copyright (c) 2022 OpenAI')
    expect(text).toContain('Copyright (c) Microsoft Corporation')
    // …as are the Apache-2.0 full text and the SDL2 zlib text.
    expect(text).toContain('Apache License')
    expect(text).toContain('Version 2.0, January 2004')
    expect(text).toContain("This software is provided 'as-is'")
    // And the sibling notice files are referenced by name.
    expect(text).toContain('THIRD-PARTY-NOTICES.md')
  })
})
