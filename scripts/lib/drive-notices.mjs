// Shared builder for DRIVE-NOTICES.md (LIC-1, full-audit 2026-07-12b) — the drive-root
// license/attribution notices for everything a prepared drive carries OUTSIDE the
// packaged app: the sidecar runtime binaries (llama.cpp, whisper.cpp), the SDL2.dll the
// whisper Windows archive bundles, the OCR language data, and the model weights described
// by the manifests under model-manifests/. Kept as a lib (the shipped-packages.mjs
// precedent) so the vitest freshness gate
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

  // --- Runtime families (names + pinned versions come from the yaml, never hardcoded) ---
  const runtimeSources = parse(
    readFileSync(join(repoRoot, 'model-manifests', 'runtime-sources.yaml'), 'utf8')
  )
  const families = Object.keys(runtimeSources).sort(foldedCodepointCompare)
  const knownFamilies = ['llama_cpp', 'ocr', 'whisper_cpp']
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
  lines.push('packaged application: the sidecar runtime binaries (llama.cpp, whisper.cpp), the')
  lines.push('OCR language data, and the model weights described by the manifests under')
  lines.push('`model-manifests/`.')
  lines.push('')
  lines.push('- **HilbertRaum itself** is free software under **GPL-3.0-or-later** — the full')
  lines.push('  license text ships as `LICENSE` at this drive\'s root. The complete corresponding')
  lines.push('  source code is available at https://github.com/HilbertraumAI/HilbertRaum.')
  lines.push('- **Third-party npm packages bundled inside the application** are covered by')
  lines.push('  `THIRD-PARTY-NOTICES.md`, also at this drive\'s root.')
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
