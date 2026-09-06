// Shared builder for DRIVE-NOTICES.md (LIC-1, full-audit 2026-07-12b) — the drive-root
// license/attribution notices for everything a prepared drive carries OUTSIDE the
// packaged app: the sidecar runtime binaries (llama.cpp, whisper.cpp, kiwix-tools), the
// SDL2.dll the whisper Windows archive bundles, the OCR language data, and the model
// weights described by the manifests under model-manifests/. Kept as a lib (the
// shipped-packages.mjs precedent) so the vitest freshness gate
// (apps/desktop/tests/integration/drive-notices.test.ts) recomputes the EXACT output the
// generator writes and fails while the committed file is stale.
//
// The output is DETERMINISTIC (sorted with the case-folded code-unit comparator — see the
// REL-1 note in generate-third-party-notices.mjs — no timestamps, no locale-dependent
// calls): rerunning on the same manifests + pinned license texts is byte-identical on
// every host/locale. Everything in the file is DERIVED from the repo's own records:
// model-manifests/**/*.yaml (attribution lines), model-manifests/runtime-sources.yaml
// (family names + pinned versions), and licenses/*.txt (the texts pinned at
// license-review time because the upstream release archives ship no license file).

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

/** Case-folded code-unit order (REL-1 — locale-independent; see the third-party generator). */
function foldedCodepointCompare(a, b) {
  const fa = a.toLowerCase()
  const fb = b.toLowerCase()
  if (fa !== fb) return fa < fb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/** Normalize a pinned text: LF endings, no BOM; NUL is a hard error (repo hygiene). */
function cleanText(raw, source) {
  const t = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (t.includes(String.fromCharCode(0))) throw new Error(`NUL byte in pinned text: ${source}`)
  return t.trimEnd()
}

/**
 * Pinned upstream copyright lines for MIT-licensed model WEIGHTS (reviewer should-fix,
 * full-audit 2026-07-12b LIC-1 follow-up). MIT requires the copyright notice to accompany
 * copies, and a `license_url` cannot discharge that on an offline product (the exact
 * model-policy.md argument against URL-only attribution) — and both current MIT models
 * are in the DEFAULT pre-loaded set of a sold drive. The repo's review records
 * (docs/model-policy.md) name the licenses but not the verbatim lines, so these are
 * pinned as published upstream at pin time (the SDL2 convention, licenses/README.md):
 * github.com/openai/whisper LICENSE and github.com/microsoft/unilm LICENSE (the
 * intfloat/multilingual-e5 upstream). Adding a new `license: mit` manifest REQUIRES
 * adding its line here — the builder throws otherwise, so an unattributed MIT weight
 * can never ship silently.
 */
const MIT_WEIGHT_COPYRIGHTS = {
  'multilingual-e5-small-q8':
    'Copyright (c) Microsoft Corporation (github.com/microsoft/unilm, the multilingual-e5 upstream)',
  'whisper-small-multilingual': 'Copyright (c) 2022 OpenAI (github.com/openai/whisper)'
}

/** Wrap verbatim license text in a code fence that cannot collide with its content. */
function fence(text) {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}\n${text}\n${f}`
}

// #339 P8-1: the five copyleft components of the kiwix-tools 3.8.1 build whose complete
// corresponding source a preloaded Kit must carry, with the SHA-256 of each pinned source
// archive (from tmp/339-kiwix-provisioning-plan.md §2, read from the kiwix-build recipe
// pins and the upstream release directories). P8-4 (#339) moves this to
// runtime-sources.yaml `source_bundle:` and reads it from there; the DIRECTORY is pending
// the owner's layout ruling on #339.
const KIWIX_SOURCE_DIR = 'runtime/kiwix-tools/source/'
const KIWIX_SOURCE_ARCHIVES = [
  ['kiwix-tools-3.8.1.tar.xz', 'dd769c9bd3d75b59ad9e451b128187b128da6a10b1241bb2d0325fe4aafe51a3'],
  ['libkiwix-14.1.1.tar.xz', 'e232f42bba33561493e2d7318c3be60d8508e83a8891a8358135519dedc5ff5a'],
  ['libzim-9.4.0.tar.xz', '7fa374f4714b23c43afa3fb406d7e21c483d77e8218895e1408e2f037969b6ea'],
  ['xapian-core-1.4.23.tar.xz', '30d3518172084f310dab86d262b512718a7f9a13635aaa1a188e61dc26b2288c'],
  ['libmicrohttpd-0.9.76.tar.gz', 'f0b1547b5a42a6c0f724e8e1c1cb5ce9c4c35fb495e7d780b9930d35011ceb4c']
]

/** Recursively list *.yaml/*.yml under dir in deterministic order. */
function walkYaml(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    foldedCodepointCompare(a.name, b.name)
  )) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walkYaml(p))
    else if (/\.ya?ml$/i.test(entry.name)) out.push(p)
  }
  return out
}

/**
 * Build the full DRIVE-NOTICES.md content for the repo at `repoRoot`. Throws (rather than
 * emitting a silently incomplete file) when runtime-sources.yaml gains/loses a family this
 * builder has no prose for, or a model manifest lacks the fields an attribution line needs.
 */
export function buildDriveNotices(repoRoot) {
  const pinned = (name) =>
    cleanText(readFileSync(join(repoRoot, 'licenses', name), 'utf8'), `licenses/${name}`)
  const llamaMit = pinned('llama.cpp-MIT.txt')
  const whisperMit = pinned('whisper.cpp-MIT.txt')
  const sdlZlib = pinned('SDL2-zlib.txt')
  const apache = pinned('Apache-2.0.txt')
  // #339 P8-1: kiwix-tools' copyleft + attribution-only components.
  const gpl2 = pinned('GPL-2.0.txt')
  const lgpl21 = pinned('LGPL-2.1.txt')
  const curlLicense = pinned('curl.txt')
  const icuLicense = pinned('ICU-Unicode.txt')
  const docoptMit = pinned('docopt-MIT.txt')
  const pugixmlMit = pinned('pugixml-MIT.txt')
  const zlibLicense = pinned('zlib.txt')
  const zstdBsd = pinned('zstd-BSD-3-Clause.txt')
  const xzCopying = pinned('xz-COPYING.txt')

  // --- Runtime families (names + pinned versions come from the yaml, never hardcoded) ---
  const runtimeSources = parse(
    readFileSync(join(repoRoot, 'model-manifests', 'runtime-sources.yaml'), 'utf8')
  )
  const families = Object.keys(runtimeSources).sort(foldedCodepointCompare)
  const knownFamilies = ['kiwix_tools', 'llama_cpp', 'ocr', 'whisper_cpp']
  if (JSON.stringify(families) !== JSON.stringify(knownFamilies)) {
    throw new Error(
      `runtime-sources.yaml families changed (${families.join(', ')} vs known ` +
        `${knownFamilies.join(', ')}) — extend scripts/lib/drive-notices.mjs (and ` +
        'licenses/) to cover the new/removed family before regenerating'
    )
  }
  const versionOf = (family) => {
    const v = runtimeSources[family]?.version
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`runtime-sources.yaml: family ${family} has no version`)
    }
    return v
  }

  // --- Model manifests (one attribution line per manifest, ALL roles) ---
  const models = []
  for (const file of walkYaml(join(repoRoot, 'model-manifests'))) {
    const parsed = parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || !('local_path' in parsed)) continue // runtime-sources.yaml
    const { id, display_name: name, license } = parsed
    if (!id || !name || !license) {
      throw new Error(`model manifest ${file} lacks id/display_name/license`)
    }
    const url = parsed.download?.url ?? null
    models.push({
      id: String(id),
      name: String(name),
      license: String(license),
      // The upstream repo is the download URL up to the file path (HF `/resolve/` form).
      upstream: url ? String(url).split('/resolve/')[0] : null,
      licenseUrl: parsed.download?.license_url ? String(parsed.download.license_url) : null,
      reviewStatus: parsed.license_review?.status ? String(parsed.license_review.status) : 'missing'
    })
  }
  models.sort((a, b) => foldedCodepointCompare(a.id, b.id))
  if (models.length === 0) throw new Error('no model manifests found under model-manifests/')

  const byLicense = new Map()
  for (const m of models) {
    if (!byLicense.has(m.license)) byLicense.set(m.license, [])
    byLicense.get(m.license).push(m)
  }
  const licenseKeys = [...byLicense.keys()].sort(foldedCodepointCompare)

  const lines = []
  lines.push('# Drive notices — licenses & attribution')
  lines.push('')
  lines.push('This file covers everything a prepared HilbertRaum drive carries OUTSIDE the')
  lines.push('packaged application: the sidecar runtime binaries (llama.cpp, whisper.cpp,')
  lines.push('kiwix-tools), the OCR language data, and the model weights described by the')
  lines.push('manifests under `model-manifests/`.')
  lines.push('')
  lines.push('- **HilbertRaum itself** is free software under **GPL-3.0-or-later** — the full')
  lines.push('  license text ships as `LICENSE` at this drive\'s root. The complete corresponding')
  lines.push('  source code is available at https://github.com/HilbertraumAI/HilbertRaum.')
  lines.push('- **Third-party npm packages bundled inside the application** are covered by')
  lines.push('  `THIRD-PARTY-NOTICES.md`, also at this drive\'s root.')
  lines.push('- **kiwix-tools** (the knowledge-pack tools) is **copyleft** — its licence terms and')
  lines.push('  the complete corresponding source for its GPL/LGPL components are recorded in the')
  lines.push('  "Runtime binaries and data" section below.')
  lines.push('')
  lines.push('This file is GENERATED — do not edit by hand. It is derived from the committed')
  lines.push('model manifests (`model-manifests/**/*.yaml`), the runtime pin file')
  lines.push('(`model-manifests/runtime-sources.yaml`), and the license texts pinned under')
  lines.push('`licenses/` (the upstream binary release archives ship no license file — see')
  lines.push('`licenses/README.md`). Regenerate with:')
  lines.push('')
  lines.push('```')
  lines.push('node scripts/generate-drive-notices.mjs')
  lines.push('```')
  lines.push('')
  lines.push('## Coverage (machine-readable)')
  lines.push('')
  lines.push('```')
  for (const fam of families) lines.push(`runtime-family: ${fam} ${versionOf(fam)}`)
  for (const m of models) lines.push(`model: ${m.id} ${m.license}`)
  lines.push('```')
  lines.push('')
  lines.push('## Runtime binaries and data')
  lines.push('')
  lines.push(`### llama.cpp ${versionOf('llama_cpp')} — MIT`)
  lines.push('')
  lines.push('The `llama-server` binaries under `runtime/llama.cpp/<os>/` are prebuilt release')
  lines.push('assets of the MIT-licensed `ggml-org/llama.cpp` project')
  lines.push(`(https://github.com/ggml-org/llama.cpp), pinned at release ${versionOf('llama_cpp')}`)
  lines.push('(license review: `docs/model-policy.md`). The upstream archives ship no license')
  lines.push('file, so the MIT text was pinned in-repo at review time (`licenses/llama.cpp-MIT.txt`):')
  lines.push('')
  lines.push(fence(llamaMit))
  lines.push('')
  lines.push(`### whisper.cpp ${versionOf('whisper_cpp')} — MIT`)
  lines.push('')
  lines.push('The `whisper-cli` transcriber binaries under `runtime/whisper.cpp/<os>/` are built')
  lines.push('from the MIT-licensed `ggml-org/whisper.cpp` project')
  lines.push(`(https://github.com/ggml-org/whisper.cpp), pinned at release ${versionOf('whisper_cpp')}`)
  lines.push('(Windows: the upstream prebuilt archive; macOS/Linux: compiled from the same pinned')
  lines.push('source — license review: `docs/model-policy.md`). The pinned MIT text')
  lines.push('(`licenses/whisper.cpp-MIT.txt`):')
  lines.push('')
  lines.push(fence(whisperMit))
  lines.push('')
  lines.push('#### SDL2 (bundled in the whisper.cpp Windows archive) — zlib')
  lines.push('')
  lines.push('The upstream whisper.cpp Windows archive redistributes `SDL2.dll` (used only by the')
  lines.push('upstream demo tools; recorded in the whisper.cpp license review,')
  lines.push('`docs/model-policy.md`). SDL2 is under the zlib license (`licenses/SDL2-zlib.txt`):')
  lines.push('')
  lines.push(fence(sdlZlib))
  lines.push('')
  lines.push(`### kiwix-tools ${versionOf('kiwix_tools')} — GPL-3.0-or-later`)
  lines.push('')
  lines.push('The `kiwix-serve`, `kiwix-manage` and `kiwix-search` programs under')
  lines.push('`runtime/kiwix-tools/<os>/` are prebuilt release artifacts of the kiwix-tools project')
  lines.push('(https://github.com/kiwix/kiwix-tools), pinned at release')
  lines.push(`${versionOf('kiwix_tools')} and published at`)
  lines.push('https://download.kiwix.org/release/kiwix-tools/ (license review:')
  lines.push('`docs/model-policy.md`). They power the optional knowledge-pack feature; a drive may')
  lines.push('ship without them.')
  lines.push('')
  lines.push('kiwix-tools is licensed **GPL-3.0-or-later**. The full GNU General Public License v3')
  lines.push('text ships as `LICENSE` at this drive\'s root — the same text that licenses HilbertRaum')
  lines.push('itself.')
  lines.push('')
  lines.push('These are STATICALLY LINKED builds: the libraries below are compiled into the')
  lines.push('executables, so their terms apply to the binaries you received here. Versions are as')
  lines.push('reported by `kiwix-serve --version` at the pinned release and by the kiwix-build')
  lines.push('recipe for that build.')
  lines.push('')
  lines.push('#### libkiwix 14.1.1 — GPL-3.0-or-later')
  lines.push('')
  lines.push('Read from the pinned source tree (`COPYING` = GPL-3; 43 source files "version 3 … or')
  lines.push('(at your option) any later version", one file GPL-2.0-or-later). Text: `LICENSE` at')
  lines.push('this drive\'s root.')
  lines.push('')
  lines.push('#### libzim 9.4.0 — GPL-2.0-or-later, with GPL-3.0-or-later files')
  lines.push('')
  lines.push('Read from the pinned source tree: `COPYING` = GPL-2, and the per-file headers are')
  lines.push('mixed — 74 files GPL-2.0-or-later, 16 files GPL-3.0-or-later. The combined work is')
  lines.push('therefore effectively GPL-3.0-or-later, but libzim itself is NOT wholly GPL-3.')
  lines.push('GPL-2.0 text:')
  lines.push('')
  lines.push(fence(gpl2))
  lines.push('')
  lines.push('#### Xapian 1.4.23 — GPL-2.0-or-later')
  lines.push('')
  lines.push('The search-index library `kiwix-serve` uses for full-text queries. GPL-2.0 text as')
  lines.push('above (`licenses/GPL-2.0.txt`).')
  lines.push('')
  lines.push('#### libmicrohttpd 0.9.76 — LGPL-2.1-or-later')
  lines.push('')
  lines.push('The HTTP server `kiwix-serve` embeds. Statically linked, so the LGPL\'s relinking')
  lines.push('condition applies: the corresponding source below lets you rebuild it.')
  lines.push('')
  lines.push(fence(lgpl21))
  lines.push('')
  lines.push('#### libcurl 8.4.0 — curl license')
  lines.push('')
  lines.push('The HTTP client library `kiwix-serve` links for outbound requests. Attribution-only')
  lines.push('(no copyleft):')
  lines.push('')
  lines.push(fence(curlLicense))
  lines.push('')
  lines.push('#### ICU 74 — Unicode/ICU license')
  lines.push('')
  lines.push('Unicode text handling; the five `icu*74.dll` files sit beside the executables in the')
  lines.push('Windows bundle (the other builds link it statically). Attribution-only:')
  lines.push('')
  lines.push(fence(icuLicense))
  lines.push('')
  lines.push('#### docopt.cpp 0.6.3 — MIT')
  lines.push('')
  lines.push('Command-line argument parsing for the kiwix-tools executables. MIT/Boost dual;')
  lines.push('taken under MIT:')
  lines.push('')
  lines.push(fence(docoptMit))
  lines.push('')
  lines.push('#### pugixml 1.15 — MIT')
  lines.push('')
  lines.push('XML parsing used by libkiwix. Attribution-only:')
  lines.push('')
  lines.push(fence(pugixmlMit))
  lines.push('')
  lines.push('#### zlib 1.3.1 — zlib license')
  lines.push('')
  lines.push('Compression used by libkiwix. A *different* copyright line from the SDL2 zlib text')
  lines.push('above, so it is pinned separately:')
  lines.push('')
  lines.push(fence(zlibLicense))
  lines.push('')
  lines.push('#### Zstandard 1.5.7 — BSD-3-Clause')
  lines.push('')
  lines.push('Compression used by libzim. BSD-3-Clause/GPL-2.0 dual; taken under BSD-3-Clause:')
  lines.push('')
  lines.push(fence(zstdBsd))
  lines.push('')
  lines.push('#### xz / liblzma 5.2.6 — public domain')
  lines.push('')
  lines.push('Compression used by libzim. Per the pinned `COPYING`, liblzma itself is in the public')
  lines.push('domain (the 0BSD relicensing of xz came in a later release than 5.2.6):')
  lines.push('')
  lines.push(fence(xzCopying))
  lines.push('')
  lines.push('#### Complete corresponding source')
  lines.push('')
  lines.push('Five of the components above are copyleft — kiwix-tools, libkiwix, libzim, Xapian and')
  lines.push('libmicrohttpd — so the complete corresponding source for the binaries on this drive is')
  lines.push('provided with them. On a preloaded HilbertRaum Kit the upstream source archives sit in')
  lines.push(`the \`${KIWIX_SOURCE_DIR}\` directory of this drive (layout per the owner's ruling on`)
  lines.push('issue #339), each verifiable against the SHA-256 recorded here:')
  lines.push('')
  lines.push('```')
  const kiwixNameWidth = Math.max(...KIWIX_SOURCE_ARCHIVES.map(([name]) => name.length)) + 3
  for (const [name, sha] of KIWIX_SOURCE_ARCHIVES) {
    lines.push(`${name.padEnd(kiwixNameWidth)}${sha}`)
  }
  lines.push('```')
  lines.push('')
  lines.push('If you obtained these programs by installing them from inside HilbertRaum instead,')
  lines.push('they were downloaded from the Kiwix project\'s own server at the URLs pinned in')
  lines.push('`model-manifests/runtime-sources.yaml`, and the same source archives are published by')
  lines.push('their upstream projects at the addresses recorded in `docs/model-policy.md` ("Sidecar')
  lines.push('binaries — kiwix-tools"), which also records the kiwix-build recipe the')
  lines.push(`${versionOf('kiwix_tools')} binaries were produced from. This record applies to the`)
  lines.push('binaries as pinned above; nothing here requires network access to read.')
  lines.push('')
  lines.push(`### OCR language data ${versionOf('ocr')} — Apache-2.0`)
  lines.push('')
  lines.push('The `ocr/*.traineddata.gz` language files are the tesseract-ocr project\'s')
  lines.push('traineddata (the integerized tessdata_best variant, repackaged by the tesseract.js')
  lines.push('project as `@tesseract.js-data/*`), licensed **Apache-2.0** (license review:')
  lines.push('`docs/model-policy.md`). The full Apache License 2.0 text is reproduced once in the')
  lines.push('"Apache License 2.0" section at the end of this file.')
  lines.push('')
  lines.push('## Model weights')
  lines.push('')
  lines.push('One attribution line per model manifest shipped under `model-manifests/` (the')
  lines.push('manifests are always on the drive; whether a weight is pre-loaded varies by drive).')
  lines.push('Grouped by the license each manifest declares; each line\'s license URL is the')
  lines.push('manifest\'s recorded `download.license_url`. A `license_review.status` other than')
  lines.push('`approved` is noted on the line — such a model is never pre-loaded on a sold drive')
  lines.push('(the sell gate requires an approved review for every manifest).')
  for (const license of licenseKeys) {
    const group = byLicense.get(license)
    lines.push('')
    lines.push(`### ${license} (${group.length} ${group.length === 1 ? 'model' : 'models'})`)
    lines.push('')
    if (license === 'apache-2.0') {
      lines.push('Licensed under the Apache License 2.0 — the full text is reproduced once in the')
      lines.push('"Apache License 2.0" section at the end of this file.')
    } else if (license === 'mit') {
      lines.push('Licensed under the MIT license — the MIT text is reproduced verbatim in the')
      lines.push('llama.cpp section above. MIT requires the copyright notice to accompany copies,')
      lines.push('so each line below carries its model\'s upstream copyright line, pinned at')
      lines.push('review time (as published upstream — the `licenses/README.md` convention).')
    } else {
      lines.push('Not covered by a permissive text reproduced in this file — see each line\'s')
      lines.push('license URL for the governing terms and the manifest\'s `license_review` block')
      lines.push('for the review record.')
    }
    lines.push('')
    for (const m of group) {
      const mitCopyright = license === 'mit' ? MIT_WEIGHT_COPYRIGHTS[m.id] : null
      if (license === 'mit' && !mitCopyright) {
        throw new Error(
          `MIT model manifest ${m.id} has no pinned upstream copyright line — add it to ` +
            'MIT_WEIGHT_COPYRIGHTS in scripts/lib/drive-notices.mjs (MIT attribution must ' +
            'not depend on resolving a URL on an offline product)'
        )
      }
      lines.push(
        `- ${m.name} (\`${m.id}\`) — upstream: ${m.upstream ?? '(no download block — see the manifest)'}` +
          ` — license: ${m.license}${m.licenseUrl ? ` (${m.licenseUrl})` : ''}` +
          (mitCopyright ? ` — ${mitCopyright}` : '') +
          (m.reviewStatus === 'approved' ? '' : ` — license_review.status: ${m.reviewStatus}`)
      )
    }
  }
  lines.push('')
  lines.push('## Apache License 2.0')
  lines.push('')
  lines.push('The full text (`licenses/Apache-2.0.txt`), applying to every artifact marked')
  lines.push('Apache-2.0 above:')
  lines.push('')
  lines.push(fence(apache))
  lines.push('')

  const output = lines.join('\n')
  if (output.includes(String.fromCharCode(0)) || output.includes('\r')) {
    throw new Error('generated output must be LF-only and NUL-free')
  }
  return output
}
