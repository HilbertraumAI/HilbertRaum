import { stat } from 'node:fs/promises'
import { dirname } from 'node:path'
import { log } from './logging'
import {
  NESTED_NET_FOLDERS,
  markerBinaryKey,
  readRuntimeMarker,
  recordedFilePath,
  type RuntimeInstallMarker
} from './assets'
import { sha256File } from './models'

// Re-hash a sidecar binary immediately before spawn (vuln-scan 2026-06-21, item B;
// long-tracked audit-2026-06-14 "engine-binary not re-hashed before spawn").
//
// THREAT: every sidecar (`llama-server`, `whisper-cli`, the `--list-devices` GPU probe)
// is SHA-256-verified at download/install time, but on a portable offline drive a local
// adversary who overwrites `runtime/<family>/<os>/<bin>` BETWEEN install and the next
// launch gets code-exec at the app's privileges. The install marker records each
// extracted file's own hash (`RuntimeInstallMarker.binaries`); this module re-checks
// those hashes on the resolved copy right before we spawn its program.
//
// #1012: the program alone is not the code that runs. Since llama.cpp b12110 the Windows
// `llama-server.exe` is a 9.7 KB shim whose server lives in `llama-server-impl.dll` and the
// libraries beside it, and the processor and graphics backends load at run time. Since #998 the
// marker records every file of the copy, so the verdict covers EVERY key of the copy's own marker
// (a nested `cpu/` net's keys are that net's, `NESTED_NET_FOLDERS`): a changed one is `mismatch`,
// a missing one `missing` (the program or a library) or `missing-other` (any other file) — no
// tamper, but the copy is not what was installed, and the engines' spawn sites refuse both with the
// "engine files damaged" verdict the reinstall offer reads. A marker written before #998 records the
// program alone, which is then all that is checked. Files are hashed one at a time, the program
// first, stopping at the first difference. A file that cannot be read is `unreadable` (review R-2).
//
// ROLLOUT (non-breaking — the gate must never spuriously drop a real drive to MockRuntime):
//   - DEV / un-initialised → NOT enforced ⇒ `skip-dev` (no hashing, no FS). The on-drive
//     binary may be a local build, and the `HILBERTRAUM_*_BIN` dev override points at an
//     explicitly UNVERIFIED path — neither should be hash-gated.
//   - PACKAGED → enforced. A binary WITH a recorded hash is verified (`ok`/`mismatch`); a
//     binary with NO recorded hash (legacy drive, or one provisioned by an older
//     fetch-runtime) is TOLERATED ⇒ `skip-legacy` (logged) so it still launches — on a
//     COMMERCIAL drive that tolerance can be switched to a refusal (#234, see
//     `REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES`).
//
// The result is SESSION-CACHED per resolved binary path: the GPU probe and the server
// start race for the very same path (factory.ts kicks the probe concurrently with the
// start), and calls that overlap share one hash and one decision. Only the definitive verdicts
// stick: `ok`, `skip-*` and a real hash mismatch (`mismatch`, a tamper). `unreadable` (a file
// that couldn't be read — e.g. a Windows AV/indexer lock holding it for a moment — or a copy that
// changed while it was read), `missing` and `missing-other` are NEVER cached: each later attempt
// reads the copy again, so a self-healing lock or a file put back (from an antivirus quarantine)
// does not strand the whole session, and "Check again" sees the copy as it is now.

/**
 * The verification outcomes (#1012 adds the last three; all of them refuse at the engines' seams):
 *  - `mismatch`: a recorded file differs, or a key leaves the copy's folder — a tamper; every seam refuses.
 *  - `missing`: the program or a recorded library (`.dll`, `.so`, `.so.N`, `.dylib`) is gone, and
 *    nothing present differs. The OS loader would look for it elsewhere (the working directory
 *    too), so every seam refuses; the engines with the "engine files damaged" verdict.
 *  - `missing-other`: only other recorded files are gone (a tool the app never runs, a licence
 *    text). The engines refuse it as damaged files too (owner decision Q1); the knowledge-pack
 *    tools, which have no in-app repair, start anyway (owner decision Q2).
 *  - `unreadable`: a recorded file could not be read just now, or the copy changed during the
 *    check: no verdict about the copy. Seams refuse this attempt without blaming anything (the
 *    probe gives no answer, the start ladder sees no GPU evidence), and the next attempt reads again.
 */
export type BinaryVerifyResult =
  | 'ok'
  | 'skip-legacy'
  | 'skip-dev'
  | 'mismatch'
  | 'missing'
  | 'missing-other'
  | 'unreadable'

/** #1012: a recorded file the copy lacks, whatever it is (`missing` or `missing-other`). */
export function isMissingFilesVerdict(verdict: BinaryVerifyResult): boolean {
  return verdict === 'missing' || verdict === 'missing-other'
}

/** The verdicts no later spawn may reuse (see the cache note above). */
const RECHECKED: ReadonlySet<BinaryVerifyResult> = new Set(['unreadable', 'missing', 'missing-other'])

/**
 * A name the OS loader, or llama.cpp's backend loader, loads as code: a shared library. Matched on
 * the key's last segment (`ggml-vulkan.dll`, `libggml-base.so.0`, `libllama.dylib`).
 */
const LIBRARY_NAME = /\.(?:dll|dylib|so)$|\.so\.[^/]+$/i

/** True only after `initBinaryVerification(false)` (a packaged build). */
let enforced = false

/**
 * Whether a COMMERCIAL drive (policy.json in the sold posture) refuses to spawn a binary
 * whose install marker records no hash (#234). The sell gate and `fetch-runtime
 * --commercial` already refuse hashless markers at build time; refusing them at spawn
 * would stop already-sold kits from launching until re-provisioned, which is the owner's
 * call — shipped OFF until #234 is answered. Flip to true to enable.
 */
export const REFUSE_HASHLESS_MARKERS_ON_COMMERCIAL_DRIVES = false

/** Drive posture, set after policy.json is loaded (`setBinaryVerificationPosture`). */
let commercialPosture = false
let refuseHashlessMarkers = false

/** Session cache: one verification (one hash) per resolved binary path. */
const cache = new Map<string, Promise<BinaryVerifyResult>>()

/**
 * Configure enforcement once at startup (`index.ts`). Packaged builds (`isDev === false`)
 * enforce; dev builds skip. Until this is called the verifier is inert (`skip-dev`), which
 * keeps the headless unit suite — which constructs sidecars with fake paths and never
 * provisions a marker — entirely unaffected.
 */
export function initBinaryVerification(isDev: boolean): void {
  enforced = !isDev
}

/**
 * Record the drive posture once policy.json is known (`index.ts`, right after
 * `loadPolicy`; `initBinaryVerification` runs earlier). On a commercial drive a hashless
 * marker is refused only when `refuseHashlessMarkers` is set (#234); a DIY drive keeps
 * the documented `skip-legacy` tolerance.
 */
export function setBinaryVerificationPosture(opts: {
  commercial: boolean
  refuseHashlessMarkers?: boolean
}): void {
  commercialPosture = opts.commercial
  refuseHashlessMarkers = opts.refuseHashlessMarkers ?? false
}

/**
 * Evict one binary's session-cached verdict (full-audit 2026-07-11 CODE-12). The in-app
 * engine installer calls this for every program of a copy it put in place: the session
 * cache is keyed by the resolved program path (its verdict covers the whole copy, #1012), so
 * a pre-install verdict — the `mismatch` that made the user repair in the first place, or an
 * `ok` hashed from the OLD bytes — would otherwise stick to the NEW copy until app restart (a
 * repair-after-tamper stayed refused: silent MockRuntime on a fixed drive). The next spawn
 * re-hashes fresh.
 */
export function invalidateBinaryVerification(binPath: string): void {
  cache.delete(binPath)
}

/**
 * The keys of `binaries` the verdict for the program `binPath` covers, the program first (#1012). With
 * the marker in the program's own folder: every key but a nested net's (`NESTED_NET_FOLDERS`: that copy
 * has a marker of its own). With the family marker one level up (a `cpu/` net without a marker of its
 * own): the keys under the net's folder only — the family's other files are not the net's.
 */
function keysToVerify(binaries: Record<string, string>, markerDir: string, binPath: string): string[] {
  const program = markerBinaryKey(markerDir, binPath)
  const folder = markerBinaryKey(markerDir, dirname(binPath))
  const covered = (key: string): boolean =>
    folder === '' ? !NESTED_NET_FOLDERS.includes(key.split('/')[0]) : key.startsWith(`${folder}/`)
  return [program, ...Object.keys(binaries).filter((key) => key !== program && covered(key)).sort()]
}

/** A read error's errno code (`EBUSY`, `EACCES`, …), validated as one — never the message, which names the path. */
function readErrorCode(err: unknown): string | null {
  const code = (err as NodeJS.ErrnoException | null)?.code
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(code) ? code : null
}

/**
 * A read error that says the file is not there (no file, or no folder on its path). A folder or another
 * non-regular file AT the path is caught before the read (round 5: the `stat` in the hashing loop). A
 * lasting deny-read ACL (EACCES / EPERM) cannot be told from an antivirus hold (Windows reports EPERM or
 * EBUSY for both), so it stays `unreadable`.
 */
function isAbsent(err: unknown): boolean {
  const code = readErrorCode(err)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * The raw verification, distinguishing a transient `unreadable` from a definitive verdict.
 * Walks UP from the binary's directory to the nearest install marker (so the `cpu/`
 * safety-net binary finds the family marker one level above when its own dir has none),
 * then hashes every file of the copy that marker records (`keysToVerify`, #1012), one at a
 * time, the program first, stopping at the first difference. A file that is not there is
 * counted, not hashed: the first missing program or library ends the check as `missing`; other
 * missing files give `missing-other` once nothing present differs (a changed file still wins,
 * since the knowledge-pack tools start on `missing-other`). Never throws: a file that can't be
 * read right now resolves `unreadable` (the cache layer won't persist it).
 */
async function computeRawVerification(binPath: string): Promise<BinaryVerifyResult> {
  const dir = dirname(binPath)
  // The marker lives at the family/extract-dir root. The main binary sits there; the
  // cpu safety-net sits one level down (and may carry its own marker). Check the binary's
  // own dir first, then its parent — first marker found wins.
  let markerDir: string | null = null
  let marker: RuntimeInstallMarker | null = null
  for (const candidate of [dir, dirname(dir)]) {
    const found = readRuntimeMarker(candidate)
    if (found) {
      markerDir = candidate
      marker = found
      break
    }
  }

  const binaries = marker?.binaries
  if (!marker || !markerDir || !binaries?.[markerBinaryKey(markerDir, binPath)]) {
    // No marker, no recorded hash for this binary, or a legacy (hash-less) marker — a
    // drive provisioned before this control shipped. Tolerate it (content-free log).
    log.info('No recorded hash for sidecar binary — skipping pre-spawn verification (legacy drive)')
    return 'skip-legacy'
  }

  // The marker is a file on the drive: a key that leaves the copy's folder is no file of this copy, and
  // no writer records one — refused, before anything is read. EVERY key, before a nested net's keys are
  // set aside (code review round 3): `cpu/../../x` names no file of the net.
  if (Object.keys(binaries).some((key) => recordedFilePath(markerDir, key) === null)) {
    log.warn('An engine install marker records a file outside its folder — refusing to spawn', { code: 'marker-key-outside' })
    return 'mismatch'
  }
  const program = markerBinaryKey(markerDir, binPath)
  const files = keysToVerify(binaries, markerDir, binPath).map((key) => ({
    path: recordedFilePath(markerDir, key) as string, // contained: checked above
    expected: binaries[key],
    // Review R-1 / R-6: the program and the libraries are what a loader would go looking for elsewhere.
    code: key === program || LIBRARY_NAME.test(key.slice(key.lastIndexOf('/') + 1))
  }))

  let missing = 0
  let missingCode = false
  let changed = false
  for (const file of files) {
    let actual = ''
    let absent = false
    try {
      // Code review round 5: a recorded path that holds no regular file (a folder, a pipe, a device) is
      // no file of the copy and never heals by waiting — missing, like no file at all (reading a pipe
      // would also block the check). One `stat` per file.
      if ((await stat(file.path)).isFile()) actual = await sha256File(file.path)
      else absent = true
    } catch (err) {
      if (!isAbsent(err)) {
        // Couldn't read a file to hash it (e.g. a transient Windows AV/indexer lock, a denied read).
        // No verdict about the copy (review R-2: never a tamper): refused this attempt, not cached,
        // and the next spawn reads it again once the lock clears.
        log.warn('Could not read a sidecar engine file before spawn — refusing this attempt (will re-check next spawn)', {
          code: readErrorCode(err) ?? 'read-failed'
        })
        return 'unreadable'
      }
      absent = true
    }
    if (absent) {
      missing++
      // Code review round 3: a missing program or library refuses the copy at every seam, so the rest
      // is not read (a quarantined DLL would otherwise cost the whole copy on each start attempt).
      if (file.code) {
        missingCode = true
        break
      }
      continue
    }
    if (actual.toLowerCase() !== file.expected.toLowerCase()) {
      changed = true
      break
    }
  }

  // An install that put a new copy in place while this ran (#986's swap, a #532 reinstall, a script
  // re-run) mixed two copies into one hash: that says nothing about either. Not cached, so the next
  // spawn judges the new copy by its own marker instead of a tamper verdict sticking for the session.
  if (JSON.stringify(readRuntimeMarker(markerDir)) !== JSON.stringify(marker)) {
    log.warn('The engine copy changed while it was being verified — refusing this attempt (will re-check next spawn)')
    return 'unreadable'
  }
  if (changed) {
    log.warn('Sidecar binary hash does not match its install marker — refusing to spawn (tamper)')
    return 'mismatch'
  }
  if (missing > 0) {
    // #1012: no tamper — the copy lost a file (an antivirus quarantine, a copy cut short).
    log.warn('Files the engine install marker records are missing (not a tamper)', {
      code: missingCode ? 'files-missing' : 'other-files-missing',
      count: missing
    })
    return missingCode ? 'missing' : 'missing-other'
  }
  return 'ok'
}

/**
 * Production entry point used at every spawn seam. Honours the enforcement gate and the
 * per-path session cache. In dev / before init it resolves `skip-dev` without touching the
 * filesystem. Never rejects. `unreadable`, `missing` and `missing-other` are returned as they
 * are but EVICTED from the cache, so the next spawn reads the copy again (a self-healing AV /
 * indexer lock won't strand the session on MockRuntime; a file put back is found by the next
 * spawn or "Check again").
 */
export function verifyBinaryBeforeSpawn(binPath: string): Promise<BinaryVerifyResult> {
  if (!enforced) return Promise.resolve('skip-dev')
  const cached = cache.get(binPath)
  if (cached) return cached
  const pending: Promise<BinaryVerifyResult> = computeRawVerification(binPath).then((raw) => {
    if (RECHECKED.has(raw)) {
      // Don't let a transient read failure or a missing file stick for the whole session — drop
      // it so the next spawn re-hashes. Identity-guard the delete so we never evict a newer entry.
      if (cache.get(binPath) === pending) cache.delete(binPath)
      return raw
    }
    if (raw === 'skip-legacy' && commercialPosture) {
      if (refuseHashlessMarkers) {
        log.warn('Sidecar binary has no recorded hash on a commercial drive — refusing to spawn (re-run fetch-runtime --commercial)')
        return 'mismatch'
      }
      log.warn('Sidecar binary has no recorded hash on a commercial drive — tolerated (spawn-time refusal not enabled)')
    }
    return raw
  })
  cache.set(binPath, pending)
  return pending
}
