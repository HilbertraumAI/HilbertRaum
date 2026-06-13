import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelManifest } from '../../shared/manifest'
import type { OcrSources, RuntimeSources } from '../../shared/runtime-sources'
import { loadPolicy } from './policy'
import {
  planOcrDownloads,
  planRuntimeDownload,
  readRuntimeMarker,
  runtimeBinaryPresent,
  WHISPER_BINARY_BASE
} from './assets'
import { verifyDriveModels, type ModelVerifyResult } from './drive'

// Commercial-drive pipeline + final posture assertion (spec §12.2).
//
// Mirrors services/drive.ts + services/assets.ts: this module is the CANONICAL,
// unit-tested reference, and `scripts/build-commercial-drive.{ps1,sh}` re-implement the
// SAME ordered plan natively (self-contained, no Node/npm). It does NOT re-implement
// prepare-drive/fetch-*/verify-models — it ORCHESTRATES them. The final automated check
// (`assertCommercialDrive`) is the gate that decides "is this drive actually sellable?"
// and reuses loadPolicy + verifyDriveModels rather than duplicating that logic.
//
// A sellable drive MUST ship the commercial posture (encryption required, plaintext off,
// models must verify, NETWORK DENIED — spec §12.2) and contain NO user data. The assertion
// FAILS LOUDLY if any of that is violated.

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
  /** The drive root to build onto (e.g. `E:\` or `/Volumes/PRIVATE_AI_DRIVE`). */
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
        'Create the directory tree + copy manifests/docs + write config/{drive,policy}.json ' +
        'in the commercial posture (encryption required, plaintext off, network denied).'
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
        '(spec §13 — not overridable by --accept-license), and NO user data present.'
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

export interface CommercialAssertion {
  ok: boolean
  /** Human-readable reasons the drive is NOT sellable (empty when ok). */
  problems: string[]
  checks: {
    /** Encryption required + plaintext off + models must verify. */
    policyCommercial: boolean
    /** Network denied (no model downloads, no update checks). */
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
     * Every pinned OCR language file is present + sha256-verified (opt-in:
     * true when no `ocrSources` were passed).
     */
    ocrAssetsVerified: boolean
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
 * build's `.hilbertraum-runtime.json` install marker must also match (version + backend).
 * Returns a structured result; never throws. Fails loudly: any violated
 * invariant adds a `problems[]` entry and flips `ok` to false.
 */
export async function assertCommercialDrive(
  rootPath: string,
  manifests: ModelManifest[],
  runtimeSources?: RuntimeSources | null,
  whisperSources?: RuntimeSources | null,
  ocrSources?: OcrSources | null
): Promise<CommercialAssertion> {
  const problems: string[] = []

  // --- Policy posture (reuse loadPolicy) ---
  const { policy } = loadPolicy(join(rootPath, 'config'))
  const policyCommercial =
    policy.workspace.encryptionRequired &&
    !policy.workspace.allowPlaintextDevMode &&
    policy.models.requireSha256Match
  const networkDenied =
    !policy.network.allowModelDownloads &&
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
  if (policy.network.allowModelDownloads || policy.network.allowUpdateChecks) {
    problems.push('policy.json allows network access (a sold drive must deny network)')
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

  // --- Runtime install markers match the yaml pin (opt-in) ---
  // The marker is what fetch-runtime writes after a verified extraction; a missing or
  // stale marker means the drive carries the wrong sidecar build (e.g. a CPU-era build
  // after the default moved to vulkan) and must be re-provisioned. The same
  // check runs for the whisper family (binary `whisper-cli`) when its pin is passed.
  let runtimeCurrent = true
  const checkFamily = (sources: RuntimeSources, family: string, binaryBase: string): void => {
    for (const build of sources.builds) {
      const label = `${family} build ${build.os}/${build.arch} ${build.backend}`
      // planRuntimeDownload escape-guards extract_to (the yaml on the DRIVE is
      // user-writable) — a tampered path is a failed check, not a crash.
      let binaryOk = false
      let extractTo: string
      try {
        const plan = planRuntimeDownload(rootPath, build, sources.version, binaryBase)
        extractTo = plan.extractTo
        binaryOk = runtimeBinaryPresent(plan)
      } catch (err) {
        runtimeCurrent = false
        problems.push(`${label}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }
      const marker = readRuntimeMarker(extractTo)
      // A marker alone is not an install: the binary must exist too (mirrors
      // runtimeInstallCurrent — a half-deleted install must fail the sell gate).
      if (!binaryOk) {
        runtimeCurrent = false
        problems.push(
          `${label}: ${binaryBase} binary missing under ${build.extractTo} — ` +
            'run fetch-runtime for this build'
        )
      } else if (!marker) {
        runtimeCurrent = false
        problems.push(
          `${label}: no .hilbertraum-runtime.json ` +
            `install marker under ${build.extractTo} — run fetch-runtime for this build`
        )
      } else if (marker.version !== sources.version || marker.backend !== build.backend) {
        runtimeCurrent = false
        problems.push(
          `${label}: installed ` +
            `${marker.version}/${marker.backend} does not match the pinned ` +
            `${sources.version}/${build.backend} — re-run fetch-runtime`
        )
      }
    }
  }
  if (runtimeSources) checkFamily(runtimeSources, 'runtime', 'llama-server')
  if (whisperSources) checkFamily(whisperSources, 'whisper', WHISPER_BINARY_BASE)

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
      ocrAssetsVerified
    },
    modelResults
  }
}
