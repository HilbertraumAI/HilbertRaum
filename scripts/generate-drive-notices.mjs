#!/usr/bin/env node
// Generates DRIVE-NOTICES.md at the repo root (LIC-1, full-audit 2026-07-12b).
//
//   node scripts/generate-drive-notices.mjs
//
// The file aggregates the drive-level license/attribution notices for everything a
// prepared drive carries OUTSIDE the packaged app: the llama.cpp / whisper.cpp sidecar
// binaries (MIT — texts pinned under licenses/, the upstream archives ship none), the
// SDL2.dll bundled in the whisper Windows archive (zlib), the OCR traineddata
// (Apache-2.0), and one attribution line per model manifest under model-manifests/**
// (derived from the YAML at generation time), plus the app's own GPL-3.0-or-later
// source-availability statement. prepare-drive.{ps1,sh} COPY the committed file to the
// drive root (no Node needed at drive-build time); the commercial SELLABLE gate requires
// it there.
//
// The output is DETERMINISTIC (sorted, no timestamps): rerunning on the same manifests +
// pinned license texts is byte-identical, so the committed file only changes when a
// manifest, the runtime pin, or a pinned license text actually changes.
// apps/desktop/tests/integration/drive-notices.test.ts fails the gate when the committed
// file no longer matches a regeneration — regenerate + commit together with any manifest
// or runtime-pin change. No network, no deps beyond `yaml` (already a production dep).

import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildDriveNotices } from './lib/drive-notices.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT_PATH = join(repoRoot, 'DRIVE-NOTICES.md')

const output = buildDriveNotices(repoRoot)
const before = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, 'utf8') : null
writeFileSync(OUT_PATH, output, 'utf8')
console.log(
  `DRIVE-NOTICES.md: ${statSync(OUT_PATH).size} bytes` +
    (before === null ? ' (created)' : before === output ? ' (unchanged)' : ' (updated)')
)
