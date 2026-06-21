import { dirname } from 'node:path'
import { log } from './logging'
import { markerBinaryKey, readRuntimeMarker, type RuntimeInstallMarker } from './assets'
import { sha256File } from './models'

// Re-hash a sidecar binary immediately before spawn (vuln-scan 2026-06-21, item B;
// long-tracked audit-2026-06-14 "engine-binary not re-hashed before spawn").
//
// THREAT: every sidecar (`llama-server`, `whisper-cli`, the `--list-devices` GPU probe)
// is SHA-256-verified at download/install time, but on a portable offline drive a local
// adversary who overwrites `runtime/<family>/<os>/<bin>` BETWEEN install and the next
// launch gets code-exec at the app's privileges. The install marker now records each
// extracted binary's own hash (`RuntimeInstallMarker.binaries`); this module re-checks
// that hash on the resolved path right before we spawn it.
//
// ROLLOUT (non-breaking — the gate must never spuriously drop a real drive to MockRuntime):
//   - DEV / un-initialised → NOT enforced ⇒ `skip-dev` (no hashing, no FS). The on-drive
//     binary may be a local build, and the `HILBERTRAUM_*_BIN` dev override points at an
//     explicitly UNVERIFIED path — neither should be hash-gated.
//   - PACKAGED → enforced. A binary WITH a recorded hash is verified (`ok`/`mismatch`); a
//     binary with NO recorded hash (legacy drive, or one provisioned by an older
//     fetch-runtime) is TOLERATED ⇒ `skip-legacy` (logged) so it still launches.
//
// The result is SESSION-CACHED per resolved binary path: the GPU probe and the server
// start race for the very same path (factory.ts kicks the probe concurrently with the
// start), and both must read one consistent decision off a single hash. EXCEPTION: a
// transient read failure (the binary couldn't be hashed — e.g. a Windows AV/indexer lock
// holding the file for a moment) is NEVER cached. It still fails safe THIS attempt
// (`mismatch` → MockRuntime / refuse), but the next spawn re-hashes, so a self-healing
// lock doesn't strand the whole session on the mock runtime. Only a definitive verdict
// (ok / skip-* / a real hash mismatch = tamper) sticks.

/** The four verification outcomes. Only `mismatch` blocks a spawn. */
export type BinaryVerifyResult = 'ok' | 'skip-legacy' | 'skip-dev' | 'mismatch'

/**
 * Internal verdict — like `BinaryVerifyResult` but distinguishes a TRANSIENT read failure
 * (`unreadable`) from a definitive hash mismatch. Both surface to callers as `mismatch`
 * (fail-safe), but only the definitive verdicts are session-cached (see `verifyBinaryBeforeSpawn`).
 */
type RawVerifyResult = BinaryVerifyResult | 'unreadable'

/** True only after `initBinaryVerification(false)` (a packaged build). */
let enforced = false

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

/** Test-only: reset enforcement + drop the session cache between cases. */
export function _resetBinaryVerificationForTests(): void {
  enforced = false
  cache.clear()
}

/** Injectable I/O for `computeBinaryVerification` (real fs by default). */
export interface BinaryVerificationIo {
  readMarkerAt?: (dir: string) => RuntimeInstallMarker | null
  hashFile?: (path: string) => Promise<string>
}

/**
 * The raw verification, distinguishing a transient `unreadable` from a definitive verdict.
 * Walks UP from the binary's directory to the nearest install marker (so the `cpu/`
 * safety-net binary finds the family marker one level above when its own dir has none),
 * looks up the recorded hash for that binary, and compares. Never throws: a binary that
 * can't be hashed right now resolves `unreadable` (the caller still fails safe, but the
 * cache layer won't persist it).
 */
async function computeRawVerification(
  binPath: string,
  io: BinaryVerificationIo = {}
): Promise<RawVerifyResult> {
  const readMarkerAt = io.readMarkerAt ?? readRuntimeMarker
  const hashFile = io.hashFile ?? sha256File

  const dir = dirname(binPath)
  // The marker lives at the family/extract-dir root. The main binary sits there; the
  // cpu safety-net sits one level down (and may carry its own marker). Check the binary's
  // own dir first, then its parent — first marker found wins.
  let markerDir: string | null = null
  let marker: RuntimeInstallMarker | null = null
  for (const candidate of [dir, dirname(dir)]) {
    const found = readMarkerAt(candidate)
    if (found) {
      markerDir = candidate
      marker = found
      break
    }
  }

  const expected = marker && markerDir ? marker.binaries?.[markerBinaryKey(markerDir, binPath)] : undefined
  if (!expected) {
    // No marker, no recorded hash for this binary, or a legacy (hash-less) marker — a
    // drive provisioned before this control shipped. Tolerate it (content-free log).
    log.info('No recorded hash for sidecar binary — skipping pre-spawn verification (legacy drive)')
    return 'skip-legacy'
  }

  let actual: string
  try {
    actual = await hashFile(binPath)
  } catch {
    // Couldn't read the binary to hash it (e.g. a transient Windows AV/indexer lock).
    // Fail safe for THIS spawn, but signal `unreadable` so the verdict is not cached and
    // the next spawn re-hashes once the lock clears.
    log.warn('Could not hash sidecar binary before spawn — refusing this attempt (will re-check next spawn)')
    return 'unreadable'
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    log.warn('Sidecar binary hash does not match its install marker — refusing to spawn (tamper)')
    return 'mismatch'
  }
  return 'ok'
}

/**
 * Pure verification of one binary against its install marker — no enforcement gate, no
 * cache. An unreadable binary fails SAFE as `mismatch` (the transient `unreadable` case is
 * an internal-only distinction the cache layer uses). Exposed for unit testing; production
 * code calls `verifyBinaryBeforeSpawn`.
 */
export async function computeBinaryVerification(
  binPath: string,
  io: BinaryVerificationIo = {}
): Promise<BinaryVerifyResult> {
  const raw = await computeRawVerification(binPath, io)
  return raw === 'unreadable' ? 'mismatch' : raw
}

/**
 * Production entry point used at every spawn seam. Honours the enforcement gate and the
 * per-path session cache. In dev / before init it resolves `skip-dev` without touching the
 * filesystem. Never rejects. A transient `unreadable` result is mapped to `mismatch` for
 * the caller but EVICTED from the cache, so the next spawn re-hashes (a self-healing AV /
 * indexer lock won't strand the session on MockRuntime). The `io` param is a test seam.
 */
export function verifyBinaryBeforeSpawn(
  binPath: string,
  io?: BinaryVerificationIo
): Promise<BinaryVerifyResult> {
  if (!enforced) return Promise.resolve('skip-dev')
  const cached = cache.get(binPath)
  if (cached) return cached
  const pending: Promise<BinaryVerifyResult> = computeRawVerification(binPath, io).then((raw) => {
    if (raw === 'unreadable') {
      // Don't let a transient read failure stick for the whole session — drop it so the
      // next spawn re-hashes. Identity-guard the delete so we never evict a newer entry.
      if (cache.get(binPath) === pending) cache.delete(binPath)
      return 'mismatch'
    }
    return raw
  })
  cache.set(binPath, pending)
  return pending
}
