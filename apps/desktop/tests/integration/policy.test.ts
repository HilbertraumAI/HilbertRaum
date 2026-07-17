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
  // dev-friendly default, when policy.json is missing/malformed/partial.
  describe('fail-closed on a packaged build (M-4)', () => {
    it('adopts STRICT_POLICY when no policy.json exists', () => {
      const loaded = loadPolicy(configDir(), undefined, { isDev: false })
      expect(loaded.policy).toEqual(STRICT_POLICY)
      expect(loaded.policyFilePresent).toBe(false)
      // The dev fallback would have loosened these — the strict fallback locks them down.
      expect(loaded.policy.models.allowUnverifiedModels).toBe(false)
      expect(loaded.policy.models.requireSha256Match).toBe(true)
      expect(loaded.policy.workspace.encryptionRequired).toBe(true)
      expect(loaded.policy.network.allowModelDownloads).toBe(false)
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
