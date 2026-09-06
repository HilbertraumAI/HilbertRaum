import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { ModelManifest } from '../../shared/manifest'
import {
  isKitPlatform,
  KIT_PLATFORMS,
  type KitPlatform,
  type OcrSources,
  type RuntimeBuild,
  type RuntimeFamily,
  type RuntimeSources
} from '../../shared/runtime-sources'
import { isCommercialPolicy, loadPolicy } from './policy'
import {
  markerBinaryKey,
  planOcrDownloads,
  planRuntimeDownload,
  readRuntimeMarker,
  requiredInstallFiles,
  sidecarFamilySpec,
  type RuntimeDownloadPlan,
  type SidecarFamilySpec
} from './assets'
import { sha256File } from './models'
import { verifyDriveModels, listSkillFolders, type ModelVerifyResult } from './drive'

// Commercial-drive pipeline + final posture assertion (spec §12.2).
//
// Mirrors services/drive.ts + services/assets.ts: this module is the CANONICAL,
// unit-tested reference. `scripts/build-commercial-drive.{ps1,sh}` run the SAME ordered
// plan natively and, for the verdict, CALL this assertion through the built
// `out/tools/assert-commercial-drive.mjs` (src/main/tools) — SELLABLE is printed only
// from its result (#233, #234). It does NOT re-implement prepare-drive/fetch-*/
// verify-models — it ORCHESTRATES them. The final automated check
// (`assertCommercialDrive`) is the gate that decides "is this drive actually sellable?"
// and reuses loadPolicy + verifyDriveModels rather than duplicating that logic.
//
// A sellable drive MUST ship the commercial posture (encryption required, plaintext off,
// models must verify, NETWORK DENIED — spec §12.2), contain NO user data, and carry the
// app artifact + launcher for every platform it is sold for. The assertion FAILS LOUDLY
// if any of that is violated.

/**
 * Distribution-level license/attribution artifacts every prepared drive carries at its
 * ROOT (LIC-1, full-audit 2026-07-12b): the app's own GPL-3.0-or-later license text, the
 * bundled-npm-package notices, and the GENERATED drive-wide notices (runtime binaries +
 * model weights + the GPLv3 source-availability statement — regenerated with
 * `node scripts/generate-drive-notices.mjs` from model-manifests/ + licenses/).
 * `prepare-drive.{ps1,sh}` copy all three from the repo root; `assertCommercialDrive`
 * below (and the build-commercial-drive scripts' native cross-check) fails a drive where
 * any is missing or empty. `tests/integration/script-drift.test.ts` pins the four
 * scripts' literals to this list.
 */
export const DRIVE_LICENSE_ARTIFACTS = [
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'DRIVE-NOTICES.md'
] as const

// ---- The ordered "build a sellable drive" plan -------------------------------------

export interface CommercialStep {
  id: string
  title: string
  /** The native command a drive-builder runs (mirrored by the shell scripts). */
  command: string
  /**
   * True when the step needs a human / secrets that never enter the repo (signing +
   * notarization). The green gate does NOT run these; they are documented manual steps.
   */
  manual: boolean
  description: string
}

export type CommercialOs = 'win' | 'mac' | 'linux'

export interface PlanCommercialDriveOptions {
  /** The drive root to build onto (e.g. `E:\` or `/Volumes/HILBERTRAUM`). */
  target: string
  /** Which OS the portable app is packaged + signed for. Default `win`. */
  os?: CommercialOs
  /** Accept the model licenses non-interactively (required to fetch a gated weight). */
  acceptLicense?: boolean
}

/** The packaged-app + signing step differs per OS; keep the copy honest about what's manual. */
function packageStep(os: CommercialOs): CommercialStep {
  if (os === 'mac') {
    return {
      id: 'package',
      title: 'Package + sign + notarize the macOS app',
      command: 'npm run package -- --mac',
      manual: true,
      description:
        'Build the .app, sign with a Developer ID Application certificate, notarize, and ' +
        'staple. Requires Apple Developer credentials supplied via env vars on the build ' +
        'machine — NEVER committed. Without notarization a USB-launched .app is quarantined.'
    }
  }
  if (os === 'linux') {
    return {
      id: 'package',
      title: 'Package the Linux AppImage',
      command: 'npm run package -- --linux',
      manual: true,
      description:
        'Build the AppImage. Linux has no OS gatekeeper, so signing is optional; the build ' +
        'still runs on a network-touching machine (Electron download, R2).'
    }
  }
  return {
    id: 'package',
    title: 'Package + sign the Windows portable .exe',
    command: 'npm run package:win',
    manual: true,
    description:
      'Build the portable .exe and sign the launcher + .exe with an OV/EV code-signing ' +
      'certificate (EV builds SmartScreen reputation fastest). The cert + creds come from ' +
      'env vars / a git-ignored secrets file on the build machine — NEVER committed.'
  }
}

/**
 * Plan the ordered steps that turn a blank drive into a finished, verified, sellable
 * drive. Pure (string assembly only) so the order + commands are unit-testable. The
 * shell scripts mirror this exactly; the signing/notarization steps are flagged `manual`.
 */
export function planCommercialDrive(opts: PlanCommercialDriveOptions): CommercialStep[] {
  const target = opts.target
  const os = opts.os ?? 'win'
  const acceptFlag = opts.acceptLicense ? ' --accept-license' : ''

  return [
    {
      id: 'prepare',
      title: 'Lay out the drive with the COMMERCIAL policy',
      command: `prepare-drive --target ${target}`,
      manual: false,
      description:
        'Create the directory tree + copy manifests/docs + the root license/attribution ' +
        'notices (LICENSE, THIRD-PARTY-NOTICES.md, DRIVE-NOTICES.md — LIC-1) + write ' +
        'config/{drive,policy}.json in the commercial posture (encryption required, ' +
        'plaintext off, network denied).'
    },
    {
      id: 'fetch-models',
      title: 'Download + verify the model weights',
      command: `fetch-models --target ${target}${acceptFlag}`,
      manual: false,
      description:
        'Fetch each weight from its manifest download URL, SHA-256-verify before it counts ' +
        'as installed. A sold drive needs a redistribution-permitting license whose ' +
        'license_review.status is approved (spec §13).'
    },
    {
      id: 'fetch-runtime',
      title: 'Download + verify the llama.cpp sidecar builds for every shipped OS',
      command:
        `fetch-runtime --target ${target} --os win|mac|linux ` +
        `(+ --backend cpu safety net on win/linux; one run per build)`,
      manual: false,
      description:
        'Fetch EVERY llama-server build each shipped OS needs from runtime-sources.yaml: ' +
        'the default build (Vulkan full build on win/linux — degrades to CPU on GPU-less ' +
        'machines; Metal on mac) into runtime/llama.cpp/<os>/ PLUS the pure-CPU safety net ' +
        'into runtime/llama.cpp/<os>/cpu/ where one is pinned. Each archive is verified and ' +
        'leaves a .hilbertraum-runtime.json install marker.'
    },
    {
      id: 'fetch-whisper',
      title: 'Download + verify the whisper.cpp transcriber builds (second sidecar family)',
      command: `fetch-runtime --target ${target} --family whisper_cpp (one run per pinned build)`,
      manual: false,
      description:
        'Fetch every whisper_cpp build pinned in runtime-sources.yaml into ' +
        'runtime/whisper.cpp/<os>/ (upstream ships a prebuilt Windows CPU build only; ' +
        'mac/linux builds come from the documented source-build step when shipped). ' +
        'Same verify-before-trust + .hilbertraum-runtime.json marker as the llama family.'
    },
    {
      id: 'fetch-ocr',
      title: 'Download + verify the OCR language files (ocr/ asset class)',
      command: `fetch-runtime --target ${target} --family ocr`,
      manual: false,
      description:
        'Fetch the pinned traineddata files from runtime-sources.yaml into ocr/ ' +
        '(deu + eng, the tessdata_best-integerized variant). Plain ' +
        'sha256-verified files — no extraction, no marker; idempotency is the hash.'
    },
    packageStep(os),
    {
      id: 'copy-app',
      title: 'Copy the launcher + portable app + user docs onto the drive',
      command: `copy "Start HilbertRaum" launcher + portable app + docs -> ${target}`,
      manual: false,
      description:
        'Place the signed portable app and the obvious double-click launcher at the drive ' +
        'root, alongside the bundled user-guide / privacy / troubleshooting docs.'
    },
    {
      id: 'verify',
      title: 'Capture real hashes + verify all weights',
      command: `verify-models --target ${target} --generate`,
      manual: false,
      description:
        'Record the real SHA-256 of every present weight into config/checksums.json and ' +
        'confirm each weight verifies against its manifest.'
    },
    {
      id: 'assert',
      title: 'Final check: assert the drive is sellable',
      command: `assertCommercialDrive(${target})`,
      manual: false,
      description:
        'Automated gate: commercial policy (encryption required, plaintext off, models must ' +
        'verify, network denied), all weights VERIFIED, every license_review APPROVED ' +
        '(spec §13 — not overridable by --accept-license), NO user data present, and the ' +
        'root license/attribution artifacts (LICENSE, THIRD-PARTY-NOTICES.md, ' +
        'DRIVE-NOTICES.md) present and non-empty (LIC-1).'
    }
  ]
}

/** Render the commercial-drive plan as a human-readable, ordered report. */
export function formatPlan(steps: CommercialStep[]): string {
  const lines: string[] = []
  lines.push('Build a commercial (sellable) drive — ordered steps:')
  lines.push('')
  steps.forEach((step, i) => {
    const tag = step.manual ? ' [MANUAL — signing/secrets, not in the green gate]' : ''
    lines.push(`  ${i + 1}. ${step.title}${tag}`)
    lines.push(`       $ ${step.command}`)
    lines.push(`       ${step.description}`)
  })
  return lines.join('\n')
}

// ---- The final "is this drive sellable?" assertion ---------------------------------

/** What a kit must carry at its root per platform it is sold for (#233). */
export interface KitPlatformSpec {
  /** The double-click launcher for that OS (`launchers/`). */
  launcher: string
  /** The release artifact name for a given app version. */
  artifact: (version: string) => string
  /** The version segment of a release artifact name of this platform, else null. */
  artifactVersion: (name: string) => string | null
}

const versionOf =
  (re: RegExp) =>
  (name: string): string | null =>
    re.exec(name)?.[1] ?? null

/**
 * Per-platform artifact + launcher names — the same names the launchers glob for on the
 * drive root and the release workflow uploads. macOS additionally accepts a lone extracted
 * `*.app` bundle, whose version is read from its Info.plist; beside a zip the launcher
 * refuses to start (#235), and so does this gate.
 */
export const KIT_PLATFORM_SPECS: Record<KitPlatform, KitPlatformSpec> = {
  'win-x64': {
    launcher: 'Start HilbertRaum.cmd',
    artifact: (v) => `HilbertRaum-${v}-portable.exe`,
    artifactVersion: versionOf(/^HilbertRaum-(.+)-portable\.exe$/)
  },
  'mac-arm64': {
    launcher: 'Start HilbertRaum.command',
    artifact: (v) => `HilbertRaum-${v}-mac-arm64.app.zip`,
    artifactVersion: versionOf(/^HilbertRaum-(.+)-mac-arm64\.app\.zip$/)
  },
  'linux-x64': {
    launcher: 'start-hilbertraum.sh',
    artifact: (v) => `HilbertRaum-${v}.AppImage`,
    artifactVersion: versionOf(/^HilbertRaum-(.+)\.AppImage$/)
  }
}

/** The platform matrix a kit is declared for + the app version being built (#233). */
export interface CommercialGateOptions {
  platforms: KitPlatform[]
  appVersion: string
  /**
   * #339 P8-1: build families beyond the two grandfathered positionals (`runtimeSources` =
   * llama_cpp, `whisperSources` = whisper_cpp), keyed by yaml family name. Every FUTURE family
   * goes here; the positionals are frozen. The code-side spec (`SIDECAR_FAMILY_SPECS`) decides
   * whether a family is required (`runtimeCurrent` / `runtimeHashed`) or optional
   * (`optionalRuntimesConsistent`). A null entry is "not declared on this drive".
   */
  families?: Partial<Record<RuntimeFamily, RuntimeSources | null>>
}

interface FoundAppArtifact {
  name: string
  platform: KitPlatform | null
  version: string | null
  size: number
  isDir: boolean
}

/** `CFBundleShortVersionString` of an extracted bundle, or null when unreadable. */
function readBundleVersion(appDir: string): string | null {
  try {
    const plist = readFileSync(join(appDir, 'Contents', 'Info.plist'), 'utf8')
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim() ?? null
  } catch {
    return null
  }
}

/** Every app artifact at the drive root: `HilbertRaum-*` files and `*.app` directories. */
function scanAppArtifacts(rootPath: string): FoundAppArtifact[] {
  const found: FoundAppArtifact[] = []
  let entries: import('node:fs').Dirent[]
  try {
    entries = readdirSync(rootPath, { withFileTypes: true })
  } catch {
    return found
  }
  for (const entry of entries) {
    if (entry.isDirectory() && /\.app$/.test(entry.name)) {
      found.push({
        name: entry.name,
        platform: 'mac-arm64',
        version: readBundleVersion(join(rootPath, entry.name)),
        size: 1,
        isDir: true
      })
      continue
    }
    if (!entry.isFile() || !entry.name.startsWith('HilbertRaum-')) continue
    let size = 0
    try {
      size = statSync(join(rootPath, entry.name)).size
    } catch {
      size = 0
    }
    let platform: KitPlatform | null = null
    let version: string | null = null
    for (const p of KIT_PLATFORMS) {
      const v = KIT_PLATFORM_SPECS[p].artifactVersion(entry.name)
      if (v !== null) {
        platform = p
        version = v
        break
      }
    }
    found.push({ name: entry.name, platform, version, size, isDir: false })
  }
  return found
}

export interface CommercialAssertion {
  ok: boolean
  /** Human-readable reasons the drive is NOT sellable (empty when ok). */
  problems: string[]
  checks: {
    /** Encryption required + plaintext off + models must verify. */
    policyCommercial: boolean
    /** The drive never PHONES HOME on its own: no update checks, no telemetry. Model
     *  downloads are an explicit, user-initiated, per-download-confirmed action and are
     *  PERMITTED on a sold drive, so they do not count as a network violation here. */
    networkDenied: boolean
    /** Every shipped weight is present + SHA-256 VERIFIED (no placeholder/mismatch/missing). */
    weightsVerified: boolean
    /**
     * Every shipped model's `license_review.status` is `approved` (spec §13). NOT
     * overridable by `--accept-license` — that flag is a user's license acceptance at
     * download time, not a substitute for the redistribution review a SOLD drive needs.
     */
    licensesApproved: boolean
    /** No user data present (a sold drive ships empty — spec §12.2). */
    noUserData: boolean
    /**
     * Every pinned runtime build's install marker matches the runtime-sources.yaml pin
     * (version + backend). True when no `runtimeSources` were passed (the
     * check is opt-in; the native scripts cross-check it too). Covers BOTH sidecar
     * families when `whisperSources` is also passed.
     */
    runtimeCurrent: boolean
    /**
     * Every pinned runtime build's marker records the binary's SHA-256 AND the on-disk
     * bytes still match it (#234). Opt-in like `runtimeCurrent`. A hashless (legacy)
     * marker fails here, not in `runtimeCurrent`.
     */
    runtimeHashed: boolean
    /**
     * An OPTIONAL runtime family (kiwix_tools, #339 P8-1) is either FULLY provisioned — every
     * declared executable and required runtime file present, the marker current, every hash
     * recorded and still matching — or ENTIRELY absent. A half-installed optional family fails
     * the drive: the app would spawn it. True when no optional family is passed, and true for a
     * Kit that deliberately ships without knowledge-pack tools. Never folds into
     * `runtimeCurrent` / `runtimeHashed`, which keep their exact meaning for the required
     * families.
     */
    optionalRuntimesConsistent: boolean
    /**
     * A COPYLEFT sidecar family that is present on the drive carries its complete
     * corresponding source (#339 P8-4, owner ruling 2026-09-06). Fail-closed and
     * MARKER-INDEPENDENT: any declared executable of `kiwix_tools` existing under any
     * platform's extract dir — a hand-placed bundle included — requires the yaml's
     * `source_bundle` directory with every pinned archive present, hash-matching, and a
     * non-empty SOURCES.md beside them. True when no such binary is on the drive (a Kit may
     * deliberately ship none) and true for a complete bundle. Named for kiwix_tools because
     * it is the only family with a `source_bundle` today.
     */
    kiwixSourceBundle: boolean
    /**
     * Every pinned OCR language file is present + sha256-verified (opt-in:
     * true when no `ocrSources` were passed).
     */
    ocrAssetsVerified: boolean
    /**
     * At least one trusted product skill is provisioned under `app-skills/` (skills plan S9 /
     * §7.3). A sold drive ships product skills like the bank-statement stub. (Integrity of those
     * skills is the accepted §22-M2 residual: trust is by drive location, not signature.)
     */
    appSkillsPresent: boolean
    /**
     * `user-skills/` is empty (skills plan S9 / §14): a sellable drive ships only trusted product
     * skills and no user-installed ones — the same "ships empty" rule as the workspace.
     */
    userSkillsEmpty: boolean
    /**
     * Every root license/attribution artifact (`DRIVE_LICENSE_ARTIFACTS`) is present and
     * non-empty (LIC-1, full-audit 2026-07-12b): the approved reviews record "ship the
     * LICENSE/NOTICE attribution with the drive", the MIT binaries require their notice
     * in all copies, and the app's own GPL text + source statement ride the same files.
     */
    licenseArtifactsPresent: boolean
    /**
     * `opts.platforms` names at least one known platform (no duplicates) and
     * `opts.appVersion` is set (#233). False when the gate is called without them — the
     * app cannot be checked against an undeclared kit, so the drive is not sellable.
     */
    platformMatrixDeclared: boolean
    /**
     * Exactly one non-empty app artifact per declared platform, named for `appVersion`,
     * none for an undeclared platform, none unrecognised (#233). One extra artifact —
     * an older build left beside the new one — fails the drive.
     */
    appArtifactsPresent: boolean
    /** The launcher file of every declared platform is present + non-empty at the root. */
    launchersPresent: boolean
  }
  /** The per-weight verification detail (for surfacing which weight failed). */
  modelResults: ModelVerifyResult[]
}

/** Artifacts that mean a workspace has already been USED (must be absent on a sold drive). */
function userDataArtifacts(rootPath: string): string[] {
  const found: string[] = []
  const ws = join(rootPath, 'workspace')
  // A created workspace leaves a SQLite DB (plaintext) or its encrypted form + the vault
  // descriptor — and a crash can leave the WAL/SHM sidecars (plaintext DB pages) that
  // `cleanSidecars` normally shreds. Any of these means the drive was already initialised
  // — not factory-fresh. (We check the sidecars too so this final ship gate doesn't rely
  // on shredStalePlaintext having run.)
  for (const rel of [
    join('workspace', 'hilbertraum.sqlite'),
    join('workspace', 'hilbertraum.sqlite.enc'),
    join('workspace', 'hilbertraum.sqlite-wal'),
    join('workspace', 'hilbertraum.sqlite-shm'),
    join('config', 'workspace.json')
  ]) {
    if (existsSync(join(rootPath, rel))) found.push(rel.replace(/\\/g, '/'))
  }
  // Imported documents land under workspace/documents — a non-empty dir is user data.
  const docs = join(ws, 'documents')
  try {
    if (existsSync(docs) && statSync(docs).isDirectory() && readdirSync(docs).length > 0) {
      found.push('workspace/documents/*')
    }
  } catch {
    /* unreadable → treat as absent; the policy/weight checks still gate the drive */
  }
  return found
}

/**
 * Assert that a prepared drive is actually SELLABLE (spec §12.2). Reuses `loadPolicy`
 * (the commercial posture) + `verifyDriveModels` (all weights VERIFIED) and checks the
 * drive carries no user data. When `runtimeSources` (the yaml pin) is passed, each pinned
 * build's `.hilbertraum-runtime.json` install marker must also match (version + backend)
 * and record the binary's hash. `opts` declares the platforms the kit is sold for and the
 * app version: one artifact + launcher per platform is required (#233); without `opts`
 * the drive is not sellable. Returns a structured result; never throws. Fails loudly:
 * any violated invariant adds a `problems[]` entry and flips `ok` to false.
 */
export async function assertCommercialDrive(
  rootPath: string,
  manifests: ModelManifest[],
  runtimeSources?: RuntimeSources | null,
  whisperSources?: RuntimeSources | null,
  ocrSources?: OcrSources | null,
  opts?: CommercialGateOptions
): Promise<CommercialAssertion> {
  const problems: string[] = []

  // --- Policy posture (reuse loadPolicy) ---
  // Deliberately uses the DEFAULT (dev) base, NOT the packaged STRICT fallback (M-4): the
  // sell gate must FAIL a drive that ships no policy.json. With the strict fallback a
  // missing file would resolve to an encrypted/verified posture and silently pass — here
  // we want a missing/loose policy.json to surface as a problem below.
  const { policy } = loadPolicy(join(rootPath, 'config'))
  const policyCommercial = isCommercialPolicy(policy)
  // "Network denied" for a sold drive means the app never PHONES HOME on its own: no update
  // checks, no telemetry. Model downloads are an explicit, user-initiated, per-download-confirmed
  // action (the drive ships with them permitted so a buyer can add models), so they do NOT count
  // as a network violation.
  const networkDenied =
    !policy.network.allowUpdateChecks &&
    !policy.network.allowTelemetry

  if (!policy.workspace.encryptionRequired) {
    problems.push('policy.json does not require encryption (a sold drive must be encrypted-only)')
  }
  if (policy.workspace.allowPlaintextDevMode) {
    problems.push('policy.json allows a plaintext workspace (must be off on a sold drive)')
  }
  if (!policy.models.requireSha256Match) {
    problems.push('policy.json does not require SHA-256 model verification')
  }
  if (policy.network.allowUpdateChecks) {
    problems.push('policy.json allows update checks (a sold drive must not phone home)')
  }
  if (policy.network.allowTelemetry) {
    problems.push('policy.json allows telemetry (must always be off)')
  }

  // --- Weights all VERIFIED (reuse verifyDriveModels) ---
  const modelResults = await verifyDriveModels(rootPath, manifests)
  const weightsVerified =
    modelResults.length > 0 && modelResults.every((r) => r.status === 'verified')
  for (const r of modelResults) {
    if (r.status !== 'verified') {
      problems.push(`weight "${r.id}" is not VERIFIED (status: ${r.status} — ${r.localPath})`)
    }
  }
  if (modelResults.length === 0) {
    problems.push('no model weights to verify (a sold drive ships weights pre-loaded)')
  }

  // --- License reviews all APPROVED (spec §13) ---
  // `--accept-license` lets a builder download a weight; it must never count as the
  // redistribution review. A sold drive ships only models whose review is `approved`.
  const licensesApproved =
    manifests.length > 0 && manifests.every((m) => m.licenseReview.status === 'approved')
  for (const m of manifests) {
    if (m.licenseReview.status !== 'approved') {
      problems.push(
        `model "${m.id}" license_review.status is "${m.licenseReview.status}" — a sold drive ` +
          'requires an approved review (spec §13); --accept-license does not override this'
      )
    }
  }

  // --- No user data (spec §12.2) ---
  const userData = userDataArtifacts(rootPath)
  const noUserData = userData.length === 0
  for (const path of userData) {
    problems.push(`user data present on a drive meant to ship empty: ${path}`)
  }

  // --- Root license/attribution artifacts present + non-empty (LIC-1, 2026-07-12b) ---
  // A sold drive ships MIT binaries (llama.cpp/whisper.cpp — the notice must accompany
  // copies), Apache-2.0 weights/traineddata (every approved review note records "ship the
  // LICENSE/NOTICE attribution with the drive"), and the GPL app itself — all discharged
  // by the three root files prepare-drive copies. Missing OR empty fails the sell gate.
  let licenseArtifactsPresent = true
  for (const rel of DRIVE_LICENSE_ARTIFACTS) {
    let present = false
    try {
      const p = join(rootPath, rel)
      present = existsSync(p) && statSync(p).size > 0
    } catch {
      present = false
    }
    if (!present) {
      licenseArtifactsPresent = false
      problems.push(
        `license/attribution artifact missing or empty at the drive root: ${rel} — ` +
          're-run prepare-drive (it copies LICENSE + THIRD-PARTY-NOTICES.md + DRIVE-NOTICES.md)'
      )
    }
  }

  // --- Runtime install markers match the yaml pin (opt-in) ---
  // The marker is what fetch-runtime writes after a verified extraction; a missing or
  // stale marker means the drive carries the wrong sidecar build (e.g. a CPU-era build
  // after the default moved to vulkan) and must be re-provisioned. The same
  // check runs for the whisper family (binary `whisper-cli`) when its pin is passed.
  let runtimeCurrent = true
  let runtimeHashed = true
  let optionalRuntimesConsistent = true
  let kiwixSourceBundle = true
  // ONE family list, ONE code path (#339 P8-1): the two grandfathered positionals first, then
  // every family the caller passes by name. The CODE spec (`SIDECAR_FAMILY_SPECS`) supplies the
  // required file set — the same one the installer produced — and decides required vs optional.
  const families: Array<{ sources: RuntimeSources; label: string; spec: SidecarFamilySpec }> = []
  const addFamily = (family: RuntimeFamily, sources: RuntimeSources | null | undefined, label: string): void => {
    if (!sources || families.some((f) => f.spec.family === family)) return
    const spec = sidecarFamilySpec(family)
    if (!spec) {
      runtimeCurrent = false
      problems.push(`${label}: unknown runtime family "${family}" — the app cannot verify what it cannot spawn`)
      return
    }
    families.push({ sources, label, spec })
  }
  addFamily('llama_cpp', runtimeSources, 'runtime')
  addFamily('whisper_cpp', whisperSources, 'whisper')
  for (const [family, sources] of Object.entries(opts?.families ?? {})) {
    addFamily(family as RuntimeFamily, sources, family)
  }

  const checkFamily = async ({ sources, label: familyLabel, spec }: (typeof families)[number]): Promise<void> => {
    const optional = spec.optional === true
    const fail = (kind: 'current' | 'hashed', message: string): void => {
      problems.push(message)
      if (optional) optionalRuntimesConsistent = false
      else if (kind === 'current') runtimeCurrent = false
      else runtimeHashed = false
    }
    // Group the builds by extract dir: the two macOS kiwix_tools builds share ONE dir, and a
    // host installs one of them — each dir is checked once, against the build the marker's
    // `arch` names (else the first). Every llama / whisper build is its own group, so their
    // checks are byte-identical to before.
    const groups = new Map<string, RuntimeBuild[]>()
    for (const build of sources.builds) {
      const list = groups.get(build.extractTo) ?? []
      list.push(build)
      groups.set(build.extractTo, list)
    }
    for (const builds of groups.values()) {
      // planRuntimeDownload escape-guards extract_to (the yaml on the DRIVE is
      // user-writable) — a tampered path is a failed check, not a crash.
      const plans: Array<{ build: RuntimeBuild; plan: RuntimeDownloadPlan }> = []
      let planFailed = false
      for (const build of builds) {
        try {
          plans.push({
            build,
            plan: planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase, {
              alsoRequired: spec.alsoRequired,
              declaredExecutables: sources.executables
            })
          })
        } catch (err) {
          fail('current', `${familyLabel} build ${build.os}/${build.arch} ${build.backend}: ${err instanceof Error ? err.message : String(err)}`)
          planFailed = true
        }
      }
      if (planFailed || plans.length === 0) continue
      const marker = readRuntimeMarker(plans[0]!.plan.extractTo)
      const { build, plan } = plans.find((p) => marker !== null && p.build.arch === marker.arch) ?? plans[0]!
      const label = `${familyLabel} build ${build.os}/${build.arch} ${build.backend}`
      const required = requiredInstallFiles(plan)
      const present = required.filter((p) => existsSync(p) && statSync(p).isFile())
      // An optional family that is ENTIRELY absent — no marker, none of its files — is not a
      // defect: a Kit may deliberately ship without the knowledge-pack tools.
      if (optional && marker === null && present.length === 0) continue
      const missing = required.filter((p) => !present.includes(p))
      // A marker alone is not an install: every declared file must exist too (mirrors
      // runtimeInstallCurrent — a half-deleted or half-installed family must fail the gate).
      if (missing.length > 0) {
        const names = missing.map((p) => basename(p))
        fail(
          'current',
          missing.length === 1 && missing[0] === plan.binaryPath
            ? `${label}: ${spec.binaryBase} binary missing under ${build.extractTo} — run fetch-runtime for this build`
            : `${label}: missing under ${build.extractTo}: ${names.join(', ')} — run fetch-runtime for this build`
        )
        continue
      }
      if (!marker) {
        fail(
          'current',
          `${label}: no .hilbertraum-runtime.json ` +
            `install marker under ${build.extractTo} — run fetch-runtime for this build`
        )
        continue
      }
      if (marker.version !== sources.version || marker.backend !== build.backend) {
        fail(
          'current',
          `${label}: installed ` +
            `${marker.version}/${marker.backend} does not match the pinned ` +
            `${sources.version}/${build.backend} — re-run fetch-runtime`
        )
        continue
      }
      // Version + backend match — now require the marker to carry EVERY file's SHA-256 and
      // each to MATCH the on-disk bytes (#234). A sold drive must ship these hashes so the app
      // can re-verify each executable before spawn; a hashless marker (an older fetch-runtime,
      // or an unverified archive) fails the gate and must be re-fetched.
      for (const p of required) {
        const name = basename(p)
        const expected = marker.binaries?.[markerBinaryKey(plan.extractTo, p)]
        if (!expected) {
          fail(
            'hashed',
            `${label}: install marker records no SHA-256 for ${name} — re-run ` +
              'fetch-runtime --commercial so the binary can be re-verified before spawn'
          )
        } else if ((await sha256File(p)).toLowerCase() !== expected.toLowerCase()) {
          fail(
            'hashed',
            `${label}: ${name} does not match the SHA-256 recorded in the install ` +
              'marker — the binary or the marker was modified after install; re-run fetch-runtime --commercial'
          )
        }
      }
    }
  }

  /**
   * The corresponding-source bundle of a COPYLEFT family (#339 P8-4, owner ruling
   * 2026-09-06). Invariant: no executable of the family on the drive ⇒ not applicable ⇒ pass,
   * and nothing under the bundle dir is even read. Presence is FILE-based, never marker-based —
   * a hand-placed, marker-less bundle conveys the binaries just the same — and counts only the
   * executables (`plan.binaryPaths`): a stray ICU DLL is not "shipping kiwix-tools". With a
   * binary present the yaml must declare the bundle, the directory must exist, every pinned
   * archive must be there with a matching SHA-256, and a non-empty SOURCES.md must sit beside
   * them. Extra files in the directory are neither a failure nor a warning: the duty is "the
   * source is there", and `source/` is on no spawn or launcher path. One cause, one message.
   */
  const checkSourceBundle = async ({ sources, label: familyLabel, spec }: (typeof families)[number]): Promise<void> => {
    const L = `${familyLabel} source bundle`
    const fail = (message: string): void => {
      problems.push(message)
      kiwixSourceBundle = false
    }
    let present = false
    for (const build of sources.builds) {
      let plan: RuntimeDownloadPlan
      try {
        plan = planRuntimeDownload(rootPath, build, sources.version, spec.binaryBase, {
          alsoRequired: spec.alsoRequired,
          declaredExecutables: sources.executables
        })
      } catch {
        continue // checkFamily already reported the tampered path
      }
      if (plan.binaryPaths.some((p) => existsSync(p) && statSync(p).isFile())) {
        present = true
        break
      }
    }
    if (!present) return
    const bundle = sources.sourceBundle
    if (!bundle) {
      if (spec.family !== 'kiwix_tools') return // no copyleft duty is declared for this family
      fail(
        `${L}: the drive's runtime-sources.yaml declares no source_bundle for ${familyLabel} while its ` +
          'binaries are on this drive — a Kit that conveys these copyleft binaries must pin their ' +
          'complete corresponding source; re-run prepare-drive to copy the current manifests, or ship no kiwix-tools'
      )
      return
    }
    const dir = join(rootPath, ...bundle.dir.split('/'))
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      fail(
        `${L}: ${bundle.dir}/ is missing while ${familyLabel} binaries are on this drive — a preloaded ` +
          'Kit conveying these copyleft binaries must carry their complete corresponding source; run ' +
          'build-commercial-drive with --kiwix-source-dir <archive dir>, or ship no kiwix-tools'
      )
      return
    }
    for (const file of bundle.files) {
      const p = join(dir, file.name)
      if (!existsSync(p) || !statSync(p).isFile()) {
        fail(
          `${L}: ${file.name} missing from ${bundle.dir}/ — re-run build-commercial-drive with ` +
            '--kiwix-source-dir <archive dir> (it copies and re-verifies every pinned archive)'
        )
      } else if ((await sha256File(p)).toLowerCase() !== file.sha256.toLowerCase()) {
        fail(
          `${L}: ${file.name} does not match the SHA-256 pinned in runtime-sources.yaml — the archive was ` +
            'modified or is the wrong release; re-copy it from the pinned upstream URL'
        )
      }
    }
    const record = join(dir, 'SOURCES.md')
    if (!existsSync(record) || !statSync(record).isFile() || statSync(record).size === 0) {
      fail(
        `${L}: SOURCES.md missing or empty in ${bundle.dir}/ — regenerate the bundle with ` +
          'scripts/install-kiwix-source-bundle.mjs (it records each component, version, grant, SHA-256 and upstream URL)'
      )
    }
  }
  for (const family of families) {
    await checkFamily(family)
    await checkSourceBundle(family)
  }

  // --- OCR language files present + verified (opt-in) ---
  // Plain files: the hash IS the install state (no marker — mirrors planOcrDownloads).
  let ocrAssetsVerified = true
  if (ocrSources) {
    const ocrTasks = await planOcrDownloads(rootPath, ocrSources)
    for (const t of ocrTasks) {
      if (t.status !== 'present-verified') {
        ocrAssetsVerified = false
        problems.push(
          `ocr file "${t.lang}" is not present+verified (${t.relPath}; status: ${t.status}) — ` +
            'run fetch-runtime --family ocr'
        )
      }
    }
  }

  // --- App skills provisioned + user-skills empty (skills plan S9 / §7.3, §14) ---
  // A sellable drive ships trusted PRODUCT skills under app-skills/ (e.g. the bank-statement
  // stub) and NO user skills — user-skills/ is the read-write area a buyer fills, so it must be
  // empty at ship time (the same "ships empty" rule as workspace/). Trust of app-skills/ is by
  // LOCATION on a writable drive, not a signature — the accepted §22-M2 residual (documented in
  // security-model.md / known-limitations.md), the same residual as the engine binary.
  const appSkillsPresent = listSkillFolders(join(rootPath, 'app-skills')).length > 0
  if (!appSkillsPresent) {
    problems.push(
      'no app skills provisioned (a sold drive ships trusted product skills under app-skills/)'
    )
  }
  let userSkillsEmpty = true
  try {
    const userDir = join(rootPath, 'user-skills')
    const userEntries = existsSync(userDir) ? readdirSync(userDir) : []
    if (userEntries.length > 0) {
      userSkillsEmpty = false
      for (const name of userEntries) {
        problems.push(`user skill present on a drive meant to ship empty: user-skills/${name}`)
      }
    }
  } catch {
    /* unreadable → treat as empty; the policy/weight/app-skill gates still apply */
  }

  // --- App artifact + launcher per declared platform (#233) ---
  // A kit is sold for a declared set of platforms; each needs exactly one release
  // artifact of the version being built and its launcher at the drive root. An artifact
  // of an undeclared platform, an unrecognised name, or a second artifact of one platform
  // (an older build beside the new one) fails the drive.
  let platformMatrixDeclared = true
  const declared: KitPlatform[] = []
  if (!opts || !Array.isArray(opts.platforms) || opts.platforms.length === 0) {
    platformMatrixDeclared = false
    problems.push(
      `no platform matrix declared — name the platforms this kit is sold for (${KIT_PLATFORMS.join(', ')}); ` +
        'the app artifacts and launchers cannot be checked without it'
    )
  } else {
    for (const p of opts.platforms) {
      if (!isKitPlatform(p)) {
        platformMatrixDeclared = false
        problems.push(`unknown platform "${String(p)}" (known: ${KIT_PLATFORMS.join(', ')})`)
      } else if (declared.includes(p)) {
        platformMatrixDeclared = false
        problems.push(`platform "${p}" declared more than once`)
      } else {
        declared.push(p)
      }
    }
    if (typeof opts.appVersion !== 'string' || opts.appVersion.trim() === '') {
      platformMatrixDeclared = false
      problems.push('no app version declared — the app artifacts cannot be checked without it')
    }
  }
  let appArtifactsPresent = false
  let launchersPresent = false
  if (platformMatrixDeclared) {
    appArtifactsPresent = true
    launchersPresent = true
    const version = opts!.appVersion.trim()
    const found = scanAppArtifacts(rootPath)
    for (const a of found) {
      if (a.platform === null) {
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is not a release artifact of any platform (expected ` +
            `${KIT_PLATFORMS.map((p) => KIT_PLATFORM_SPECS[p].artifact('<version>')).join(', ')} ` +
            'or an extracted HilbertRaum.app)'
        )
      } else if (!declared.includes(a.platform)) {
        appArtifactsPresent = false
        problems.push(
          `app artifact "${a.name}" is for ${a.platform}, a platform this kit is not declared for ` +
            `(declared: ${declared.join(', ')}) — remove it or declare the platform`
        )
      }
    }
    for (const p of declared) {
      const spec = KIT_PLATFORM_SPECS[p]
      const mine = found.filter((a) => a.platform === p)
      if (mine.length === 0) {
        appArtifactsPresent = false
        problems.push(`${p}: no app artifact at the drive root (expected ${spec.artifact(version)})`)
      } else if (mine.length > 1) {
        appArtifactsPresent = false
        problems.push(
          `${p}: more than one app artifact at the drive root (${mine.map((a) => a.name).join(', ')}) — ` +
            'a drive must carry exactly one; delete the others'
        )
      } else {
        const a = mine[0]
        if (!a.isDir && a.size === 0) {
          appArtifactsPresent = false
          problems.push(`${p}: app artifact "${a.name}" is zero bytes`)
        }
        if (a.version === null) {
          appArtifactsPresent = false
          problems.push(`${p}: cannot read the version of "${a.name}" (Contents/Info.plist CFBundleShortVersionString)`)
        } else if (a.version !== version) {
          appArtifactsPresent = false
          problems.push(`${p}: app artifact "${a.name}" is version ${a.version}, the kit is being built as ${version}`)
        }
      }
      let launcherOk = false
      try {
        const lp = join(rootPath, spec.launcher)
        launcherOk = existsSync(lp) && statSync(lp).size > 0
      } catch {
        launcherOk = false
      }
      if (!launcherOk) {
        launchersPresent = false
        problems.push(`${p}: launcher "${spec.launcher}" missing or empty at the drive root — re-run build-commercial-drive`)
      }
    }
  }

  return {
    ok: problems.length === 0,
    problems,
    checks: {
      policyCommercial,
      networkDenied,
      weightsVerified,
      licensesApproved,
      noUserData,
      runtimeCurrent,
      runtimeHashed,
      optionalRuntimesConsistent,
      kiwixSourceBundle,
      ocrAssetsVerified,
      appSkillsPresent,
      userSkillsEmpty,
      licenseArtifactsPresent,
      platformMatrixDeclared,
      appArtifactsPresent,
      launchersPresent
    },
    modelResults
  }
}
