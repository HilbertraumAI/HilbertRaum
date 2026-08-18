import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings, getSettings, updateSettings } from '../../src/main/services/settings'
import {
  DEFAULT_POLICY,
  STRICT_POLICY,
  parsePolicy,
  loadPolicy,
  resolveNetwork,
  buildPolicyStatus,
  __policyMaterializations,
  __resetPolicyCache
} from '../../src/main/services/policy'
import {
  isLoopbackHost,
  checkOutboundHost,
  installOfflineNetworkGuard,
  assertOfflinePosture
} from '../../src/main/services/offlineGuard'

// ---- helpers --------------------------------------------------------------------

function freshDb(): Db {
  return openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-policy-')), 'test.sqlite'))
}

/** Make a temp config dir, optionally seeded with policy.json / drive.json contents. */
function configDir(files: { policy?: string; drive?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-cfg-'))
  const cfg = join(dir, 'config')
  mkdirSync(cfg, { recursive: true })
  if (files.policy !== undefined) writeFileSync(join(cfg, 'policy.json'), files.policy)
  if (files.drive !== undefined) writeFileSync(join(cfg, 'drive.json'), files.drive)
  return cfg
}

const COMMERCIAL_POLICY = JSON.stringify({
  network: { allow_model_downloads: false, allow_update_checks: false, allow_telemetry: false },
  workspace: { encryption_required: true, allow_plaintext_dev_mode: false },
  models: { allow_unverified_models: false, require_manifest: true, require_sha256_match: true }
})

const PERMISSIVE_POLICY = JSON.stringify({
  network: { allow_model_downloads: true, allow_update_checks: true, allow_telemetry: true }
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---- policy parsing -------------------------------------------------------------

describe('parsePolicy', () => {
  it('parses a valid commercial policy file into the camelCase shape', () => {
    const p = parsePolicy(COMMERCIAL_POLICY)
    expect(p.network.allowModelDownloads).toBe(false)
    expect(p.workspace.encryptionRequired).toBe(true)
    expect(p.workspace.allowPlaintextDevMode).toBe(false)
    expect(p.models.allowUnverifiedModels).toBe(false)
    expect(p.models.requireSha256Match).toBe(true)
  })

  it('falls back to DEFAULT_POLICY + a warning on malformed JSON (never throws)', () => {
    const warn = vi.fn()
    const p = parsePolicy('{ not valid json', warn)
    expect(p).toEqual(DEFAULT_POLICY)
    expect(warn).toHaveBeenCalledOnce()
  })

  it('keeps base defaults for any field the file omits or sets to a non-boolean', () => {
    const p = parsePolicy(
      JSON.stringify({ network: { allow_model_downloads: 'yes', allow_update_checks: 'yes' } })
    )
    // "yes" is not a boolean → the defaults survive (junk can never weaken the policy).
    expect(p.network.allowModelDownloads).toBe(DEFAULT_POLICY.network.allowModelDownloads)
    expect(p.network.allowUpdateChecks).toBe(false)
    expect(p.models.requireManifest).toBe(DEFAULT_POLICY.models.requireManifest)
  })
})

describe('loadPolicy', () => {
  it('returns DEFAULT_POLICY when no config files exist (developer fallback)', () => {
    const loaded = loadPolicy(configDir())
    expect(loaded.policy).toEqual(DEFAULT_POLICY)
    expect(loaded.policyFilePresent).toBe(false)
    expect(loaded.driveFilePresent).toBe(false)
  })

  it('loads policy.json + drive.json when present', () => {
    const cfg = configDir({
      policy: PERMISSIVE_POLICY,
      drive: JSON.stringify({ allow_network_by_default: false })
    })
    const loaded = loadPolicy(cfg)
    expect(loaded.policyFilePresent).toBe(true)
    expect(loaded.driveFilePresent).toBe(true)
    expect(loaded.policy.network.allowModelDownloads).toBe(true)
    expect(loaded.allowNetworkByDefault).toBe(false)
  })

  // F-30 (audit 2026-07-16): getAppStatus/getPolicy re-read+re-parse policy.json+drive.json on every
  // call (TranslateScreen polls every 4 s for a whole run). Cache the parsed result keyed by each
  // file's mtime/size; re-read ONLY when a signature changes so a live edit is still honoured.
  it('caches the parsed policy across repeated calls; re-reads only when a file changes (F-30)', () => {
    __resetPolicyCache()
    const cfg = configDir({ policy: PERMISSIVE_POLICY })
    const a = loadPolicy(cfg)
    const b = loadPolicy(cfg)
    const c = loadPolicy(cfg)
    expect(a.policy.network.allowModelDownloads).toBe(true)
    expect(b).toEqual(a)
    expect(c).toEqual(a)
    // Polled three times → parsed exactly once (the other two are stat-only cache hits).
    expect(__policyMaterializations()).toBe(1)

    // Rewrite policy.json to a different content+size → the mtime/size signature changes → re-read.
    writeFileSync(join(cfg, 'policy.json'), COMMERCIAL_POLICY)
    const d = loadPolicy(cfg)
    expect(d.policy.network.allowModelDownloads).toBe(false) // the live edit is reflected
    expect(__policyMaterializations()).toBe(2)
  })

  it('degrades to defaults + warning on a malformed drive.json (no throw)', () => {
    const warn = vi.fn()
    const loaded = loadPolicy(configDir({ drive: 'nonsense{' }), warn)
    expect(loaded.driveFilePresent).toBe(false)
    expect(loaded.allowNetworkByDefault).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  // M-4: a packaged build must FAIL CLOSED to the strict commercial posture, not the
  // dev-friendly default, when policy.json is missing/malformed/partial. Since issue #93
  // the fail-closed scope is a PROVISIONED config dir — one carrying policy.json (even
  // malformed) or the prepared-drive marker drive.json; a dir with neither (the app-data
  // fallback root of a standalone portable install) never had a policy to lose.
  describe('fail-closed on a packaged build (M-4)', () => {
    it('adopts STRICT_POLICY when a prepared drive (drive.json present) has no policy.json', () => {
      const loaded = loadPolicy(
        configDir({ drive: JSON.stringify({ allow_network_by_default: false }) }),
        undefined,
        { isDev: false }
      )
      expect(loaded.policy).toEqual(STRICT_POLICY)
      expect(loaded.policyFilePresent).toBe(false)
      expect(loaded.driveFilePresent).toBe(true)
      // The dev fallback would have loosened these — the strict fallback locks them down.
      expect(loaded.policy.models.allowUnverifiedModels).toBe(false)
      expect(loaded.policy.models.requireSha256Match).toBe(true)
      expect(loaded.policy.workspace.encryptionRequired).toBe(true)
      expect(loaded.policy.network.allowModelDownloads).toBe(false)
    })

    // Issue #93: the portable GitHub-release exe run standalone lands on the app-data
    // fallback root — no drive.json, no policy.json, and no way for prepare-drive to have
    // ever written one. Failing closed there permanently disabled the in-app downloader
    // the release notes point users to (the Settings toggle can only enable what the
    // policy ceiling already allows). Such an UNPROVISIONED dir gets the standalone
    // fallback: model downloads policy-permitted, everything else still strict.
    describe('standalone fallback for an unprovisioned config dir (issue #93)', () => {
      it('permits model downloads when NEITHER policy.json nor drive.json exists (packaged)', () => {
        const loaded = loadPolicy(configDir(), undefined, { isDev: false })
        expect(loaded.policyFilePresent).toBe(false)
        expect(loaded.driveFilePresent).toBe(false)
        expect(loaded.policy.network.allowModelDownloads).toBe(true)
        // Update checks + telemetry stay off in every posture — no exceptions.
        expect(loaded.policy.network.allowUpdateChecks).toBe(false)
        expect(loaded.policy.network.allowTelemetry).toBe(false)
        // Workspace + model enforcement stays at the STRICT value: the standalone fallback
        // relaxes ONLY the downloads ceiling, so M-4/M-6 model-integrity is untouched.
        expect(loaded.policy.workspace.encryptionRequired).toBe(true)
        expect(loaded.policy.workspace.allowPlaintextDevMode).toBe(false)
        expect(loaded.policy.models.allowUnverifiedModels).toBe(false)
        expect(loaded.policy.models.requireSha256Match).toBe(true)
      })

      it('end-to-end: downloads are effectively allowed with the default-ON setting (#93 repro)', () => {
        // The exact #93 state: portable exe, empty app-data config dir, allowNetwork ON.
        const status = buildPolicyStatus(configDir(), true, undefined, { isDev: false })
        expect(status.networkAllowedByPolicy).toBe(true)
        expect(status.networkAllowed).toBe(true)
        expect(status.policy.network.allowModelDownloads).toBe(true)
        expect(status.telemetryAllowed).toBe(false)
        // The user can still switch downloads off — the setting remains the gate.
        expect(buildPolicyStatus(configDir(), false, undefined, { isDev: false }).networkAllowed).toBe(
          false
        )
      })

      it('a malformed policy.json still fails closed even without drive.json (provisioned intent)', () => {
        const warn = vi.fn()
        const loaded = loadPolicy(configDir({ policy: '{ nope' }), warn, { isDev: false })
        expect(loaded.policy).toEqual(STRICT_POLICY)
        expect(warn).toHaveBeenCalled()
      })
    })

    it('keeps the dev-friendly default when isDev', () => {
      expect(loadPolicy(configDir(), undefined, { isDev: true }).policy).toEqual(DEFAULT_POLICY)
      // No opts ⇒ dev default (canonical reference / unit callers).
      expect(loadPolicy(configDir()).policy).toEqual(DEFAULT_POLICY)
    })

    it('falls back to STRICT on malformed JSON in a packaged build', () => {
      const warn = vi.fn()
      const loaded = loadPolicy(configDir({ policy: '{ not json' }), warn, { isDev: false })
      expect(loaded.policy).toEqual(STRICT_POLICY)
      // policyFilePresent is true (the file exists) but its content was rejected.
      expect(loaded.policyFilePresent).toBe(true)
      expect(warn).toHaveBeenCalled()
    })

    it('leaves a PARTIAL file at the strict value for omitted fields (packaged)', () => {
      // A junk/partial file that only flips model downloads on must not loosen the rest.
      const loaded = loadPolicy(
        configDir({ policy: JSON.stringify({ network: { allow_model_downloads: true } }) }),
        undefined,
        { isDev: false }
      )
      expect(loaded.policy.network.allowModelDownloads).toBe(true) // the one set field
      expect(loaded.policy.workspace.encryptionRequired).toBe(true) // strict base survives
      expect(loaded.policy.models.requireSha256Match).toBe(true)
      expect(loaded.policy.models.allowUnverifiedModels).toBe(false)
    })

    it('honours an explicit commercial policy.json regardless of build type', () => {
      const loaded = loadPolicy(configDir({ policy: COMMERCIAL_POLICY }), undefined, { isDev: false })
      expect(loaded.policy.workspace.encryptionRequired).toBe(true)
      expect(loaded.policy.models.requireSha256Match).toBe(true)
    })
  })
})

// ---- deny-by-default + effective permission -------------------------------------

describe('resolveNetwork (effective = policy ∧ setting)', () => {
  it('with no policy file, the user setting is the gate (Phase 18, D3a)', () => {
    // DEFAULT_POLICY permits model downloads since Phase 18 (wave-1 decision D3 (architecture.md "In-app model downloader") resolved (a)):
    // the spec §3.6 Settings toggle is the effective gate when no policy file restricts.
    // Update checks + telemetry stay denied with no toggle at all; the download toggle
    // ships ON by default (since 2026-06-13) — both toggle directions are asserted below.
    expect(DEFAULT_POLICY.network.allowUpdateChecks).toBe(false)
    expect(DEFAULT_POLICY.network.allowTelemetry).toBe(false)
    const off = resolveNetwork(DEFAULT_POLICY, false) // toggle off
    expect(off.networkAllowed).toBe(false)
    expect(off.offlineMode).toBe(true)
    const on = resolveNetwork(DEFAULT_POLICY, true) // explicit user opt-in
    expect(on.networkAllowedByPolicy).toBe(true)
    expect(on.networkAllowed).toBe(true)
    expect(on.offlineMode).toBe(false)
  })

  it('policy forbids ⇒ off even when the user setting is on', () => {
    const policy = parsePolicy(COMMERCIAL_POLICY)
    const net = resolveNetwork(policy, true)
    expect(net.networkAllowed).toBe(false)
    expect(net.offlineMode).toBe(true)
  })

  it('policy permits + setting on ⇒ on', () => {
    const policy = parsePolicy(PERMISSIVE_POLICY)
    const net = resolveNetwork(policy, true)
    expect(net.networkAllowedByPolicy).toBe(true)
    expect(net.networkAllowed).toBe(true)
    expect(net.offlineMode).toBe(false)
  })

  it('policy permits + setting off ⇒ off (off by choice)', () => {
    const policy = parsePolicy(PERMISSIVE_POLICY)
    const net = resolveNetwork(policy, false)
    expect(net.networkAllowedByPolicy).toBe(true)
    expect(net.networkAllowed).toBe(false)
    expect(net.offlineMode).toBe(true)
  })
})

// ---- buildPolicyStatus (getPolicy IPC shape) ------------------------------------

describe('buildPolicyStatus', () => {
  it('derives the full status; telemetry is always off', () => {
    const status = buildPolicyStatus(configDir({ policy: PERMISSIVE_POLICY }), true)
    expect(status.policyFilePresent).toBe(true)
    expect(status.allowNetworkSetting).toBe(true)
    expect(status.networkAllowedByPolicy).toBe(true)
    expect(status.networkAllowed).toBe(true)
    expect(status.offlineMode).toBe(false)
    expect(status.telemetryAllowed).toBe(false)
  })

  it('reports offline by default with no files + the setting off', () => {
    const status = buildPolicyStatus(configDir(), false)
    expect(status.networkAllowed).toBe(false)
    expect(status.offlineMode).toBe(true)
    expect(status.telemetryAllowed).toBe(false)
  })
})

// ---- offline self-check: loopback exempt, remote flagged ------------------------

describe('offline self-check', () => {
  it('treats loopback / localhost / unspecified hosts as NOT a network call', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
    expect(isLoopbackHost('[::1]')).toBe(true)
    expect(isLoopbackHost('127.0.0.53')).toBe(true)
    expect(isLoopbackHost(undefined)).toBe(true)
    expect(isLoopbackHost('')).toBe(true)
  })

  it('does NOT misclassify a 127.* HOSTNAME as loopback (L-1 anchored regex)', () => {
    // The old unanchored /^127\./ matched these remote hosts as loopback.
    expect(isLoopbackHost('127.evil.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.evil.com')).toBe(false)
    expect(isLoopbackHost('127.0.0.1.example.org')).toBe(false)
    // Genuine IPv4 loopback addresses still match.
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('127.255.255.255')).toBe(true)
  })

  it('treats remote hosts as a violation only while offline', () => {
    expect(checkOutboundHost('93.184.216.34', true).violation).toBe(true)
    expect(checkOutboundHost('api.openai.com', true).violation).toBe(true)
    // Loopback is never a violation, even offline.
    expect(checkOutboundHost('127.0.0.1', true).violation).toBe(false)
    // When network is allowed (not offline), nothing is flagged.
    expect(checkOutboundHost('api.openai.com', false).violation).toBe(false)
  })

  it('installOfflineNetworkGuard flags a remote connect attempt but allows loopback', () => {
    const onViolation = vi.fn()
    // Replace the real connect with a stub BEFORE installing, so the guard wraps the
    // stub and the test never opens a real socket.
    const stub = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (
      this: net.Socket
    ) {
      return this
    })
    const uninstall = installOfflineNetworkGuard({ offline: true, onViolation })
    try {
      const sock = new net.Socket()
      sock.connect(443, 'example.com')
      sock.connect(8080, '127.0.0.1')
    } finally {
      uninstall()
      stub.mockRestore()
    }
    expect(onViolation).toHaveBeenCalledTimes(1)
    expect(onViolation).toHaveBeenCalledWith('example.com')
  })

  it('is a no-op when not offline (no patch installed)', () => {
    const before = net.Socket.prototype.connect
    const uninstall = installOfflineNetworkGuard({ offline: false })
    expect(net.Socket.prototype.connect).toBe(before)
    uninstall()
  })

  it('assertOfflinePosture logs and returns an uninstaller without throwing', () => {
    const log = vi.fn()
    const warn = vi.fn()
    const uninstall = assertOfflinePosture({
      posture: { offline: true, networkAllowed: false },
      installGuard: false,
      log,
      warn
    })
    expect(log).toHaveBeenCalled()
    expect(() => uninstall()).not.toThrow()
  })
})

// ---- no-network guarantee across the core path ----------------------------------

describe('offline guarantee (core path: settings + status + policy)', () => {
  it('makes zero network calls loading settings, policy, and deriving status', () => {
    const httpSpy = vi.spyOn(http, 'request')
    const httpsSpy = vi.spyOn(https, 'request')
    const connectSpy = vi.spyOn(net, 'connect')
    const socketConnectSpy = vi.spyOn(net.Socket.prototype, 'connect')
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    const db = freshDb()
    seedSettings(db)
    updateSettings(db, { allowNetwork: true })
    const cfg = configDir({ policy: PERMISSIVE_POLICY, drive: JSON.stringify({ allow_network_by_default: true }) })
    const status = buildPolicyStatus(cfg, getSettings(db).allowNetwork)
    expect(status.networkAllowed).toBe(true) // exercised the full resolution path

    expect(httpSpy).not.toHaveBeenCalled()
    expect(httpsSpy).not.toHaveBeenCalled()
    expect(connectSpy).not.toHaveBeenCalled()
    expect(socketConnectSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

// ---- Local API policy ceiling (local-api wave P2 item 4; O3/O4 owner-ratified) ----------

describe('local API policy ceiling (local-api P2)', () => {
  it('postures: DEFAULT permits, STRICT denies, STANDALONE permits (O3)', async () => {
    const { STANDALONE_POLICY } = await import('../../src/main/services/policy')
    expect(DEFAULT_POLICY.network.allowLocalApi).toBe(true)
    expect(STRICT_POLICY.network.allowLocalApi).toBe(false)
    expect(STANDALONE_POLICY.network.allowLocalApi).toBe(true)
  })

  it('policy.json allow_local_api merges (restrict-only over DEFAULT); junk keeps the base', () => {
    const off = parsePolicy('{"network":{"allow_local_api":false}}')
    expect(off.network.allowLocalApi).toBe(false)
    const junk = parsePolicy('{"network":{"allow_local_api":"yes"}}')
    expect(junk.network.allowLocalApi).toBe(true) // non-boolean never widens or narrows
  })

  it('effective = policy AND setting: the ceiling always wins', async () => {
    // Shared module (not main services): the P4 renderer card imports the SAME rule.
    const { localApiEffectivelyEnabled } = await import('../../src/shared/local-api')
    const allow = DEFAULT_POLICY
    const deny = parsePolicy('{"network":{"allow_local_api":false}}')
    expect(localApiEffectivelyEnabled(deny, true)).toBe(false) // policy off beats setting on
    expect(localApiEffectivelyEnabled(allow, false)).toBe(false) // default-off setting holds
    expect(localApiEffectivelyEnabled(allow, true)).toBe(true)
    expect(localApiEffectivelyEnabled(deny, false)).toBe(false)
  })

  it('buildPolicyStatus carries the ceiling via policy.network.allowLocalApi (the card input)', () => {
    // No 1:1 copy field on PolicyStatus (review 2026-08-18): consumers read the policy.
    __resetPolicyCache()
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-lapi-'))
    writeFileSync(join(dir, 'policy.json'), '{"network":{"allow_local_api":false}}')
    expect(buildPolicyStatus(dir, true).policy.network.allowLocalApi).toBe(false)
    const dir2 = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-lapi2-'))
    expect(buildPolicyStatus(dir2, true).policy.network.allowLocalApi).toBe(true) // dev default
  })

  it('a drive whose policy PREDATES allow_local_api inherits the permissive default', () => {
    // Owner decision 2026-08-18, taken after checking a REAL 2026-06-30 "lite" drive: every
    // drive already in the field has a valid policy.json with no allow_local_api key, and
    // inheriting a packaged build's STRICT base silently denied the feature on all of them.
    // An ABSENT key now means "not yet decided" and inherits DEFAULT (permitted) — the setting
    // is still default-off behind the consent dialog, so this permits, it does not enable.
    __resetPolicyCache()
    const legacy = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-legacy-'))
    writeFileSync(join(legacy, 'drive.json'), '{"edition":"lite"}')
    // Byte-for-byte the shape a pre-wave prepare-drive wrote: every other key present.
    writeFileSync(
      join(legacy, 'policy.json'),
      JSON.stringify({
        network: { allow_model_downloads: true, allow_update_checks: false },
        workspace: { encryption_required: true, allow_plaintext_dev_mode: false },
        models: { allow_unverified_models: false, require_manifest: true, require_sha256_match: true }
      })
    )
    const packaged = loadPolicy(legacy, undefined, { isDev: false }).policy
    expect(packaged.network.allowLocalApi).toBe(true)
    // …while every OTHER key the file does state is still honored, strictly.
    expect(packaged.workspace.encryptionRequired).toBe(true)
    expect(packaged.workspace.allowPlaintextDevMode).toBe(false)
    expect(packaged.models.requireSha256Match).toBe(true)
    expect(packaged.network.allowUpdateChecks).toBe(false)
  })

  it('the absent-key rule holds for the SHARPEST shapes: {} and a missing network block', () => {
    // Self-review of the P7 change: `asObject` turns a missing/non-object `network` into {},
    // so these shapes all take the ABSENT path — the local API is permitted while every OTHER
    // network field stays STRICT. That asymmetry is inherent to the owner's decision (absence
    // means undecided) and is the documented footgun: a drive that wants the feature off must
    // say so EXPLICITLY. Pinned here so nobody flips it silently in either direction.
    for (const [label, body] of [
      ['empty object', '{}'],
      ['no network block', '{"workspace":{"encryption_required":true}}'],
      ['non-object network', '{"network":"nope"}'],
      ['null value', '{"network":{"allow_local_api":null}}']
    ] as Array<[string, string]>) {
      __resetPolicyCache()
      const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-shape-'))
      writeFileSync(join(dir, 'drive.json'), '{}')
      writeFileSync(join(dir, 'policy.json'), body)
      const net = loadPolicy(dir, undefined, { isDev: false }).policy.network
      // `null` is present-but-not-a-boolean, so it fails CLOSED like any other junk value;
      // the three genuinely ABSENT shapes are permitted.
      expect(net.allowLocalApi, label).toBe(label !== 'null value')
      // …and the rest of the network block still comes from STRICT in every shape.
      expect(net.allowModelDownloads, label).toBe(false)
      expect(net.allowUpdateChecks, label).toBe(false)
    }
  })

  it('an EXPLICIT allow_local_api: false still denies, and junk fails CLOSED (not open)', () => {
    // The permissive default applies ONLY to an absent key. O4 — commercial drives write an
    // explicit false — must be unaffected, and a garbage value must never fail open.
    __resetPolicyCache()
    const denied = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-explicit-'))
    writeFileSync(join(denied, 'drive.json'), '{}')
    writeFileSync(join(denied, 'policy.json'), '{"network":{"allow_local_api":false}}')
    expect(loadPolicy(denied, undefined, { isDev: false }).policy.network.allowLocalApi).toBe(false)

    __resetPolicyCache()
    const junk = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-junk-'))
    writeFileSync(join(junk, 'drive.json'), '{}')
    writeFileSync(join(junk, 'policy.json'), '{"network":{"allow_local_api":"no"}}')
    // Present-but-not-a-boolean falls back to the STRICT base for a packaged build.
    expect(loadPolicy(junk, undefined, { isDev: false }).policy.network.allowLocalApi).toBe(false)

    // A MALFORMED file is a different path (parsePolicy returns the base) — still closed.
    __resetPolicyCache()
    const broken = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-broken-'))
    writeFileSync(join(broken, 'drive.json'), '{}')
    writeFileSync(join(broken, 'policy.json'), '{ this is not json')
    expect(loadPolicy(broken, undefined, { isDev: false }).policy.network.allowLocalApi).toBe(false)
    // And the STRICT constant itself is untouched — it is what a malformed file falls back to.
    expect(STRICT_POLICY.network.allowLocalApi).toBe(false)
  })

  it('a packaged build fails CLOSED on a provisioned dir; standalone keeps the O3 posture', () => {
    __resetPolicyCache()
    // Provisioned (drive.json marker) + missing policy.json => STRICT => local API denied.
    const provisioned = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-lapi3-'))
    writeFileSync(join(provisioned, 'drive.json'), '{}')
    expect(loadPolicy(provisioned, undefined, { isDev: false }).policy.network.allowLocalApi).toBe(false)
    // Unprovisioned app-data root => STANDALONE => permitted (setting still default-off).
    const standalone = mkdtempSync(join(tmpdir(), 'hilbertraum-policy-lapi4-'))
    expect(loadPolicy(standalone, undefined, { isDev: false }).policy.network.allowLocalApi).toBe(true)
  })
})
