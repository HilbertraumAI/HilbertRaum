#!/usr/bin/env node
// Verify (and self-repair) the Electron platform binary after `npm install`.
//
// WHY THIS EXISTS — the NTFS half-extract bug:
//   Electron downloads a ~100 MB zip and unpacks it. On some mounts — notably an NTFS volume
//   mounted on Linux (ntfs-3g/FUSE) — the unpack can SILENTLY fail to write the binary while
//   still creating empty folders (e.g. `dist/locales/`). The download itself succeeds (a valid
//   zip sits in the @electron/get cache), so there is nothing to retry at the download layer.
//   The damage surfaces much later as electron-vite's opaque `Electron uninstall` error.
//
// WHAT CHANGED IN ELECTRON 42 (wave DEP-4, 2026-08-18) — read this before editing:
//   Electron >= 42 REMOVED the `postinstall` binary download (supply-chain hardening). The
//   package now declares no `scripts` at all; `install.js` survives only as a bin
//   (`install-electron`), and `index.js` downloads LAZILY — it reads `path.txt` and, when that
//   or the binary is missing, spawns `install.js` on first use of the bin.
//
//   So on Electron >= 42, `path.txt` is ABSENT after a healthy `npm ci`. That is NORMAL.
//   The previous version of this script treated an absent `path.txt` as "extract did not
//   finish" and responded by deleting dist/ and spawning install.js — which, on every clean
//   install, printed a false "binary looks broken" error with a wrong NTFS diagnosis and then
//   re-created the very ~100 MB postinstall download Electron had just removed on purpose,
//   also defeating the `npm ci --ignore-scripts` flow that motivated the upstream change.
//
//   The version check below is NOT decoration. Electron 39 and 41 still HAVE the postinstall
//   (verified against the registry: 39.8.10 and 41.10.6 declare `postinstall: node install.js`;
//   42.9.3 and 43.4.0 declare no scripts at all). On those versions an absent `path.txt` really
//   does mean a broken install. This repo's documented Electron-43 fallback ladder includes
//   ^41.7.2, so a version-blind script would silently lose the NTFS protection on that path.
//
// What this script still catches on EVERY version: the genuine half-extract — `path.txt` (or
// `dist/version`) present, but the platform binary missing or zero-length. npm will not re-run
// a postinstall for an already-installed package, so on Electron < 42 a second `npm install`
// cannot repair that; and on >= 42 a half-written dist/ makes the lazy path fail opaquely.
//
// Escape hatches (skip the check entirely):
//   HILBERTRAUM_SKIP_ELECTRON_CHECK=1   (manual override — what CI sets)
//   ELECTRON_OVERRIDE_DIST_PATH=...     (using an out-of-tree Electron build; still honored by
//                                        electron >= 42's index.js, the one env var it reads)
//   ELECTRON_SKIP_BINARY_DOWNLOAD=1     (kept as OUR OWN knob for older checkouts; note that
//                                        electron >= 42 no longer honors it itself)

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const TAG = '[verify-electron]';

/** Electron >= 42 removed the postinstall; the binary arrives lazily on first bin invocation. */
export const LAZY_DOWNLOAD_MAJOR = 42;

/**
 * Classify an installed electron package directory.
 *
 * Returns `null` when there is nothing to do — either a healthy install, or the perfectly
 * normal "binary not downloaded yet" state on Electron >= 42. Returns a human-readable problem
 * string when the install is genuinely damaged and worth repairing.
 *
 * Exported for tests: this is the whole decision, and it has no side effects.
 */
export function diagnose(electronDir, major) {
  const distDir = path.join(electronDir, 'dist');
  const pathFile = path.join(electronDir, 'path.txt');

  if (!fs.existsSync(pathFile)) {
    // Electron >= 42: nothing has run the bin yet, so no path.txt exists. Healthy, do nothing.
    if (major >= LAZY_DOWNLOAD_MAJOR) return null;
    // Electron < 42: the postinstall should have written it. This IS a broken install.
    return 'path.txt is missing (postinstall did not finish)';
  }

  // From here the download HAS run at least once, on every version — so anything missing below
  // is a real half-extract, which is exactly the NTFS-on-Linux failure this script exists for.
  if (!fs.existsSync(path.join(distDir, 'version'))) {
    return 'dist/version is missing (extract did not finish)';
  }
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

/** Read the installed electron's major version; returns null if it can't be determined. */
export function readElectronMajor(electronDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(electronDir, 'package.json'), 'utf-8'));
    const major = Number.parseInt(String(pkg.version), 10);
    return Number.isFinite(major) ? major : null;
  } catch {
    return null;
  }
}

function main() {
  if (
    process.env.ELECTRON_SKIP_BINARY_DOWNLOAD ||
    process.env.ELECTRON_OVERRIDE_DIST_PATH ||
    process.env.HILBERTRAUM_SKIP_ELECTRON_CHECK
  ) {
    return 0;
  }

  // Locate the installed electron package from the repo root. If it isn't installed at all
  // (e.g. a slimmed production context), there is nothing to verify — succeed quietly.
  const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
  const require = createRequire(path.join(repoRoot, 'package.json'));
  let electronDir;
  try {
    electronDir = path.dirname(require.resolve('electron/package.json'));
  } catch {
    return 0;
  }

  // An unreadable version is treated as >= 42 (the current line): the failure mode of guessing
  // "modern" is a no-op, while guessing "old" would resurrect the false-alarm download.
  const major = readElectronMajor(electronDir) ?? LAZY_DOWNLOAD_MAJOR;

  let problem = diagnose(electronDir, major);
  if (!problem) return 0; // healthy, or not-yet-downloaded on >= 42 — the common path

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

  // install.js is still a plain CJS file at the package root on every version in play — the
  // `postinstall` script entry disappeared in 42, the file did not (it became the
  // `install-electron` bin). Spawning it directly works on both sides of that change.
  const installJs = path.join(electronDir, 'install.js');
  const res = spawnSync(process.execPath, [installJs], {
    cwd: electronDir,
    stdio: 'inherit',
    env: process.env,
  });

  problem = diagnose(electronDir, major);
  if (!problem && res.status === 0) {
    console.error(`${TAG} Re-extract succeeded — Electron binary is present.`);
    return 0;
  }

  // Still broken: the mount genuinely can't hold the binary. Fail loudly with the real remedy
  // rather than letting electron-vite throw its opaque "Electron uninstall" later.
  console.error('');
  console.error(`${TAG} ERROR: Electron's platform binary is still not installed (${problem || 'install.js exited ' + res.status}).`);
  console.error(`${TAG} The unzip step cannot reliably write the binary onto this filesystem.`);
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
  return 1;
}

// Only act when run as a script; importing this module (tests) must have no side effects.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  process.exit(main());
}
