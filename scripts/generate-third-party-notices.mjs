#!/usr/bin/env node
// Generates THIRD-PARTY-NOTICES.md at the repo root (LIC-2, full-audit 2026-07-12).
//
//   node scripts/generate-third-party-notices.mjs
//
// The file aggregates license texts + copyright notices for every npm package that
// ships inside a packaged HilbertRaum artifact (app.asar production closure minus the
// electron-builder.yml exclusions, plus any renderer-bundled devDeps — see
// scripts/lib/shipped-packages.mjs for the exact derivation). electron-builder ships
// the file beside the app via `extraResources` (apps/desktop/electron-builder.yml).
//
// The output is DETERMINISTIC (sorted, no timestamps): rerunning on the same lockfile
// + node_modules is byte-identical, so the committed file only changes when the
// shipped dependency set (or a license text) actually changes.
// apps/desktop/tests/integration/third-party-notices.test.ts fails the gate when the
// committed file no longer matches the lockfile — regenerate + commit together with
// any dependency change.
//
// Run after `npm ci` (reads license files out of node_modules). No network, no deps
// beyond `yaml` (already a production dependency).

import { readFileSync, readdirSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeShippedPackages } from './lib/shipped-packages.mjs'
// LIC-3 (full-audit 2026-07-12b): verbatim license texts pinned from upstream at review
// time for shipped packages whose published tarball carries no license file, plus the
// leptonica license that tesseract.js-core's WASM statically links but does not
// reproduce. Kept in a lib so the freshness gate imports the same texts (see the file's
// doc comment for the pinning convention).
import { KNOWN_EXTRA_NOTICES, LEPTONICA_LICENSE } from './lib/extra-notices.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(repoRoot, 'THIRD-PARTY-NOTICES.md')

/** Normalize a text file for the notices document: LF endings, no BOM, no NUL. */
function cleanText(raw, source) {
  let t = raw.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (t.includes('\u0000')) throw new Error(`NUL byte in license text: ${source}`)
  return t.replace(/[ \t]+$/gm, '').trimEnd()
}

/**
 * Case-folded code-unit order (codepoint order for these ASCII names), NOT localeCompare
 * (REL-1, full-audit 2026-07-12b): this order feeds the byte-exact notices drift gate,
 * and no-locale localeCompare depends on the HOST ICU collation (dev = de-AT, CI = en/C).
 * Pure code-unit order would REORDER the committed file today (ICU's primary strength is
 * case-insensitive, so `cmaps` < `LICENSE` inside pdfjs-dist; raw code units put
 * `LICENSE` first) — so we case-fold first, which reproduces the committed
 * ICU-primary-strength order byte-identically, and tiebreak equal folds by raw code
 * units. `String.prototype.toLowerCase()` is locale-INDEPENDENT (Unicode default case
 * conversion — unlike toLocaleLowerCase), so this is fully deterministic across hosts
 * and ICU versions.
 */
function foldedCodepointCompare(a, b) {
  const fa = a.toLowerCase()
  const fb = b.toLowerCase()
  if (fa !== fb) return fa < fb ? -1 : 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * Find license/notice files in a package directory: LICENSE / LICENCE / COPYING /
 * NOTICE basenames (any case, any extension except code), including nested asset
 * copies (pdfjs-dist ships per-asset licenses under standard_fonts/, wasm/, cmaps/,
 * iccs/). Never descends into node_modules; depth-limited.
 */
function findLicenseFiles(pkgDir, depth = 0) {
  const out = []
  if (depth > 3) return out
  for (const entry of readdirSync(pkgDir, { withFileTypes: true }).sort((a, b) =>
    foldedCodepointCompare(a.name, b.name)
  )) {
    const p = join(pkgDir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules') out.push(...findLicenseFiles(p, depth + 1))
    } else if (
      /^(license|licence|copying|notice)/i.test(entry.name) &&
      !/\.(js|cjs|mjs|ts|d\.ts|map|json)$/i.test(entry.name)
    ) {
      out.push(p)
    }
  }
  return out
}

/** Wrap verbatim license text in a code fence that cannot collide with its content. */
function fence(text) {
  const runs = text.match(/`+/g) ?? []
  const longest = runs.reduce((m, r) => Math.max(m, r.length), 0)
  const f = '`'.repeat(Math.max(3, longest + 1))
  return `${f}\n${text}\n${f}`
}

function licenseIdOf(pkgJson) {
  const l = pkgJson.license ?? pkgJson.licenses
  if (typeof l === 'string') return l
  if (l && typeof l === 'object') {
    if (Array.isArray(l)) return l.map((x) => x.type ?? '?').join(' OR ')
    return l.type ?? '(unspecified)'
  }
  return '(unspecified)'
}

function authorOf(pkgJson) {
  const a = pkgJson.author
  if (typeof a === 'string') return a
  if (a && typeof a === 'object' && a.name) return a.name
  return null
}

function repositoryOf(pkgJson) {
  const r = pkgJson.repository
  const url = typeof r === 'string' ? r : r?.url
  if (!url) return null
  return url.replace(/^git\+/, '').replace(/\.git$/, '')
}

const packages = computeShippedPackages(repoRoot)

// REL-2 (full-audit 2026-07-12b): npm skips installing optionalDependencies whose os/cpu
// don't match the host, so a platform-gated optional in the shipped closure can be ABSENT
// from this host's node_modules while still shipping on the platform it targets. Such a
// package STAYS in the list — computeShippedPackages is lockfile-only, so the freshness
// gate (apps/desktop/tests/integration/third-party-notices.test.ts) recomputes the same
// list on every host regardless of what is installed; dropping it here would desync the
// generated file from the gate permanently. Instead its section falls back to lockfile
// metadata (with a warning) rather than crashing with ENOENT on the very machine the
// gate is demanding regeneration from. Empty on this host today.
const notInstalled = new Set(
  packages.filter((p) => !existsSync(join(repoRoot, p.lockPath, 'package.json')))
)
for (const p of notInstalled) {
  console.warn(
    `WARNING: ${p.name}@${p.version} is in the shipped closure but not installed on this ` +
      'host (platform-gated optional dependency?) — emitting its notices section from ' +
      'package-lock.json metadata; its license text cannot be reproduced here.'
  )
}

// Pre-scan license/notice files so the header can state the NOTICE situation truthfully.
const licenseFilesByPkg = new Map(
  packages.map((p) => [p, notInstalled.has(p) ? [] : findLicenseFiles(join(repoRoot, p.lockPath))])
)
const noticeCount = [...licenseFilesByPkg.values()]
  .flat()
  .filter((f) => /^notice/i.test(f.split(/[\\/]/).pop() ?? '')).length

const lines = []
lines.push('# Third-party notices')
lines.push('')
lines.push('HilbertRaum is licensed under GPL-3.0-or-later (see `LICENSE`). A packaged')
lines.push('HilbertRaum artifact additionally contains the third-party npm packages listed')
lines.push('below — the production dependency closure of `apps/desktop` that electron-builder')
lines.push('bundles into `app.asar`, minus the packages its `files:` negations exclude (the')
lines.push('never-imported mermaid chain and the `@napi-rs/canvas` native optional dep),')
lines.push('which is a superset of everything Vite inlines into the compiled renderer/main')
lines.push('bundles. This file reproduces each package\'s license text and copyright notice')
lines.push('as found in the shipped package, plus the SIL OFL 1.1 notice for the KaTeX fonts.')
lines.push('')
lines.push('Out of scope here: Electron itself (electron-builder ships Electron\'s own')
lines.push('`LICENSE.electron.txt` and `LICENSES.chromium.html` beside the executable) and')
lines.push('model weights / sidecar runtime binaries (never bundled into the app artifact;')
lines.push('their licenses are recorded per model in `model-manifests/` and ship with the')
lines.push('prepared drive). Apache-2.0 §4(d) `NOTICE` files are reproduced below whenever a')
lines.push('shipped package carries one' + (noticeCount === 0
  ? ' (none of the currently shipped packages does — verified at generation time).'
  : ` (${noticeCount} found at generation time).`))
lines.push('')
lines.push('This file is GENERATED — do not edit by hand. Regenerate after any dependency')
lines.push('change with:')
lines.push('')
lines.push('```')
lines.push('node scripts/generate-third-party-notices.mjs')
lines.push('```')
lines.push('')
lines.push(`## Shipped packages (${packages.length})`)
lines.push('')
lines.push('```')
for (const p of packages) lines.push(`${p.name}@${p.version}`)
lines.push('```')
lines.push('')
lines.push('## Licenses')

for (const p of packages) {
  const pkgDir = join(repoRoot, p.lockPath)
  if (notInstalled.has(p)) {
    // REL-2 fallback section (see above): keeps the gate's per-package section check
    // satisfied and the package honestly noticed even when this host cannot read it.
    lines.push('')
    lines.push(`### ${p.name}@${p.version}`)
    lines.push('')
    lines.push(`- License: ${p.lockLicense ?? '(unspecified)'} (from package-lock.json metadata)`)
    lines.push('')
    lines.push('This package was not installed on the host that regenerated this file (npm')
    lines.push('skips optional dependencies gated to another OS/CPU), so its license text')
    lines.push('could not be reproduced here. The license identifier above comes from the')
    lines.push('lockfile; see the published package for the full text.')
    continue
  }
  const pkgJson = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  lines.push('')
  lines.push(`### ${p.name}@${p.version}`)
  lines.push('')
  const meta = [`- License: ${licenseIdOf(pkgJson)}`]
  const author = authorOf(pkgJson)
  if (author) meta.push(`- Author: ${author}`)
  const repo = repositoryOf(pkgJson)
  if (repo) meta.push(`- Repository: ${repo}`)
  lines.push(...meta)

  const files = licenseFilesByPkg.get(p) ?? []
  if (files.length === 0) {
    // LIC-3 (full-audit 2026-07-12b): when the published tarball ships no license file,
    // a repository pointer alone cannot discharge the attribution duty on an offline
    // product — emit the text pinned from upstream at review time when we have one.
    // The map only kicks in on this no-license-file path, so if a future version of a
    // mapped package starts shipping a license file, the shipped file wins automatically.
    const extra = KNOWN_EXTRA_NOTICES[p.name]
    if (extra) {
      lines.push('')
      lines.push(`#### Pinned \`${licenseIdOf(pkgJson)}\` text (no license file in the published package)`)
      lines.push('')
      lines.push(
        'Text pinned at review time — the published package ships no license file ' +
          `(full-audit 2026-07-12b LIC-3). ${extra.comment}`
      )
      lines.push('')
      lines.push(fence(cleanText(extra.text, `KNOWN_EXTRA_NOTICES[${p.name}]`)))
    } else {
      lines.push('')
      lines.push(
        `No license file is distributed inside this package; it declares \`${licenseIdOf(pkgJson)}\`` +
          (repo ? ` — see its repository (${repo}) for the full text.` : '.')
      )
    }
  }
  for (const f of files) {
    const rel = relative(pkgDir, f).split('\\').join('/')
    const text = cleanText(readFileSync(f, 'utf8'), f)
    lines.push('')
    lines.push(`#### \`${rel}\``)
    lines.push('')
    lines.push(fence(text))
  }

  // KaTeX's package LICENSE is MIT, but the font files it ships (dist/fonts/KaTeX_*)
  // are licensed under the SIL Open Font License 1.1 — the copyright + license lines
  // below are taken verbatim from the fonts' own name tables (e.g.
  // KaTeX_Main-Regular.ttf). The full OFL 1.1 body is reproduced from the OFL copy
  // shipped in this same artifact (pdfjs-dist/standard_fonts/LICENSE_LIBERATION).
  if (p.name === 'katex') {
    lines.push('')
    lines.push('#### KaTeX fonts (`dist/fonts/KaTeX_*`) — SIL Open Font License 1.1')
    lines.push('')
    lines.push('The KaTeX font files shipped with this application carry the following')
    lines.push('notice in their font metadata:')
    lines.push('')
    lines.push(
      fence(
        'Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>)\n' +
          'Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>)\n' +
          '\n' +
          'This Font Software is licensed under the SIL Open Font License, Version 1.1.\n' +
          'This license is available with a FAQ at: http://scripts.sil.org/OFL'
      )
    )
    const oflSource = join(repoRoot, 'node_modules', 'pdfjs-dist', 'standard_fonts', 'LICENSE_LIBERATION')
    if (existsSync(oflSource)) {
      const ofl = cleanText(readFileSync(oflSource, 'utf8'), oflSource)
      const start = ofl.indexOf('SIL OPEN FONT LICENSE Version 1.1')
      if (start !== -1) {
        lines.push('')
        lines.push('The full SIL Open Font License, Version 1.1 (as also reproduced under')
        lines.push('`pdfjs-dist` above for the Liberation fonts):')
        lines.push('')
        lines.push(fence(ofl.slice(start)))
      }
    }
  }

  // tesseract.js-core's WASM binaries statically link the leptonica image-processing
  // library, but the published package reproduces only the tesseract-ocr Apache-2.0
  // LICENSE — an upstream packaging shortfall (LIC-3, full-audit 2026-07-12b). Append
  // leptonica's own license, pinned verbatim from the upstream repository at review
  // time (see scripts/lib/extra-notices.mjs), mirroring the KaTeX-fonts block above.
  if (p.name === 'tesseract.js-core') {
    lines.push('')
    lines.push('#### Leptonica (statically linked into the tesseract WASM binaries)')
    lines.push('')
    lines.push('The tesseract WASM binaries shipped in this package statically link the')
    lines.push('leptonica image-processing library, whose license the published package does')
    lines.push('not reproduce. Text pinned from the upstream repository')
    lines.push('(https://github.com/DanBloomberg/leptonica, `leptonica-license.txt`) at')
    lines.push('review time (full-audit 2026-07-12b LIC-3):')
    lines.push('')
    lines.push(fence(cleanText(LEPTONICA_LICENSE, 'LEPTONICA_LICENSE')))
  }
}
lines.push('')

const output = lines.join('\n')
if (output.includes('\u0000') || output.includes('\r')) {
  throw new Error('generated output must be LF-only and NUL-free')
}
const before = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null
writeFileSync(OUT_PATH, output, 'utf8')
console.log(
  `THIRD-PARTY-NOTICES.md: ${packages.length} packages, ${statSync(OUT_PATH).size} bytes` +
    (before === null ? ' (created)' : before === output ? ' (unchanged)' : ' (updated)')
)
