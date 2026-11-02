import { describe, it, expect } from 'vitest'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse, stringify } from 'yaml'
import { buildDriveNotices } from '../../../../scripts/lib/drive-notices.mjs'
import { modelManifestDocs, REPO_ROOT, repoText } from '../helpers/repo-files'

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

const NOTICES = join(REPO_ROOT, 'DRIVE-NOTICES.md')
const REGEN = 'run `node scripts/generate-drive-notices.mjs` and commit the result'

interface NoticesFixture {
  sources: Record<string, Record<string, unknown>>
  manifests: Record<string, Record<string, unknown>>
}

const noticesFixture = (): NoticesFixture => ({
  sources: {
    kiwix_tools: {
      version: '1',
      source_bundle: { dir: 'runtime/kiwix-tools/source', files: [{ name: 'a.tar.xz', sha256: 'abc' }] }
    },
    llama_cpp: { version: 'b1' },
    ocr: { version: '1' },
    whisper_cpp: { version: 'v1' }
  },
  manifests: { alpha: { id: 'alpha', display_name: 'Alpha', license: 'apache-2.0', local_path: 'models/chat/alpha.gguf' } }
})

/** The builder over a scratch repo: the real pinned license texts, the fixture's yaml. */
function buildFrom(f: NoticesFixture): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-drive-notices-'))
  cpSync(join(REPO_ROOT, 'licenses'), join(root, 'licenses'), { recursive: true })
  mkdirSync(join(root, 'model-manifests', 'chat'), { recursive: true })
  writeFileSync(join(root, 'model-manifests', 'runtime-sources.yaml'), stringify(f.sources))
  for (const [name, doc] of Object.entries(f.manifests)) {
    writeFileSync(join(root, 'model-manifests', 'chat', `${name}.yaml`), stringify(doc))
  }
  return buildDriveNotices(root)
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
    const sources = parse(repoText('model-manifests', 'runtime-sources.yaml')) as Record<
      string,
      { version?: string }
    >
    const families = Object.keys(sources)
    expect(families.length).toBeGreaterThanOrEqual(4) // llama_cpp + whisper_cpp + ocr + kiwix_tools today
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
    const manifests = modelManifestDocs().map(({ doc }) => doc)
    expect(manifests.length).toBeGreaterThanOrEqual(34) // the catalog today; grows only
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
    // #512: the LLVM OpenMP runtime the llama.cpp Windows archives redistribute since b11146.
    expect(text).toContain('LLVM OpenMP runtime (bundled in the llama.cpp Windows archives)')
    expect(text).toContain('The LLVM Project is under the Apache License v2.0 with LLVM Exceptions')
    // And the sibling notice files are referenced by name.
    expect(text).toContain('THIRD-PARTY-NOTICES.md')
  })

  it('carries the kiwix-tools copyleft section, the GPL-2.0 / LGPL-2.1 texts and the corresponding-source record', () => {
    const text = readFileSync(NOTICES, 'utf8')
    expect(text).toContain('### kiwix-tools 3.8.1 — GPL-3.0-or-later')
    expect(text).toContain('GPL-2.0-or-later, with GPL-3.0-or-later files')
    expect(text).toContain('runtime/kiwix-tools/source/')
    expect(text).toContain('SOURCES.md')
    expect(text).toContain('must not ship kiwix-tools')
    // The GPL-2.0 and LGPL-2.1 texts are inlined (kiwix-tools' first copyleft binaries).
    expect(text).toContain('GNU GENERAL PUBLIC LICENSE')
    expect(text).toContain('Version 2, June 1991')
    expect(text).toContain('GNU LESSER GENERAL PUBLIC LICENSE')
    expect(text).toContain('Version 2.1, February 1999')
    // Every pinned source-archive SHA-256 for the complete-corresponding-source record.
    expect(text).toContain('dd769c9bd3d75b59ad9e451b128187b128da6a10b1241bb2d0325fe4aafe51a3')
    expect(text).toContain('e232f42bba33561493e2d7318c3be60d8508e83a8891a8358135519dedc5ff5a')
    expect(text).toContain('7fa374f4714b23c43afa3fb406d7e21c483d77e8218895e1408e2f037969b6ea')
    expect(text).toContain('30d3518172084f310dab86d262b512718a7f9a13635aaa1a188e61dc26b2288c')
    expect(text).toContain('f0b1547b5a42a6c0f724e8e1c1cb5ce9c4c35fb495e7d780b9930d35011ceb4c')
  })

  it('names each copyleft component at the version the source bundle pins', () => {
    const { kiwix_tools } = parse(repoText('model-manifests', 'runtime-sources.yaml')) as {
      kiwix_tools: { source_bundle: { files: Array<{ component: string; version: string }> } }
    }
    const heading: Record<string, string> = {
      'kiwix-tools': '### kiwix-tools',
      libkiwix: '#### libkiwix',
      libzim: '#### libzim',
      'xapian-core': '#### Xapian',
      libmicrohttpd: '#### libmicrohttpd'
    }
    const files = kiwix_tools.source_bundle.files
    expect(files.map((f) => f.component)).toEqual(Object.keys(heading))
    const text = readFileSync(NOTICES, 'utf8')
    for (const f of files) expect(text, f.component).toContain(`${heading[f.component]} ${f.version} — `)
    expect(text).toContain('Five of the components above are copyleft')
  })
})

describe('buildDriveNotices refuses to write an incomplete file (LIC-1)', () => {
  it('builds the fixture, and a weight shard needs no pinned line (the positive behind the refusals)', () => {
    const f = noticesFixture()
    f.manifests.alpha.files = [{ local_path: 'models/chat/alpha-00002-of-00003.gguf' }]
    const text = buildFrom(f)
    expect(text).toContain('model: alpha apache-2.0')
    expect(text).not.toContain('also ships `models/chat/alpha-00002')
  })

  it.each<[string, (f: NoticesFixture) => void, string]>([
    ['a new runtime family', (f) => { f.sources.fifth = { version: '1' } }, 'runtime-sources.yaml families changed'],
    ['a family with no version', (f) => { delete f.sources.ocr.version }, 'family ocr has no version'],
    [
      'no source bundle for the copyleft binaries',
      (f) => { delete f.sources.kiwix_tools.source_bundle },
      'kiwix_tools.source_bundle is missing or malformed'
    ],
    [
      'an empty source bundle',
      (f) => { f.sources.kiwix_tools.source_bundle = { dir: 'x', files: [] } },
      'kiwix_tools.source_bundle is missing or malformed'
    ],
    ['a manifest with no display name', (f) => { delete f.manifests.alpha.display_name }, 'lacks id/display_name/license'],
    ['no model manifests', (f) => { f.manifests = {} }, 'no model manifests found'],
    [
      'an MIT weight with no pinned copyright line',
      (f) => { f.manifests.alpha.license = 'mit' },
      'no pinned upstream copyright line'
    ],
    [
      'an extra file with no pinned attribution',
      (f) => { f.manifests.alpha.files = [{ local_path: 'models/chat/alpha-vad.bin' }] },
      'has no pinned attribution'
    ]
  ])('refuses %s', (_title, edit, message) => {
    const f = noticesFixture()
    edit(f)
    expect(() => buildFrom(f)).toThrow(message)
  })
})
