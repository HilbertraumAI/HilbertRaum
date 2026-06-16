#!/usr/bin/env node
// Verify (and self-repair) the Electron platform binary after `npm install`.
//
// WHY THIS EXISTS — the NTFS half-extract bug:
//   Electron's own postinstall (`node_modules/electron/install.js`) downloads a ~100 MB zip
//   and unpacks it with `extract-zip`. On some mounts — notably an NTFS volume mounted on
//   Linux (ntfs-3g/FUSE) — the unpack can SILENTLY fail to write the binary while still
//   creating empty folders (e.g. `dist/locales/`). The download itself succeeds (a valid zip
//   sits in the @electron/get cache), so there is nothing to retry at the download layer.
//   Worse: once `node_modules/electron` exists and the lockfile matches, npm considers the
//   package installed and NEVER re-runs its postinstall — so a second `npm install` cannot
//   repair it. The damage only surfaces much later as electron-vite's opaque
//   `Electron uninstall` ("binary not found") error.
//
// This script runs as the ROOT package's `postinstall`, which npm executes on EVERY
// `npm install` (cached deps or not). On a healthy install it is a couple of stat() calls and
// exits. When the binary is missing/empty it force-re-runs Electron's installer (re-extracting
// from the cached zip), then re-verifies — converting a silent, deferred, opaque failure into
// an immediate one that either self-heals or prints an actionable message.
//
// Escape hatches (skip the check entirely):
//   ELECTRON_SKIP_BINARY_DOWNLOAD=1     (binary intentionally absent — e.g. CI lint-only)
//   ELECTRON_OVERRIDE_DIST_PATH=...     (using an out-of-tree Electron build)
//   HILBERTRAUM_SKIP_ELECTRON_CHECK=1   (manual override)

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const TAG = '[verify-electron]';

if (
  process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ||
  process.env.ELECTRON_OVERRIDE_DIST_PATH ||
  process.env.HILBERTRAUM_SKIP_ELECTRON_CHECK
) {
  process.exit(0);
}

// Locate the installed electron package from the repo root. If it isn't installed at all
// (e.g. a slimmed production context), there is nothing to verify — succeed quietly.
const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const require = createRequire(path.join(repoRoot, 'package.json'));
let electronDir;
try {
  electronDir = path.dirname(require.resolve('electron/package.json'));
} catch {
  process.exit(0);
}

// Mirror electron/index.js: the real executable is `dist/<contents of path.txt>`. A missing
// path.txt, a missing `dist/version`, or a missing/empty binary all mean a broken extract.
function binaryProblem() {
  const distDir = path.join(electronDir, 'dist');
  const pathFile = path.join(electronDir, 'path.txt');
  if (!fs.existsSync(pathFile)) return 'path.txt is missing (extract did not finish)';
  if (!fs.existsSync(path.join(distDir, 'version'))) return 'dist/version is missing (extract did not finish)';
  const rel = fs.readFileSync(pathFile, 'utf-8').trim();
  if (!rel) return 'path.txt is empty';
  const binary = path.join(distDir, rel);
  let st;
  try {
    st = fs.statSync(binary);
  } catch {
    return `platform binary is missing: dist/${rel}`;
  }
  if (!st.isFile() || st.size === 0) return `platform binary is empty: dist/${rel}`;
  return null; // healthy
}

let problem = binaryProblem();
if (!problem) process.exit(0); // healthy — the common path

console.error(`${TAG} Electron binary looks broken (${problem}).`);
console.error(`${TAG} This is the classic half-extracted install (often an NTFS-on-Linux mount).`);
console.error(`${TAG} Forcing a clean re-extract from the cached download…`);

// Remove the half-written dist so install.js takes the "not installed" path and re-extracts
// cleanly instead of tripping over leftover empty folders.
try {
  fs.rmSync(path.join(electronDir, 'dist'), { recursive: true, force: true });
} catch (err) {
  console.error(`${TAG} could not remove stale dist/: ${err.message}`);
}

const installJs = path.join(electronDir, 'install.js');
const res = spawnSync(process.execPath, [installJs], {
  cwd: electronDir,
  stdio: 'inherit',
  env: process.env,
});

problem = binaryProblem();
if (!problem && res.status === 0) {
  console.error(`${TAG} Re-extract succeeded — Electron binary is present.`);
  process.exit(0);
}

// Still broken: the mount genuinely can't hold the binary. Fail loudly with the real remedy
// rather than letting electron-vite throw its opaque "Electron uninstall" later.
console.error('');
console.error(`${TAG} ERROR: Electron's platform binary is still not installed (${problem || 'install.js exited ' + res.status}).`);
console.error(`${TAG} extract-zip cannot reliably write the binary onto this filesystem.`);
console.error(`${TAG} This is almost always an NTFS volume mounted on Linux (ntfs-3g/FUSE):`);
console.error(`${TAG} it can create folders but drops the large/executable files during unzip.`);
console.error('');
console.error(`${TAG} Fix: put node_modules on a native filesystem, then point the project at it:`);
console.error(`${TAG}   • clone/copy this repo onto an ext4/Btrfs/APFS disk and run npm install there, or`);
console.error(`${TAG}   • keep the repo on NTFS but redirect node_modules to a native disk:`);
console.error(`${TAG}       npm install --install-links=false   # then symlink node_modules → native path`);
console.error(`${TAG} (The portable HilbertRaum DRIVE itself can stay NTFS — this only affects the`);
console.error(`${TAG}  dev-time node_modules where Electron unpacks its binary.)`);
console.error('');
process.exit(1);
