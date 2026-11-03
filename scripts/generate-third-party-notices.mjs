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
// shipped dependency set (or a license text) actually changes. The content comes from
// scripts/lib/third-party-notices.mjs, which
// apps/desktop/tests/integration/third-party-notices.test.ts also runs: the gate fails
// while the committed file differs from a regeneration by a single byte (#769) —
// regenerate + commit together with any dependency change.
//
// Run after `npm ci` (reads license files out of node_modules). No network, no deps
// beyond `yaml` (already a production dependency).

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildThirdPartyNotices } from './lib/third-party-notices.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(repoRoot, 'THIRD-PARTY-NOTICES.md')

const output = buildThirdPartyNotices(repoRoot, { warn: (line) => console.warn(line) })
const packageCount = /^## Shipped packages \((\d+)\)$/m.exec(output)?.[1]
const before = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null
writeFileSync(OUT_PATH, output, 'utf8')
console.log(
  `THIRD-PARTY-NOTICES.md: ${packageCount} packages, ${statSync(OUT_PATH).size} bytes` +
    (before === null ? ' (created)' : before === output ? ' (unchanged)' : ' (updated)')
)
