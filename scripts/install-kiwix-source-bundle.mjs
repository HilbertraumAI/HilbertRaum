#!/usr/bin/env node
// Installs the kiwix-tools corresponding-source bundle onto a drive (#339 P8-4).
//
//   node scripts/install-kiwix-source-bundle.mjs --target <drive root> --source-dir <archive dir> \
//       [--manifest <runtime-sources.yaml>] [--dry-run]
//
// Reads `kiwix_tools.source_bundle` from model-manifests/runtime-sources.yaml (the single
// source of truth for names/digests/sizes/URLs/grants — see the yaml's own comment above that
// block), copies + re-verifies each pinned copyleft source archive from --source-dir into
// <target>/<bundle.dir>/, and writes a generated SOURCES.md there. That directory + record is
// exactly what apps/desktop/src/main/services/commercial-drive.ts `checkSourceBundle` requires
// before a drive carrying kiwix_tools binaries can be SELLABLE.
//
// The source tarballs are NEVER committed to this repo — --source-dir is a maintainer-local
// archive directory, supplied only at build time; nothing here touches the network.
//
// Exit codes: 0 ok (or a clean --dry-run) · 1 a source archive is missing or fails
// re-verification · 2 usage / yaml error.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseYaml } from 'yaml'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const USAGE =
  'usage: node scripts/install-kiwix-source-bundle.mjs --target <drive root> --source-dir <archive dir> ' +
  '[--manifest <runtime-sources.yaml>] [--dry-run]'

function parseArgs(argv) {
  let target = ''
  let sourceDir = ''
  let manifest = ''
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} needs a value`)
      i++
      return v
    }
    if (a === '--target') target = next()
    else if (a === '--source-dir') sourceDir = next()
    else if (a === '--manifest') manifest = next()
    else if (a === '--dry-run') dryRun = true
    else if (a === '-h' || a === '--help') {
      console.log(USAGE)
      process.exit(0)
    } else {
      console.error(`unknown argument: ${a}\n${USAGE}`)
      process.exit(2)
    }
  }
  if (!target) {
    console.error(`--target is required\n${USAGE}`)
    process.exit(2)
  }
  if (!sourceDir) {
    console.error(`--source-dir is required\n${USAGE}`)
    process.exit(2)
  }
  return { target: resolve(target), sourceDir: resolve(sourceDir), manifest, dryRun }
}

/** Same escape-guard as `isUnsafeDrivePath` in shared/runtime-sources.ts (kept in sync). */
function isUnsafeDrivePath(p) {
  return p.includes('..') || /^[\\/]/.test(p) || /^[A-Za-z]:/.test(p)
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/** Read + validate `kiwix_tools.source_bundle` out of a runtime-sources.yaml. Throws on any
 *  missing/malformed shape — a silently-incomplete bundle is worse than a loud failure here. */
function loadBundle(manifestPath) {
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest not found: ${manifestPath}`)
  }
  const parsed = parseYaml(readFileSync(manifestPath, 'utf8'))
  const kiwix = parsed?.kiwix_tools
  const bundle = kiwix?.source_bundle
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    throw new Error(`${manifestPath}: kiwix_tools.source_bundle is absent or malformed — nothing to install`)
  }
  if (typeof bundle.dir !== 'string' || bundle.dir.trim() === '') {
    throw new Error(`${manifestPath}: kiwix_tools.source_bundle.dir is required and must be a non-empty string`)
  }
  const dir = bundle.dir.trim()
  if (isUnsafeDrivePath(dir)) {
    throw new Error(
      `${manifestPath}: kiwix_tools.source_bundle.dir "${dir}" is unsafe (no "..", leading slash, or drive letter allowed)`
    )
  }
  if (!Array.isArray(bundle.files) || bundle.files.length === 0) {
    throw new Error(`${manifestPath}: kiwix_tools.source_bundle.files is required and must be a non-empty list`)
  }
  bundle.files.forEach((f, i) => {
    const where = `${manifestPath}: kiwix_tools.source_bundle.files[${i}]`
    for (const key of ['component', 'version', 'license', 'name', 'sha256', 'url']) {
      if (typeof f?.[key] !== 'string' || f[key].trim() === '') {
        throw new Error(`${where}.${key} is required and must be a non-empty string`)
      }
    }
  })
  return {
    version: typeof kiwix.version === 'string' ? kiwix.version : '',
    dir,
    files: bundle.files,
    recipeUrl: typeof bundle.recipe_url === 'string' ? bundle.recipe_url : undefined,
    recipeCommit: typeof bundle.recipe_commit === 'string' ? bundle.recipe_commit : undefined
  }
}

/** The generated SOURCES.md content — entirely derived from the yaml block. LF-only, no BOM. */
function buildSourcesMd(bundle) {
  const lines = []
  lines.push(`# Complete corresponding source — kiwix-tools ${bundle.version}`)
  lines.push('')
  lines.push(
    'The `kiwix-serve`, `kiwix-manage` and `kiwix-search` programs on this drive ' +
      '(`runtime/kiwix-tools/<os>/`) statically link the copyleft libraries below, so this ' +
      'directory carries their complete corresponding source alongside the binaries.'
  )
  lines.push('')
  lines.push('| Component | Version | Grant | Archive | Bytes | SHA-256 | Upstream URL |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const f of bundle.files) {
    const bytes = typeof f.size_bytes === 'number' ? String(f.size_bytes) : 'n/a'
    lines.push(`| ${f.component} | ${f.version} | ${f.license} | \`${f.name}\` | ${bytes} | \`${f.sha256}\` | ${f.url} |`)
  }
  lines.push('')
  lines.push('Verify an archive against the table above:')
  lines.push('')
  lines.push('```')
  lines.push('sha256sum <archive>                          # macOS / Linux')
  lines.push('Get-FileHash <archive> -Algorithm SHA256      # Windows PowerShell')
  lines.push('```')
  lines.push('')
  lines.push(
    "The GNU GPL v3 text is this drive's own `LICENSE` at the drive root (HilbertRaum itself is " +
      'GPL-3.0-or-later); the GPL-2.0 and LGPL-2.1 texts are reproduced in `DRIVE-NOTICES.md`.'
  )
  lines.push('')
  let recipeLine = bundle.recipeUrl
    ? `Built from the kiwix-build recipe at ${bundle.recipeUrl}`
    : 'Built from the kiwix-build recipe'
  if (bundle.recipeCommit) recipeLine += `, commit ${bundle.recipeCommit}`
  recipeLine += '.'
  lines.push(recipeLine)
  lines.push('')
  lines.push('Licence review record: `docs/model-policy.md` ("Sidecar binaries — kiwix-tools").')
  lines.push('')
  const output = lines.join('\n')
  if (output.includes('\r')) {
    throw new Error('generated SOURCES.md must be LF-only')
  }
  return output
}

function main() {
  const { target, sourceDir, manifest, dryRun } = parseArgs(process.argv.slice(2))
  let bundle
  try {
    bundle = loadBundle(manifest ? resolve(manifest) : join(repoRoot, 'model-manifests', 'runtime-sources.yaml'))
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(2)
  }

  const destDir = join(target, ...bundle.dir.split('/'))
  let installed = 0

  for (const file of bundle.files) {
    const src = join(sourceDir, file.name)
    if (!existsSync(src) || !statSync(src).isFile()) {
      console.error(`missing source archive: ${file.name} in ${sourceDir} — the maintainer archive is incomplete`)
      process.exit(1)
    }
    if (dryRun) {
      console.log(`dry-run  ${file.name}  (would copy from ${sourceDir} -> ${destDir})`)
      installed++
      continue
    }
    mkdirSync(destDir, { recursive: true })
    const dest = join(destDir, file.name)
    copyFileSync(src, dest)
    const actual = sha256File(dest)
    if (actual.toLowerCase() !== file.sha256.toLowerCase()) {
      rmSync(dest, { force: true })
      console.error(`sha256 mismatch after copy: ${file.name} (expected ${file.sha256}, got ${actual})`)
      process.exit(1)
    }
    console.log(`ok  ${file.name}  ${actual}`)
    installed++
  }

  if (dryRun) {
    console.log(
      `dry run: ${installed} archive(s) found in ${sourceDir}; would install into ${destDir} and write SOURCES.md (nothing changed)`
    )
    process.exit(0)
  }

  writeFileSync(join(destDir, 'SOURCES.md'), buildSourcesMd(bundle), 'utf8')
  console.log(`kiwix-tools source bundle: ${installed} archive(s) installed + SOURCES.md written into ${destDir}`)
  process.exit(0)
}

main()
