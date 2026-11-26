import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCommercialDrive, KIT_PLATFORM_SPECS } from '../../src/main/services/commercial-drive'
import { buildPolicyJson, DRIVE_LAYOUT_DIRS } from '../../src/main/services/drive'
import { writeRuntimeMarker } from '../../src/main/services/assets'
import { rootArtifactOf } from '../../src/main/services/updates/drive-release'
import type { ModelManifest } from '../../src/shared/manifest'
import { validManifest, writeDriveFile } from '../helpers/manifest-fixtures'
import { canMakeUnreadable, makeUnreadable } from '../helpers/unreadable-dir'
import { allowReading, denyReading } from '../helpers/binary-fixtures'
import {
  KIT_PLATFORMS,
  validateRuntimeSources,
  type KitPlatform,
  type RuntimeSources
} from '../../src/shared/runtime-sources'

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

// The app artifact + launcher a kit must carry per platform it is sold for (#233). The
// names are spelled here as literals (not the exported table) so the test stays an
// independent check of what the launchers look for on the drive root.
const APP_VERSION = '0.1.59'
const ALL_PLATFORMS: KitPlatform[] = ['win-x64', 'mac-arm64', 'linux-x64']
const LAUNCHER: Record<KitPlatform, string> = {
  'win-x64': 'Start HilbertRaum.cmd',
  'mac-arm64': 'Start HilbertRaum.command',
  'linux-x64': 'start-hilbertraum.sh'
}
const ARTIFACT: Record<KitPlatform, string> = {
  'win-x64': `HilbertRaum-${APP_VERSION}-portable.exe`,
  'mac-arm64': `HilbertRaum-${APP_VERSION}-mac-arm64.app.zip`,
  'linux-x64': `HilbertRaum-${APP_VERSION}.AppImage`
}

/** The support end in the Kit builder's bytes (W-17): the month and one line feed, 8 bytes. */
const KIT_STAMP = '2031-12\n'

/** The two Kit files the gate reads under config/ (T3.8). */
const RECORD = join('config', 'drive-release.json')
const STAMP = join('config', 'kit-support.txt')

/** Write `config/drive-release.json` (W-20). The gate reads its `app_version` alone, so the record holds only that. */
function writeRecord(root: string, text = JSON.stringify({ format: 1, app_version: APP_VERSION })): void {
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, RECORD), text)
}

/**
 * Place one app artifact + one launcher per platform at the drive root, and the two files the Kit builder writes last
 * (T3.3b): the release record naming the apps' version and the support end in the builder's bytes.
 */
function provisionApp(root: string, platforms: KitPlatform[] = ALL_PLATFORMS): void {
  for (const p of platforms) {
    writeFileSync(join(root, ARTIFACT[p]), 'app-bytes')
    writeFileSync(join(root, LAUNCHER[p]), 'launcher')
  }
  writeRecord(root)
  writeFileSync(join(root, STAMP), KIT_STAMP)
}

/** The declared platform matrix the gate is asked to check against. */
function kit(platforms: KitPlatform[] = ALL_PLATFORMS): { platforms: KitPlatform[]; appVersion: string } {
  return { platforms, appVersion: APP_VERSION }
}

/** How the gate's lines name the record helper (`<W>` of the T3.8 sheet): the target is the operator's own drive root. */
const WRITE_RECORD = 'node --no-warnings scripts/lib/write-drive-release.mjs --target <drive root>'
/** The gate's lines for a Kit without its record or its support end (T3.8 sheet, R1 and S1). */
const RECORD_MISSING_LINE = `config/drive-release.json is missing — write it: ${WRITE_RECORD}, then run the check again (-VerifyOnly / --verify-only writes nothing)`
const STAMP_MISSING_LINE =
  "config/kit-support.txt is missing — stamp the Kit's support end: run build-commercial-drive with -SupportEnd / --support-end " +
  '<YYYY-MM> (it writes the stamp once per Kit)'

/** An extracted macOS bundle with an Info.plist: refused on a Kit since T3.8 (a Kit carries the zip; owner, sheet Q1). */
function provisionExtractedApp(root: string, version: string): void {
  const contents = join(root, 'HilbertRaum.app', 'Contents')
  mkdirSync(join(contents, 'MacOS'), { recursive: true })
  writeFileSync(
    join(contents, 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '  <key>CFBundleName</key><string>HilbertRaum</string>',
      '  <key>CFBundleShortVersionString</key>',
      `  <string>${version}</string>`,
      '</dict></plist>'
    ].join('\n')
  )
}

/** A sold drive's weights: bundled, and past the review the shared factory's pending default would fail. */
const asManifest = (overrides: Record<string, unknown> = {}): ModelManifest =>
  validManifest({
    license_review: { status: 'approved', reviewed_by: 'legal', reviewed_at: '2026-06-09', notes: '' },
    bundled_on_preconfigured_drive: true,
    ...overrides
  })

/** Write a weight file + return a manifest whose sha256 matches its content (VERIFIED). */
const writeVerifiedWeight = (root: string, id: string, relPath: string, content: string): ModelManifest =>
  asManifest({ id, local_path: relPath, sha256: writeDriveFile(root, relPath, content) })

function writePolicy(root: string, json: unknown): void {
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify(json))
}

/**
 * Root license/attribution artifacts (LIC-1, full-audit 2026-07-12b) — prepare-drive copies
 * these three files from the repo root to the DRIVE root; the sell gate requires them
 * present and non-empty. Spelled as literals here (not the exported constant) so the test
 * stays an independent check of the canonical list.
 */
function provisionLicenseArtifacts(root: string): void {
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'DRIVE-NOTICES.md']) {
    writeFileSync(join(root, name), `${name} text`)
  }
}

/** Provision a trusted product skill under app-skills/ (skills plan S9) — a sold drive ships one. */
function provisionAppSkill(root: string, id = 'bank-statement'): void {
  const dir = join(root, 'app-skills', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    ['---', `id: ${id}`, `title: ${id}`, `description: ${id} skill`, 'version: 1.0.0', '---', 'Guidance.'].join('\n')
  )
}

describe('assertCommercialDrive', () => {
  it('passes on a verified, commercial-posture drive with no user data', async () => {
    const root = tempDir('hilbertraum-commercial-ok-')
    writePolicy(root, buildPolicyJson({ kit: true })) // the Kit's policy: the commercial posture + the updates key
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const embed = writeVerifiedWeight(root, 'embed', 'models/embeddings/e5.gguf', 'embed-weights')
    provisionApp(root)

    const res = await assertCommercialDrive(root, [chat, embed], null, null, null, kit())

    expect(res.ok).toBe(true)
    expect(res.problems).toEqual([])
    // Exact shape: a new check must be added here on purpose (#233, #234).
    expect(res.checks).toEqual({
      policyCommercial: true,
      networkDenied: true,
      kitUpdatesKey: true, // T3.8
      weightsVerified: true,
      licensesApproved: true,
      noUserData: true,
      runtimeCurrent: true,
      runtimeHashed: true,
      optionalRuntimesConsistent: true, // #339 P8-1
      kiwixSourceBundle: true, // #339 P8-4
      ocrAssetsVerified: true,
      appSkillsPresent: true,
      userSkillsEmpty: true,
      licenseArtifactsPresent: true,
      platformMatrixDeclared: true,
      appArtifactsPresent: true,
      launchersPresent: true,
      releaseRecordCurrent: true, // T3.8
      supportEndStamped: true // T3.8
    })
  })

  // #339 P8-1: the OPTIONAL kiwix_tools family rides `opts.families`. It is either FULLY
  // provisioned — every executable and required runtime file present, the marker current,
  // every hash recorded and matching — or ENTIRELY absent; anything in between fails
  // `optionalRuntimesConsistent` and never touches `runtimeCurrent` / `runtimeHashed`.
  describe('the optional kiwix_tools family (#339 P8-1)', () => {
    const KIWIX_FILES = ['kiwix-serve.exe', 'kiwix-manage.exe', 'kiwix-search.exe', 'icudt74.dll', 'icuuc74.dll']
    /** The drive's runtime-sources.yaml for these legs, as the object a yaml file parses to. */
    const kiwixSourcesYaml = (opts: { declare?: boolean } = {}): Record<string, unknown> => ({
      llama_cpp: {
        version: 'b1',
        builds: [{ os: 'win', arch: 'x64', backend: 'cpu', url: 'https://example.test/l.zip', sha256: 'a'.repeat(64), extract_to: 'runtime/llama.cpp/win' }]
      },
      kiwix_tools: {
        version: '3.8.1',
        optional: true,
        executables: ['kiwix-serve', 'kiwix-manage', 'kiwix-search'],
        // #339 P8-4: the corresponding-source bundle rides every fixture — with binaries on
        // the drive the gate requires it, so a fixture without it is the 'undeclared' leg.
        ...(opts.declare === false
          ? {}
          : {
              source_bundle: {
                dir: 'runtime/kiwix-tools/source',
                recipe_url: 'https://github.com/kiwix/kiwix-build',
                files: BUNDLE_FILES.map((name) => ({
                  component: name.replace(/-[0-9].*$/, ''),
                  version: '1',
                  license: 'GPL-3.0-or-later',
                  name,
                  sha256: sha(`source of ${name}`),
                  url: `https://example.test/${name}`
                }))
              }
            }),
        builds: [
          {
            os: 'win',
            arch: 'x64',
            backend: 'cpu',
            url: 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-x86_64-3.8.1.zip',
            sha256: 'fcd01ed2b93e9a68632c7863c83b9f66bf64406a66357be1df7b8b75596f3e45',
            extract_to: 'runtime/kiwix-tools/win',
            runtime_files: ['icudt74.dll', 'icuuc74.dll']
          },
          { os: 'mac', arch: 'arm64', backend: 'cpu', url: 'https://example.test/m-arm64.tar.gz', sha256: 'b'.repeat(64), extract_to: 'runtime/kiwix-tools/mac' },
          { os: 'mac', arch: 'x64', backend: 'cpu', url: 'https://example.test/m-x64.tar.gz', sha256: 'c'.repeat(64), extract_to: 'runtime/kiwix-tools/mac' }
        ]
      }
    })
    const kiwixSources = (opts: { declare?: boolean } = {}): RuntimeSources => {
      const res = validateRuntimeSources(kiwixSourcesYaml(opts))
      if (!res.families?.kiwix_tools) throw new Error('fixture invalid: ' + res.errors.join(', '))
      return res.families.kiwix_tools
    }
    const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
    /** A full, hashed kiwix install on win (all five files) and on mac (the arm64 build's three). */
    function provisionKiwix(root: string, over: { omit?: string; hashless?: boolean; tamper?: string; macArch?: string; noBundle?: boolean } = {}): void {
      if (!over.noBundle) provisionBundle(root)
      const win = join(root, 'runtime', 'kiwix-tools', 'win')
      mkdirSync(win, { recursive: true })
      const binaries: Record<string, string> = {}
      for (const f of KIWIX_FILES) {
        if (f === over.omit) continue
        writeFileSync(join(win, f), over.tamper === f ? 'tampered' : `bytes of ${f}`)
        binaries[f] = sha(`bytes of ${f}`)
      }
      writeRuntimeMarker(win, { version: '3.8.1', backend: 'cpu', os: 'win', arch: 'x64', ...(over.hashless ? {} : { binaries }) })
      const mac = join(root, 'runtime', 'kiwix-tools', 'mac')
      mkdirSync(mac, { recursive: true })
      const macBinaries: Record<string, string> = {}
      for (const f of ['kiwix-serve', 'kiwix-manage', 'kiwix-search']) {
        writeFileSync(join(mac, f), `mac bytes of ${f}`)
        macBinaries[f] = sha(`mac bytes of ${f}`)
      }
      writeRuntimeMarker(mac, { version: '3.8.1', backend: 'cpu', os: 'mac', arch: over.macArch ?? 'arm64', binaries: macBinaries })
    }
    async function gate(root: string, chat: ModelManifest) {
      return assertCommercialDrive(root, [chat], null, null, null, { ...kit(), families: { kiwix_tools: kiwixSources() } })
    }
    function sellable(prefix: string): { root: string; chat: ModelManifest } {
      const root = tempDir(prefix)
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      provisionApp(root)
      return { root, chat }
    }

    it('a fully provisioned kiwix_tools family passes the gate (every executable and runtime file hashed and matching)', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-ok-')
      provisionKiwix(root)
      const res = await gate(root, chat)
      expect(res.problems).toEqual([])
      expect(res.ok).toBe(true)
      expect(res.checks.optionalRuntimesConsistent).toBe(true)
    })

    it('a drive carrying no kiwix_tools files at all is still sellable (an optional family may be absent)', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-absent-')
      const res = await gate(root, chat)
      expect(res.ok).toBe(true)
      expect(res.checks.optionalRuntimesConsistent).toBe(true)
      // …and a null entry means "not declared on this drive" — nothing to check.
      const none = await assertCommercialDrive(root, [chat], null, null, null, { ...kit(), families: { kiwix_tools: null } })
      expect(none.ok).toBe(true)
    })

    // #1028: only an ABSENT marker makes an optional family absent. A damaged one left behind (a copy cut short) is a
    // half-shipped install, not a Kit without the tools.
    it('a kiwix_tools folder holding only a damaged marker fails the gate: the family is not absent (#1028)', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-cut-')
      writeDriveFile(root, 'runtime/kiwix-tools/win/.hilbertraum-runtime.json', '{"version":"3.8.1","backend":"cpu","os":"win"')
      const res = await gate(root, chat)
      expect(res.ok).toBe(false)
      expect(res.checks.optionalRuntimesConsistent).toBe(false)
      // Review round 2 (L-7): the line names the marker, and the way out for a Kit sold without the tools.
      expect(res.problems, res.problems.join('\n')).toContain(
        'kiwix_tools build win/x64 cpu: runtime/kiwix-tools/win holds only a damaged .hilbertraum-runtime.json install marker — ' +
          'for a Kit without this family, delete the leftover marker; else re-run fetch-runtime for this build'
      )
    })

    // Code review (CR-3): a marker that cannot be read just now, alone in the folder, is no absent family either, and no
    // missing binary: the builder is told the read failed.
    it('a kiwix_tools folder holding only a marker that cannot be read fails the gate with that line (#1028)', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-deny-')
      writeDriveFile(root, 'runtime/kiwix-tools/win/.hilbertraum-runtime.json', '{"version":"3.8.1","backend":"cpu","os":"win","arch":"x64"}')
      const marker = join(root, 'runtime', 'kiwix-tools', 'win', '.hilbertraum-runtime.json')
      denyReading(marker)
      try {
        const res = await gate(root, chat)
        expect(res.ok).toBe(false)
        expect(res.checks.optionalRuntimesConsistent).toBe(false)
        expect(
          res.problems.some((p) =>
            /^kiwix_tools build win\/x64 cpu: the \.hilbertraum-runtime\.json install marker under runtime\/kiwix-tools\/win could not be read \(E[A-Z]+\) — check the drive, then run the gate again$/.test(p)
          ),
          res.problems.join('\n')
        ).toBe(true)
      } finally {
        allowReading(marker)
      }
    })

    it.each([
      ['missing kiwix-manage', { omit: 'kiwix-manage.exe' }, /missing under runtime\/kiwix-tools\/win: kiwix-manage\.exe/],
      ['missing an ICU DLL', { omit: 'icuuc74.dll' }, /missing under runtime\/kiwix-tools\/win: icuuc74\.dll/],
      ['a hashless marker', { hashless: true }, /records no SHA-256 for kiwix-serve\.exe/],
      ['one tampered file', { tamper: 'kiwix-manage.exe' }, /kiwix-manage\.exe does not match the SHA-256 recorded/]
    ] as const)('a half-installed kiwix_tools family fails optionalRuntimesConsistent — %s', async (_name, over, message) => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-half-')
      provisionKiwix(root, over)
      const res = await gate(root, chat)
      expect(res.ok).toBe(false)
      expect(res.checks.optionalRuntimesConsistent).toBe(false)
      expect(res.problems.some((p) => message.test(p)), res.problems.join('\n')).toBe(true)
      // …and never the REQUIRED families' flags.
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(true)
    })

    // T3.8 (W-33; T3.12 review 1 M-2): every file in the tools' folder is in its marker's map, as for the engines; an
    // optional family reports through its own flag.
    it('a file the knowledge-pack tools marker does not record fails optionalRuntimesConsistent, not the engine flags (T3.8)', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-extra-')
      provisionKiwix(root)
      writeFileSync(join(root, 'runtime', 'kiwix-tools', 'win', 'icuin74.dll'), 'a hand-copied library')
      const res = await gate(root, chat)
      expect(res.problems).toEqual([
        'kiwix_tools build win/x64 cpu: 1 file under runtime/kiwix-tools/win is not recorded in the install marker: icuin74.dll — ' +
          'delete what does not belong to the engine; for an engine installed by an older fetch-runtime, delete ' +
          'runtime/kiwix-tools/win and run build-commercial-drive again (fetch-runtime skips an engine it finds installed)'
      ])
      expect(res.checks.optionalRuntimesConsistent).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(true)
    })

    // #339 P8-4: the corresponding-source bundle. Presence is FILE-based (a marker-less,
    // hand-placed executable triggers the check); no binary ⇒ not applicable ⇒ pass.
    const BUNDLE_FILES = ['kiwix-tools-3.8.1.tar.xz', 'libkiwix-14.1.1.tar.xz', 'libzim-9.4.0.tar.xz', 'xapian-core-1.4.23.tar.xz', 'libmicrohttpd-0.9.76.tar.gz']
    function provisionBundle(root: string, over: { omit?: string; tamper?: string; noRecord?: boolean; extra?: boolean } = {}): void {
      const dir = join(root, 'runtime', 'kiwix-tools', 'source')
      mkdirSync(dir, { recursive: true })
      for (const name of BUNDLE_FILES) {
        if (name === over.omit) continue
        writeFileSync(join(dir, name), over.tamper === name ? 'tampered' : `source of ${name}`)
      }
      if (!over.noRecord) writeFileSync(join(dir, 'SOURCES.md'), '# Complete corresponding source\n')
      if (over.extra) writeFileSync(join(dir, 'libzim-9.4.0.tar.xz.md5'), 'd7cb45cff5b8d08439f8f2502e794aae\n')
    }
    async function gateWithBundle(root: string, chat: ModelManifest, opts: { declare?: boolean } = {}) {
      return assertCommercialDrive(root, [chat], null, null, null, { ...kit(), families: { kiwix_tools: kiwixSources(opts) } })
    }
    const bundleProblems = (problems: string[]): string[] => problems.filter((p) => /source bundle/.test(p))

    it('T20 the kiwix-tools corresponding-source bundle: binaries with a complete bundle pass, while a missing directory, a missing archive, a wrong hash, a missing SOURCES.md and an undeclared source_bundle each fail with their own message, a marker-less hand-placed executable still triggers the check, and a drive with no kiwix binaries is not applicable', async () => {
      // (a) binaries + a complete bundle (+ an unpinned .md5 sidecar, which is neither a
      // failure nor a warning: the duty is "the source is there").
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-ok-')
        provisionKiwix(root, { noBundle: true })
        provisionBundle(root, { extra: true })
        const res = await gateWithBundle(root, chat)
        expect(res.problems).toEqual([])
        expect(res.ok).toBe(true)
        expect(res.checks.kiwixSourceBundle).toBe(true)
      }
      // (b) binaries + no directory: ONE problem, not five.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-nodir-')
        provisionKiwix(root, { noBundle: true })
        const res = await gateWithBundle(root, chat)
        expect(res.ok).toBe(false)
        expect(res.checks.kiwixSourceBundle).toBe(false)
        expect(bundleProblems(res.problems)).toHaveLength(1)
        expect(bundleProblems(res.problems)[0]).toMatch(/runtime\/kiwix-tools\/source\/ is missing while kiwix_tools binaries are on this drive/)
        expect(res.checks.optionalRuntimesConsistent).toBe(true) // the binaries themselves are fine
      }
      // (c) one hash differs.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-hash-')
        provisionKiwix(root, { noBundle: true })
        provisionBundle(root, { tamper: 'libzim-9.4.0.tar.xz' })
        const res = await gateWithBundle(root, chat)
        expect(res.checks.kiwixSourceBundle).toBe(false)
        expect(bundleProblems(res.problems)).toEqual([expect.stringMatching(/libzim-9\.4\.0\.tar\.xz does not match the SHA-256 pinned/)])
        expect(res.checks.optionalRuntimesConsistent).toBe(true)
      }
      // (d) a marker-less, hand-placed kiwix-serve.exe alone: the source check fires WITHOUT a
      // marker (fail-closed), and the half-install fires too.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-hand-')
        mkdirSync(join(root, 'runtime', 'kiwix-tools', 'win'), { recursive: true })
        writeFileSync(join(root, 'runtime', 'kiwix-tools', 'win', 'kiwix-serve.exe'), 'hand-placed')
        const res = await gateWithBundle(root, chat)
        expect(res.checks.kiwixSourceBundle).toBe(false)
        expect(bundleProblems(res.problems)[0]).toMatch(/is missing while kiwix_tools binaries are on this drive/)
        expect(res.checks.optionalRuntimesConsistent).toBe(false)
      }
      // (e) no binaries, no bundle: not applicable.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-none-')
        const res = await gateWithBundle(root, chat)
        expect(res.ok).toBe(true)
        expect(res.checks.kiwixSourceBundle).toBe(true)
        expect(bundleProblems(res.problems)).toEqual([])
      }
      // (f) a bundle without binaries is harmless.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-only-')
        provisionBundle(root)
        const res = await gateWithBundle(root, chat)
        expect(res.ok).toBe(true)
        expect(res.checks.kiwixSourceBundle).toBe(true)
      }
      // (g) an archive missing, (h) SOURCES.md missing — each its own message.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-gap-')
        provisionKiwix(root, { noBundle: true })
        provisionBundle(root, { omit: 'libkiwix-14.1.1.tar.xz', noRecord: true })
        const res = await gateWithBundle(root, chat)
        expect(res.checks.kiwixSourceBundle).toBe(false)
        expect(bundleProblems(res.problems)).toEqual([
          expect.stringMatching(/libkiwix-14\.1\.1\.tar\.xz missing from runtime\/kiwix-tools\/source\//),
          expect.stringMatching(/SOURCES\.md missing or empty in runtime\/kiwix-tools\/source\//)
        ])
      }
      // (i) the drive's yaml declares no source_bundle while the binaries are there.
      {
        const { root, chat } = sellable('hilbertraum-commercial-src-undeclared-')
        provisionKiwix(root)
        const res = await gateWithBundle(root, chat, { declare: false })
        expect(res.checks.kiwixSourceBundle).toBe(false)
        expect(bundleProblems(res.problems)).toEqual([expect.stringMatching(/declares no source_bundle for kiwix_tools while its binaries are on this drive/)])
        // …and never the REQUIRED families' flags, in any leg.
        expect(res.checks.runtimeCurrent).toBe(true)
        expect(res.checks.runtimeHashed).toBe(true)
      }
    })

    // #715: the WRITER of that bundle, run for real. The legs above hand-write the directory the
    // reader checks; this one lets scripts/install-kiwix-source-bundle.mjs build it from the same
    // runtime-sources.yaml the gate reads, so the two cannot drift apart unnoticed.
    it('install-kiwix-source-bundle.mjs writes exactly the bundle the gate accepts, from the same runtime-sources.yaml', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-src-script-')
      provisionKiwix(root, { noBundle: true })
      const archives = tempDir('hilbertraum-commercial-src-archives-')
      for (const name of BUNDLE_FILES) writeFileSync(join(archives, name), `source of ${name}`)
      const manifest = join(tempDir('hilbertraum-commercial-src-yaml-'), 'runtime-sources.yaml')
      writeFileSync(manifest, JSON.stringify(kiwixSourcesYaml())) // JSON is YAML
      const script = join(__dirname, '..', '..', '..', '..', 'scripts', 'install-kiwix-source-bundle.mjs')

      const run = spawnSync(process.execPath, [script, '--target', root, '--source-dir', archives, '--manifest', manifest], {
        encoding: 'utf8'
      })
      expect(run.stderr).toBe('')
      expect(run.status).toBe(0)
      const res = await gateWithBundle(root, chat)
      expect(res.problems).toEqual([])
      expect(res.checks.kiwixSourceBundle).toBe(true)
    })

    it('the two macOS kiwix_tools builds are checked once against the single mac install dir, by the marker\'s arch', async () => {
      const { root, chat } = sellable('hilbertraum-commercial-kiwix-mac-')
      provisionKiwix(root, { macArch: 'x64' }) // the x86_64 build is the one installed
      const res = await gate(root, chat)
      expect(res.ok).toBe(true)
      // A mac dir whose marker names an arch with no build falls back to the first build and
      // is still one check, not two: no "missing" problem for the other architecture.
      const other = sellable('hilbertraum-commercial-kiwix-mac2-')
      provisionKiwix(other.root, { macArch: 'arm64' })
      const res2 = await gate(other.root, other.chat)
      expect(res2.ok).toBe(true)
      expect(res2.problems.filter((p) => /mac/.test(p))).toEqual([])
    })
  })

  // LIC-1 (full-audit 2026-07-12b): the root license/attribution artifacts are part of the
  // sellable posture — every approved Apache-2.0 review note records "ship the LICENSE/NOTICE
  // attribution with the drive", the llama.cpp/whisper.cpp binaries are MIT (the notice must
  // accompany copies), and the app itself is GPL. A drive without the three root files must
  // NOT pass, however green everything else is.
  it('fails when the root license/attribution artifacts are missing (LIC-1)', async () => {
    const root = tempDir('hilbertraum-commercial-lic-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    // Deliberately NO provisionLicenseArtifacts — the drive carries none of the three files.
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.licenseArtifactsPresent).toBe(false)
    for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'DRIVE-NOTICES.md']) {
      expect(
        res.problems.some((p) => p.includes(`drive root: ${name}`)),
        `expected a problem naming ${name}`
      ).toBe(true)
    }
  })

  it('fails when a license artifact exists but is EMPTY — and names only that one (LIC-1)', async () => {
    const root = tempDir('hilbertraum-commercial-lic-empty-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    writeFileSync(join(root, 'DRIVE-NOTICES.md'), '') // zero bytes = not an attribution artifact
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.licenseArtifactsPresent).toBe(false)
    expect(res.problems.some((p) => p.includes('drive root: DRIVE-NOTICES.md'))).toBe(true)
    // The other two artifacts are fine — they must NOT be flagged (match on the precise
    // "drive root: <name>" fragment; the remediation hint names all three files).
    expect(res.problems.some((p) => p.includes('drive root: THIRD-PARTY-NOTICES.md'))).toBe(false)
    expect(res.problems.some((p) => p.includes('drive root: LICENSE'))).toBe(false)
  })

  // Skills plan S9 / §14: a sold drive must ship at least one trusted product skill.
  it('fails when no app skills are provisioned', async () => {
    const root = tempDir('hilbertraum-commercial-noskill-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.appSkillsPresent).toBe(false)
    expect(res.problems.some((p) => /no app skills provisioned/i.test(p))).toBe(true)
  })

  // Skills plan S9 / §14: user-skills/ must ship empty (only trusted product skills are sold).
  it('fails when a user skill is present (user-skills/ must ship empty)', async () => {
    const root = tempDir('hilbertraum-commercial-userskill-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'user-skills', 'my-imported'), { recursive: true })
    writeFileSync(join(root, 'user-skills', 'my-imported', 'SKILL.md'), 'x')
    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.userSkillsEmpty).toBe(false)
    expect(res.checks.appSkillsPresent).toBe(true) // ONLY the user-skills gate failed
    expect(res.problems.some((p) => /user-skills\/my-imported/.test(p))).toBe(true)
  })

  // An empty user-skills/ directory (created by prepare-drive) is NOT a problem.
  it('an EMPTY user-skills/ directory is allowed', async () => {
    const root = tempDir('hilbertraum-commercial-emptyuser-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'user-skills'), { recursive: true }) // empty
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.ok).toBe(true)
    expect(res.checks.userSkillsEmpty).toBe(true)
  })

  // M11 (audit round 4): a sold drive requires every license_review APPROVED (spec §13).
  // --accept-license is download-time acceptance, never a substitute for the review.
  it('fails when a model license_review is not approved', async () => {
    const root = tempDir('hilbertraum-commercial-license-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const pendingReview = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const notApproved = asManifest({
      id: pendingReview.id,
      local_path: pendingReview.localPath,
      sha256: pendingReview.sha256,
      license_review: { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
    })

    const res = await assertCommercialDrive(root, [notApproved])
    expect(res.ok).toBe(false)
    expect(res.checks.licensesApproved).toBe(false)
    expect(res.checks.weightsVerified).toBe(true) // ONLY the license gate failed
    expect(res.problems.some((p) => /license_review/.test(p))).toBe(true)
  })

  it('permits model downloads but fails when the policy allows phone-home (update checks)', async () => {
    // Model downloads are a permitted, user-initiated action on a sold drive — the commercial
    // default (allow_model_downloads: true) must NOT fail the gate on that ground.
    const okRoot = tempDir('hilbertraum-commercial-net-ok-')
    const okPolicy = buildPolicyJson()
    expect(okPolicy.network.allow_model_downloads).toBe(true)
    writePolicy(okRoot, okPolicy)
    const okChat = writeVerifiedWeight(okRoot, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const okRes = await assertCommercialDrive(okRoot, [okChat])
    expect(okRes.checks.networkDenied).toBe(true) // downloads permitted, but no phone-home
    expect(okRes.problems.some((p) => /update checks|telemetry/i.test(p))).toBe(false)

    // An update-check (phone-home) channel, by contrast, must fail the sell gate.
    const root = tempDir('hilbertraum-commercial-net-')
    const policy = buildPolicyJson()
    policy.network.allow_update_checks = true
    writePolicy(root, policy)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.networkDenied).toBe(false)
    expect(res.problems.some((p) => /update checks/i.test(p))).toBe(true)
  })

  // F-8, G-14 built the simpler way (owner 2026-11-23): every Kit carries `updates.allow_online_check: true` and keeps
  // `network.allow_update_checks: false`. The gate passes the Kit's own literal, and an administrator's deliberate
  // `allow_user_install: false` ("managed", owner 2026-11-26); the shapes it refuses are the table after this one.
  it.each<[string, (kitBlock: Record<string, unknown>) => unknown]>([
    ["the Kit's literal", (block) => block],
    ["an admin's allow_user_install false", (block) => ({ ...block, allow_user_install: false })]
  ])('passes a Kit whose policy carries an updates block: %s', async (_label, updates) => {
    const root = tempDir('hilbertraum-commercial-kit-')
    const policy = buildPolicyJson({ kit: true })
    expect(policy.updates, 'the Kit literal carries the block').toStrictEqual({ allow_online_check: true })
    writePolicy(root, { ...policy, updates: updates(policy.updates!) })
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.problems).toEqual([])
    expect(res.checks.policyCommercial).toBe(true)
    expect(res.checks.networkDenied).toBe(true)
    expect(res.ok).toBe(true)
  })

  // T3.8: the Kit's reserved key is required at sale (T3.1 review R1-1: U1 (b) enforced; a drive re-prepared without
  // the Kit switch would otherwise pass), and install keys release 1 reads as junk are refused (owner, T3.8 sheet Q4:
  // release 1 would block every import on that Kit for good). The four rows marked "was a pass" passed before T3.8.
  // The key is the drive's own field: one reached only through an own `__proto__` field (which a merge would turn into
  // the prototype) does not count. The network ceiling is untouched in every row.
  const KIT_KEY_LINE =
    'policy.json does not carry the Kit\'s update key ("updates": { "allow_online_check": true }) — build the drive with ' +
    'build-commercial-drive (its first step writes the Kit policy), never with prepare-drive alone'
  const INSTALL_KEYS_LINE =
    "policy.json's updates block holds an install key release 1 cannot read (updates.allow_user_install must be true or " +
    'false, updates.max_version a version) — it would refuse every update on this Kit: fix the block, or build the drive ' +
    'again with build-commercial-drive (its first step writes the Kit policy)'
  const kitPolicyText = (updates: (kitBlock: Record<string, unknown>) => unknown): string => {
    const policy = buildPolicyJson({ kit: true })
    return JSON.stringify({ ...policy, updates: updates(policy.updates!) })
  }
  it.each<[string, () => string, string[]]>([
    ['no updates block (a drive prepared without the Kit switch)', () => JSON.stringify(buildPolicyJson()), [KIT_KEY_LINE]],
    ['an updates block without the key', () => kitPolicyText(() => ({})), [KIT_KEY_LINE]],
    ['allow_online_check false', () => kitPolicyText(() => ({ allow_online_check: false })), [KIT_KEY_LINE]],
    ['a junk allow_online_check (was a pass)', () => kitPolicyText((block) => ({ ...block, allow_online_check: 'ask' })), [KIT_KEY_LINE]],
    ['an updates block that is not an object (was a pass)', () => kitPolicyText(() => 'x'), [KIT_KEY_LINE]],
    [
      'the key only under an own __proto__ field',
      () => kitPolicyText(() => ({})).replace('"updates":{}', '"updates":{"__proto__":{"allow_online_check":true}}'),
      [KIT_KEY_LINE]
    ],
    ['a junk allow_user_install (was a pass)', () => kitPolicyText((block) => ({ ...block, allow_user_install: 'no' })), [INSTALL_KEYS_LINE]],
    ['a junk max_version (was a pass)', () => kitPolicyText((block) => ({ ...block, max_version: 'latest' })), [INSTALL_KEYS_LINE]]
  ])('refuses a Kit whose policy lacks the Kit key or holds junk install keys: %s (T3.8)', async (_label, text, lines) => {
    const root = tempDir('hilbertraum-commercial-kitkey-')
    mkdirSync(join(root, 'config'), { recursive: true })
    writeFileSync(join(root, 'config', 'policy.json'), text())
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.problems).toEqual(lines)
    expect(res.checks.kitUpdatesKey).toBe(false)
    expect(res.checks.policyCommercial).toBe(true)
    expect(res.checks.networkDenied).toBe(true)
    expect(res.ok).toBe(false)
  })

  it('fails when the policy allows a plaintext workspace', async () => {
    const root = tempDir('hilbertraum-commercial-plain-')
    writePolicy(root, buildPolicyJson({ dev: true })) // plaintext + unverified allowed
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.policyCommercial).toBe(false)
    expect(res.problems.some((p) => /plaintext/i.test(p))).toBe(true)
  })

  it('fails when a weight is a placeholder (cannot verify)', async () => {
    const root = tempDir('hilbertraum-commercial-weight-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    // Present file but the manifest carries the placeholder hash → unverified_placeholder.
    const dest = join(root, 'models', 'chat', 'ph.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'data')
    const placeholder = asManifest({ id: 'ph', local_path: 'models/chat/ph.gguf' })

    const res = await assertCommercialDrive(root, [placeholder])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.problems.some((p) => /not VERIFIED/i.test(p))).toBe(true)
  })

  it('fails when a weight has a real but MISMATCHED hash', async () => {
    const root = tempDir('hilbertraum-commercial-mismatch-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const dest = join(root, 'models', 'chat', 'mm.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'actual-content')
    // A real (64-hex) hash that does NOT match the file content → mismatch.
    const mismatch = asManifest({ id: 'mm', local_path: 'models/chat/mm.gguf', sha256: 'a'.repeat(64) })

    const res = await assertCommercialDrive(root, [mismatch])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.modelResults[0].status).toBe('mismatch')
  })

  // DIST-2: a vision drive whose GGUF is fine but whose mmproj projector is missing/corrupt must
  // NOT pass the sell gate (it would ship a vision model that cannot start).
  it('fails a vision drive whose GGUF verifies but whose mmproj projector is MISSING', async () => {
    const root = tempDir('hilbertraum-commercial-vision-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    const ggufContent = 'vlm-gguf'
    const dest = join(root, 'models', 'vision', 'vlm.gguf')
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, ggufContent)
    const ggufSha = createHash('sha256').update(ggufContent).digest('hex')
    const vision = asManifest({
      id: 'vlm',
      role: 'vision',
      family: 'qwen2.5-vl',
      local_path: 'models/vision/vlm.gguf',
      sha256: ggufSha,
      // mmproj projector declared but its file never written → the model is half-installed.
      mmproj: { local_path: 'models/vision/vlm-mmproj.gguf', sha256: createHash('sha256').update('proj').digest('hex') }
    })

    const res = await assertCommercialDrive(root, [vision])
    expect(res.ok).toBe(false)
    expect(res.checks.weightsVerified).toBe(false)
    expect(res.modelResults[0].status).toBe('missing')
    expect(res.modelResults[0].localPath).toBe('models/vision/vlm-mmproj.gguf')
  })

  // #766 (owner call 2026-11-02): a Kit ships its bundled set plus any model with a file on the drive. Every other manifest
  // is the in-app download catalog, which needs neither a file nor the redistribution review.
  describe('the bundled set and the in-app catalog (#766)', () => {
    const PENDING = { status: 'pending', reviewed_by: null, reviewed_at: null, notes: '' }
    /** A catalog manifest: not bundled, review open, placeholder hash, as most of the committed catalog is to a Kit. */
    const catalog = (o: Record<string, unknown> = {}): ModelManifest =>
      asManifest({ id: 'catalog', local_path: 'models/chat/catalog.gguf', bundled_on_preconfigured_drive: false, license_review: PENDING, ...o })

    /** A drive that passes every other check, holding one verified bundled chat weight beside `extra`'s manifests. */
    async function gate(extra: (root: string) => ModelManifest[], bundledChat = true) {
      const root = tempDir('hilbertraum-commercial-catalog-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      provisionApp(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      const shipped = bundledChat ? chat : { ...chat, bundledOnPreconfiguredDrive: false }
      return assertCommercialDrive(root, [shipped, ...extra(root)], null, null, null, kit())
    }

    it('a catalog model with no file on the drive passes, placeholder hash and open review included', async () => {
      const res = await gate(() => [catalog()])
      expect(res.problems).toEqual([])
      expect(res.ok).toBe(true)
      // The catalog is not a failed weight: the detail lists only what the Kit ships.
      expect(res.modelResults.map((r) => [r.id, r.status])).toEqual([['chat', 'verified']])
    })

    it('a catalog model whose weight is on the drive ships, so its review must be approved', async () => {
      const res = await gate((root) => [catalog({ sha256: writeDriveFile(root, 'models/chat/catalog.gguf', 'catalog') })])
      expect(res.checks.weightsVerified).toBe(true)
      expect(res.checks.licensesApproved).toBe(false)
      expect(res.problems).toEqual([
        'model "catalog" license_review.status is "pending" — a sold drive requires an approved review (spec §13); ' +
          '--accept-license does not override this. It is not bundled and ships only because a file of it is on the ' +
          'drive: delete that, and the Kit lists the model for in-app download instead'
      ])
      expect(res.modelResults.map((r) => r.id)).toEqual(['chat', 'catalog'])
    })

    it('a catalog model with only its projector on the drive is a half-installed preload', async () => {
      const res = await gate((root) => [
        catalog({ mmproj: { local_path: 'models/chat/catalog-mmproj.gguf', sha256: writeDriveFile(root, 'models/chat/catalog-mmproj.gguf', 'proj') } })
      ])
      expect(res.checks.weightsVerified).toBe(false)
      expect(res.checks.licensesApproved).toBe(false)
      expect(res.problems.some((p) => p.startsWith('weight "catalog" is not VERIFIED (status: missing'))).toBe(true)
    })

    it('a bundled model that is not on the drive fails', async () => {
      const res = await gate(() => [asManifest({ id: 'bundled', local_path: 'models/chat/bundled.gguf', sha256: 'a'.repeat(64) })])
      expect(res.checks.weightsVerified).toBe(false)
      expect(res.checks.licensesApproved).toBe(true)
      expect(res.problems).toEqual(['weight "bundled" is not VERIFIED (status: missing — models/chat/bundled.gguf)'])
    })

    it('no bundled model fails, even when every weight on the drive verifies and is approved', async () => {
      const res = await gate(() => [], false)
      expect(res.checks.weightsVerified).toBe(false)
      expect(res.checks.licensesApproved).toBe(true)
      expect(res.problems).toEqual([
        'no bundled model (bundled_on_preconfigured_drive: true): a sold drive ships its bundled set pre-loaded'
      ])
    })
  })

  it('fails when user data is present (a sold drive must ship empty)', async () => {
    const root = tempDir('hilbertraum-commercial-userdata-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    // Simulate an already-initialised workspace.
    mkdirSync(join(root, 'workspace'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'hilbertraum.sqlite.enc'), 'encrypted-db')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.ok).toBe(false)
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /user data/i.test(p))).toBe(true)
  })

  /** What the gate adds to a line for an entry in `updates/` (T3.8): the drive was started, and the way out. */
  const STARTED = ' — this drive was started: delete the updates/ folder (a test start belongs on a copy, never on the Kit)'

  /** The gate's user-data lines, without the shared prefix. */
  const userDataLines = (problems: string[]): string[] =>
    problems
      .filter((p) => p.startsWith('user data present on a drive meant to ship empty: '))
      .map((p) => p.slice('user data present on a drive meant to ship empty: '.length))

  // Each user-data artifact independently flips noUserData (matrix), incl. the WAL/SHM
  // sidecars a crash can leave behind (the P1 fix), and every other file a used workspace,
  // its logs or a lock can leave (#893: each of these passed the gate when planted alone on a
  // wiped drive, several of them plaintext). A file inside a sub-folder is named by its folder.
  it.each([
    ['plaintext DB', 'workspace/hilbertraum.sqlite', 'workspace/hilbertraum.sqlite'],
    ['vault descriptor', 'config/workspace.json', 'config/workspace.json'],
    ['WAL sidecar', 'workspace/hilbertraum.sqlite-wal', 'workspace/hilbertraum.sqlite-wal'],
    ['SHM sidecar', 'workspace/hilbertraum.sqlite-shm', 'workspace/hilbertraum.sqlite-shm'],
    ['vault descriptor temp', 'config/workspace.json.tmp', 'config/workspace.json.tmp'],
    // On a case-insensitive drive the app reads this as its descriptor.
    ['vault descriptor in another case', 'config/Workspace.json', 'config/Workspace.json'],
    ['lost working copy marker', 'config/working-copy-lost.json', 'config/working-copy-lost.json'],
    ['lost working copy marker temp', 'config/working-copy-lost.json.tmp', 'config/working-copy-lost.json.tmp'],
    ['salvaged plaintext DB', 'workspace/hilbertraum.sqlite.recovery', 'workspace/hilbertraum.sqlite.recovery'],
    ['decrypt temp (plaintext DB)', 'workspace/hilbertraum.sqlite.tmp', 'workspace/hilbertraum.sqlite.tmp'],
    ['encrypt temp', 'workspace/hilbertraum.sqlite.enc.tmp', 'workspace/hilbertraum.sqlite.enc.tmp'],
    ['staged password-change copy', 'workspace/hilbertraum.sqlite.enc.new', 'workspace/hilbertraum.sqlite.enc.new'],
    ['staged password-change temp', 'workspace/hilbertraum.sqlite.enc.new.tmp', 'workspace/hilbertraum.sqlite.enc.new.tmp'],
    ['password-change journal', 'workspace/rekey-journal.json', 'workspace/rekey-journal.json'],
    ['password-change journal temp', 'workspace/rekey-journal.json.tmp', 'workspace/rekey-journal.json.tmp'],
    ['set-aside password-change journal', 'workspace/rekey-journal.json.corrupt', 'workspace/rekey-journal.json.corrupt'],
    ['benchmark leftover', 'workspace/.hilbertraum-benchmark-1-2.tmp', 'workspace/.hilbertraum-benchmark-1-2.tmp'],
    ['write probe leftover', 'workspace/.write-test-1234', 'workspace/.write-test-1234'],
    ['stored image', 'workspace/images/a.png.enc', 'workspace/images/*'],
    ['knowledge-pack library file', 'workspace/zim-transient/library.1.xml', 'workspace/zim-transient/*'],
    ['encrypted log', 'logs/app.log.enc', 'logs/app.log.enc'],
    ['rotated encrypted log', 'logs/app.1.log.enc', 'logs/app.1.log.enc'],
    ['encrypted log temp', 'logs/app.log.enc.tmp', 'logs/app.log.enc.tmp'],
    ['plaintext log', 'logs/app.log', 'logs/app.log'],
    ['timing log', 'logs/perf.log', 'logs/perf.log'],
    // T3.8 (W-33): every start on a prepared drive appends to updates/update.log (F-11), so a Kit that was started
    // before shipping fails, with the way out.
    ['started drive update log', 'updates/update.log', `updates/update.log${STARTED}`],
    ['update in progress', 'updates/applying/journal.json', `updates/applying/*${STARTED}`]
  ])('flags a %s as user data', async (_label, rel, line) => {
    const root = tempDir('hilbertraum-commercial-ud-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    const dest = join(root, ...rel.split('/'))
    mkdirSync(join(dest, '..'), { recursive: true })
    writeFileSync(dest, 'x')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(userDataLines(res.problems)).toEqual([line])
  })

  // A link is named, never followed (#893): its target may be anything, and an empty folder
  // behind it must not let it pass. A junction on Windows needs no privilege.
  it('flags a link in workspace/ by its own name, even when it points at an empty folder', async () => {
    const root = tempDir('hilbertraum-commercial-link-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace'), { recursive: true })
    symlinkSync(tempDir('hilbertraum-commercial-link-target-'), join(root, 'workspace', 'linked'), 'junction')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(userDataLines(res.problems)).toEqual(['workspace/linked'])
  })

  /** The lines for what the gate could not look into, without the shared prefix. */
  const unreadableLines = (problems: string[]): string[] =>
    problems
      .filter((p) => p.startsWith('user data unreadable on a drive meant to ship empty: '))
      .map((p) => p.slice('user data unreadable on a drive meant to ship empty: '.length))

  // #893: a file where one of these folders belongs used to pass, read as an empty folder. The gate cannot look into it.
  it.each([['workspace'], ['logs'], ['config'], ['updates']])('refuses a file named %s where the folder belongs', async (dir) => {
    const root = tempDir('hilbertraum-commercial-notdir-')
    if (dir !== 'config') writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    writeFileSync(join(root, dir), 'x')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(unreadableLines(res.problems)).toEqual([`${dir} (not a folder)`])
  })

  // #893: a folder the gate could not list used to pass as empty. Each is named instead: logs/ and a sub-folder of
  // workspace/ that hold a file, and a config/ whose policy still opens by its path while the folder cannot be listed.
  it.skipIf(!canMakeUnreadable)('refuses a folder it cannot list, naming each one', async () => {
    const root = tempDir('hilbertraum-commercial-unreadable-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    writeDriveFile(root, 'logs/app.log', 'x')
    writeDriveFile(root, 'workspace/documents/a.enc', 'x')
    const undo = [
      makeUnreadable(join(root, 'logs')),
      makeUnreadable(join(root, 'workspace', 'documents')),
      makeUnreadable(join(root, 'config'), { traverse: true })
    ]
    try {
      const res = await assertCommercialDrive(root, [chat])
      expect(res.checks.policyCommercial).toBe(true)
      expect(res.checks.noUserData).toBe(false)
      expect(unreadableLines(res.problems)).toEqual(['config/', 'logs/', 'workspace/documents/'])
      expect(userDataLines(res.problems)).toEqual([])
    } finally {
      for (const u of undo) u()
    }
  })

  // T3.8: updates/ fails closed like the other two folders.
  it.skipIf(!canMakeUnreadable)('refuses an updates/ folder it cannot list (T3.8)', async () => {
    const root = tempDir('hilbertraum-commercial-updates-unreadable-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    writeDriveFile(root, 'updates/update.log', 'x')
    const undo = makeUnreadable(join(root, 'updates'))
    try {
      const res = await assertCommercialDrive(root, [chat])
      expect(res.checks.noUserData).toBe(false)
      expect(unreadableLines(res.problems)).toEqual(['updates/'])
      expect(userDataLines(res.problems)).toEqual([])
    } finally {
      undo()
    }
  })

  // T3.8 sheet Q2 (accepted, recorded): an EMPTY updates/ passes under the same rule as an empty logs/, although a Kit
  // normally has none (a start whose folder was made and whose write then failed leaves one).
  it('an EMPTY updates/ folder is NOT user data (T3.8)', async () => {
    const root = tempDir('hilbertraum-commercial-emptyupdates-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'updates'))
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.problems).toEqual([])
    expect(res.checks.noUserData).toBe(true)
  })

  it('names every leftover of a used drive, in a stable order', async () => {
    const root = tempDir('hilbertraum-commercial-many-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    for (const rel of ['workspace/rekey-journal.json', 'logs/app.log.enc', 'workspace/documents/a.enc', 'config/working-copy-lost.json']) {
      mkdirSync(join(root, ...rel.split('/'), '..'), { recursive: true })
      writeFileSync(join(root, ...rel.split('/')), 'x')
    }

    const res = await assertCommercialDrive(root, [chat])
    expect(userDataLines(res.problems)).toEqual([
      'config/working-copy-lost.json',
      'logs/app.log.enc',
      'workspace/documents/*',
      'workspace/rekey-journal.json'
    ])
  })

  it('flags a non-empty workspace/documents/ directory as user data', async () => {
    const root = tempDir('hilbertraum-commercial-docs-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true })
    writeFileSync(join(root, 'workspace', 'documents', 'contract.pdf'), 'imported')

    const res = await assertCommercialDrive(root, [chat])
    expect(res.checks.noUserData).toBe(false)
    expect(res.problems.some((p) => /documents/i.test(p))).toBe(true)
  })

  it('an EMPTY workspace/documents/ directory is NOT user data', async () => {
    const root = tempDir('hilbertraum-commercial-emptydocs-')
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    mkdirSync(join(root, 'workspace', 'documents'), { recursive: true }) // empty
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.ok).toBe(true)
    expect(res.checks.noUserData).toBe(true)
  })

  // The Kit build lays out every drive folder and leaves `workspace/` and `logs/` empty; the
  // app creates documents/, images/ and zim-transient/ on first use, and an empty one may stay
  // behind. None of that is user data (#893: the stricter rule must keep a fresh Kit SELLABLE).
  it('a fresh layout with empty workspace/ sub-folders and an empty logs/ is NOT user data', async () => {
    const root = tempDir('hilbertraum-commercial-layout-')
    for (const dir of DRIVE_LAYOUT_DIRS) mkdirSync(join(root, ...dir.split('/')), { recursive: true })
    for (const dir of ['documents', 'images', 'zim-transient']) mkdirSync(join(root, 'workspace', dir))
    writePolicy(root, buildPolicyJson({ kit: true }))
    provisionAppSkill(root)
    provisionLicenseArtifacts(root)
    const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
    provisionApp(root)
    const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
    expect(res.problems).toEqual([])
    expect(res.checks.noUserData).toBe(true)
  })

  // Phase 14: when the runtime-sources pin is passed, every pinned build's
  // .hilbertraum-runtime.json install marker must match (version + backend).
  describe('runtime install markers (Phase 14)', () => {
    const sources = (): RuntimeSources => {
      const res = validateRuntimeSources({
        llama_cpp: {
          version: 'b9585',
          builds: [
            {
              os: 'win',
              arch: 'x64',
              backend: 'vulkan',
              url: 'https://example.test/win-vulkan.zip',
              sha256: 'REPLACE_WITH_REAL_HASH',
              extract_to: 'runtime/llama.cpp/win'
            },
            {
              os: 'win',
              arch: 'x64',
              backend: 'cpu',
              url: 'https://example.test/win-cpu.zip',
              sha256: 'REPLACE_WITH_REAL_HASH',
              extract_to: 'runtime/llama.cpp/win/cpu'
            }
          ]
        }
      })
      if (!res.sources) throw new Error('fixture invalid: ' + res.errors.join(', '))
      return res.sources
    }

    /**
     * A marker alone is not an install (audit fix): write the binary too. The marker also
     * records the binary's SHA-256 so the re-hash-before-spawn gate (vuln-scan B) passes —
     * unless the caller overrides `binaries` (the stale tests fail earlier, on version).
     */
    function writeInstall(dir: string, marker: Parameters<typeof writeRuntimeMarker>[1]): void {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'llama-server.exe'), 'fake-binary')
      writeRuntimeMarker(dir, {
        binaries: { 'llama-server.exe': createHash('sha256').update('fake-binary').digest('hex') },
        ...marker
      })
    }

    function writeInstalls(root: string): void {
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      writeInstall(win, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
      writeInstall(join(win, 'cpu'), { version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64' })
    }

    it('passes when every pinned build has a binary + matching marker', async () => {
      const root = tempDir('hilbertraum-commercial-rt-ok-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(true)
    })

    // #729: an install made before the installers left llama-connect out, or a hand-copied one, still
    // carries the --connect tunnel program; a Kit must not convey it, wherever it sits under an engine dir.
    it.each([
      { name: 'beside the server', at: ['win', 'llama-connect.exe'], build: 'win/x64 vulkan', reported: 'llama-connect.exe' },
      { name: 'nested in a folder, any case', at: ['win', 'tools', 'Llama-Connect.EXE'], build: 'win/x64 vulkan', reported: 'tools/Llama-Connect.EXE' },
      { name: 'in the cpu/ net (reported once, by that build)', at: ['win', 'cpu', 'llama-connect.exe'], build: 'win/x64 cpu', reported: 'llama-connect.exe' }
    ])('fails a Kit whose engine still holds llama-connect $name (#729)', async ({ at, build, reported }) => {
      const root = tempDir('hilbertraum-commercial-rt-connect-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const stray = join(root, 'runtime', 'llama.cpp', ...at)
      mkdirSync(join(stray, '..'), { recursive: true })
      writeFileSync(stray, 'tunnel')
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      const hits = res.problems.filter((p) => p.includes('must not ship'))
      expect(hits).toEqual([expect.stringContaining(`build ${build}: ${reported} under runtime/llama.cpp/`)])
      rmSync(stray)
      expect((await assertCommercialDrive(root, [chat], sources(), null, null, kit())).ok).toBe(true)
    })

    // #986: an engine install interrupted on the drive leaves `<os>.new` or `<os>.old` beside a pinned
    // build until the app's next start there; a second engine copy no other check looks at.
    it.each([
      { leftover: 'win.new', build: 'win/x64 vulkan' },
      { leftover: 'win.old', build: 'win/x64 vulkan' },
      { leftover: 'win/cpu.new', build: 'win/x64 cpu' },
      { leftover: 'win/cpu.old', build: 'win/x64 cpu' }
    ])('fails a Kit with a leftover $leftover from an interrupted engine install (#986)', async ({ leftover, build }) => {
      const root = tempDir('hilbertraum-commercial-rt-swap-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const dir = join(root, 'runtime', 'llama.cpp', ...leftover.split('/'))
      writeInstall(dir, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.filter((p) => p.includes('interrupted engine install'))).toEqual([
        expect.stringContaining(`build ${build}: runtime/llama.cpp/${leftover} is left from an interrupted engine install`)
      ])
      rmSync(dir, { recursive: true })
      expect((await assertCommercialDrive(root, [chat], sources(), null, null, kit())).ok).toBe(true)
    })

    it('fails when a pinned build has NO install marker', async () => {
      const root = tempDir('hilbertraum-commercial-rt-missing-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      // Both binaries present, but only the win default has a marker.
      writeInstalls(root)
      rmSync(join(root, 'runtime', 'llama.cpp', 'win', 'cpu', '.hilbertraum-runtime.json'))
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /\.hilbertraum-runtime\.json/.test(p))).toBe(true)
    })

    // #1028: a marker that is there but cut short is no missing marker: the builder is told which it is.
    it('fails when a pinned build has a marker cut short, and says so (#1028)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-cut-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeFileSync(join(root, 'runtime', 'llama.cpp', 'win', 'cpu', '.hilbertraum-runtime.json'), '{"version":"b9585","backend":"cpu"')
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      // Review round 2 (L-7): and what to do when the script finds nothing to fetch.
      expect(res.problems, res.problems.join('\n')).toContain(
        'runtime build win/x64 cpu: the .hilbertraum-runtime.json install marker under runtime/llama.cpp/win/cpu is cut short or damaged — ' +
          're-run fetch-runtime for this build; if it reports the engine already installed, delete the engine folder first'
      )
    })

    // #1028: a marker that is there but cannot be read just now (a denied read) is neither missing nor damaged.
    it('fails when a pinned build has a marker that cannot be read, and says so (#1028)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-deny-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      const marker = join(root, 'runtime', 'llama.cpp', 'win', 'cpu', '.hilbertraum-runtime.json')
      denyReading(marker)
      try {
        const res = await assertCommercialDrive(root, [chat], sources())
        expect(res.ok).toBe(false)
        expect(
          res.problems.some((p) => /win\/x64 cpu: the \.hilbertraum-runtime\.json install marker under runtime\/llama\.cpp\/win\/cpu could not be read \(E[A-Z]+\)/.test(p)),
          res.problems.join('\n')
        ).toBe(true)
      } finally {
        allowReading(marker)
      }
    })

    // #1028: before, a further file whose entry was no hash was dropped from the marker as read, so the gate never looked at it.
    it('fails when the marker records a further file under a value that is not a SHA-256 (#1028)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-entry-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      writeFileSync(join(win, 'ggml.dll'), 'a library')
      writeFileSync(
        join(win, '.hilbertraum-runtime.json'),
        JSON.stringify({
          version: 'b9585',
          backend: 'vulkan',
          os: 'win',
          arch: 'x64',
          binaries: { 'llama-server.exe': createHash('sha256').update('fake-binary').digest('hex'), 'ggml.dll': { sha256: 'any' } }
        })
      )
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.problems.some((p) => /win\/x64 vulkan: the \.hilbertraum-runtime\.json install marker under runtime\/llama\.cpp\/win is cut short or damaged/.test(p)), res.problems.join('\n')).toBe(true)
    })

    it('fails when a marker exists but the binary is missing (half-deleted install)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-nobin-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      rmSync(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'))
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /binary missing/.test(p))).toBe(true)
    })

    it('fails when a marker is STALE (CPU-era build under the vulkan pin)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-stale-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      // Overwrite the win default marker with a cpu-era install.
      writeRuntimeMarker(join(root, 'runtime', 'llama.cpp', 'win'), {
        version: 'b9585',
        backend: 'cpu',
        os: 'win',
        arch: 'x64'
      })
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /does not match the pinned/.test(p))).toBe(true)
    })

    it('fails when the marker records NO binary hash (a drive built before vuln-scan B)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-nohash-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      // Rewrite the win default marker WITHOUT a `binaries` hash (old fetch-runtime output).
      writeRuntimeMarker(join(root, 'runtime', 'llama.cpp', 'win'), {
        version: 'b9585',
        backend: 'vulkan',
        os: 'win',
        arch: 'x64'
      })
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      // Presence + version/backend are fine; the missing hash is its own verdict (#234).
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.problems.some((p) => /records no SHA-256/.test(p))).toBe(true)
    })

    it('fails when the binary was modified after install (recorded hash no longer matches)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-tamper-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      // The marker still records sha256('fake-binary'); overwrite the binary with new bytes.
      writeFileSync(join(root, 'runtime', 'llama.cpp', 'win', 'llama-server.exe'), 'TAMPERED')
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.problems.some((p) => /does not match the SHA-256 recorded/.test(p))).toBe(true)
    })

    it('fails when the marker HASH was tampered (binary untouched, recorded hash rewritten)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-marker-tamper-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeRuntimeMarker(join(root, 'runtime', 'llama.cpp', 'win'), {
        version: 'b9585',
        backend: 'vulkan',
        os: 'win',
        arch: 'x64',
        binaries: { 'llama-server.exe': 'e'.repeat(64) }
      })
      const res = await assertCommercialDrive(root, [chat], sources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.problems.some((p) => /does not match the SHA-256 recorded/.test(p))).toBe(true)
    })

    // #998: an install since #998 records every file it unpacked, so a Kit whose engine lost or changed a DLL
    // (an antivirus took it, a hand edit) is caught before it ships. It used to pass: the gate looked at the
    // program alone. What is recorded is verified; a marker that records only the program passes as before.
    it.each([
      { name: 'missing', damage: (dll: string) => rmSync(dll), reported: /ggml\.dll is recorded in the install marker but missing/ },
      { name: 'modified', damage: (dll: string) => writeFileSync(dll, 'TAMPERED'), reported: /ggml\.dll does not match the SHA-256 recorded/ }
    ])('fails when a further file the marker records is $name (#998)', async ({ damage, reported }) => {
      const root = tempDir('hilbertraum-commercial-rt-recorded-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      writeFileSync(join(win, 'ggml.dll'), 'ggml')
      const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
      writeRuntimeMarker(win, {
        version: 'b9585',
        backend: 'vulkan',
        os: 'win',
        arch: 'x64',
        binaries: { 'llama-server.exe': sha('fake-binary'), 'ggml.dll': sha('ggml') }
      })
      expect((await assertCommercialDrive(root, [chat], sources(), null, null, kit())).ok).toBe(true)
      damage(join(win, 'ggml.dll'))
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.problems.filter((p) => reported.test(p))).toEqual([expect.stringContaining('build win/x64 vulkan: ')])
    })

    it('fails when the marker records a file outside its install folder (#998)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-outside-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      writeRuntimeMarker(win, {
        version: 'b9585',
        backend: 'vulkan',
        os: 'win',
        arch: 'x64',
        binaries: { 'llama-server.exe': createHash('sha256').update('fake-binary').digest('hex'), '../../../README.md': 'a'.repeat(64) }
      })
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.problems.some((p) => /records \.\.\/\.\.\/\.\.\/README\.md, which is not inside runtime\/llama\.cpp\/win/.test(p))).toBe(true)
    })

    // ---- T3.8 (W-33; T3.12 review 1 M-2, Δ-61): every file in an engine folder is in its copy's map ----
    // An install since #998 records every file it put in the folder, so a file the map does not record (a hand-copied
    // library, a leftover archive of a killed download, Thumbs.db) is nothing the app can vouch for before a spawn.
    // "In the folder" is exactly the walk an install records (runtime-download.ts installedFileKeys and the two
    // fetch-runtime twins): never the marker, the cpu/ net and its swap folders (copies with their own markers), or
    // macOS metadata. fetch-runtime --commercial skips a copy whose map hashes every required file (T3.8 sheet F1), so
    // the line names deleting, never a re-run.

    /** A drive the gate passes, with the two pinned builds installed (`writeInstalls`). */
    function sellableEngines(prefix: string): { root: string; chat: ModelManifest } {
      const root = tempDir(prefix)
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      provisionApp(root)
      return { root, chat }
    }
    const unrecorded = (problems: string[]): string[] => problems.filter((p) => p.includes('not recorded in the install marker'))
    const WAY_OUT = (dir: string): string =>
      ` — delete what does not belong to the engine; for an engine installed by an older fetch-runtime, delete ${dir} ` +
      'and run build-commercial-drive again (fetch-runtime skips an engine it finds installed)'

    it.each([
      { name: 'beside the program', at: ['win', 'ggml-extra.dll'], build: 'win/x64 vulkan', dir: 'runtime/llama.cpp/win', listed: 'ggml-extra.dll' },
      { name: 'in a subfolder', at: ['win', 'backends', 'ggml-cuda.dll'], build: 'win/x64 vulkan', dir: 'runtime/llama.cpp/win', listed: 'backends/ggml-cuda.dll' },
      { name: 'a Windows thumbnail cache', at: ['win', 'Thumbs.db'], build: 'win/x64 vulkan', dir: 'runtime/llama.cpp/win', listed: 'Thumbs.db' },
      { name: 'in the cpu/ net (reported once, by that build)', at: ['win', 'cpu', 'ggml-extra.dll'], build: 'win/x64 cpu', dir: 'runtime/llama.cpp/win/cpu', listed: 'ggml-extra.dll' }
    ])('fails runtimeHashed for a file the marker does not record: $name (T3.8)', async ({ at, build, dir, listed }) => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-unrecorded-')
      const extra = join(root, 'runtime', 'llama.cpp', ...at)
      mkdirSync(join(extra, '..'), { recursive: true })
      writeFileSync(extra, 'not an engine file')
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.problems).toEqual([`runtime build ${build}: 1 file under ${dir} is not recorded in the install marker: ${listed}${WAY_OUT(dir)}`])
      expect(res.checks.runtimeHashed).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(true)
      rmSync(extra)
      expect((await assertCommercialDrive(root, [chat], sources(), null, null, kit())).problems).toEqual([])
    })

    it('names five unrecorded files in code-unit order and counts the rest (T3.8)', async () => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-unrecorded-many-')
      for (const name of ['g.dll', 'f.dll', 'E.dll', 'd.dll', 'c.dll', 'b.dll', 'a.dll']) writeFileSync(join(root, 'runtime', 'llama.cpp', 'win', name), name)
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(unrecorded(res.problems)).toEqual([
        'runtime build win/x64 vulkan: 7 files under runtime/llama.cpp/win are not recorded in the install marker: ' +
          `E.dll, a.dll, b.dll, c.dll, d.dll, and 2 more${WAY_OUT('runtime/llama.cpp/win')}`
      ])
    })

    it('passes what an install never records: the marker, the cpu/ net, macOS metadata; and a recorded file in a subfolder (T3.8)', async () => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-recorded-tree-')
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
      writeDriveFile(root, 'runtime/llama.cpp/win/backends/ggml-vulkan.dll', 'vulkan')
      writeRuntimeMarker(win, {
        version: 'b9585',
        backend: 'vulkan',
        os: 'win',
        arch: 'x64',
        binaries: { 'llama-server.exe': sha('fake-binary'), 'backends/ggml-vulkan.dll': sha('vulkan') }
      })
      for (const rel of ['._llama-server.exe', '.DS_Store', 'backends/._ggml-vulkan.dll', 'backends/.DS_Store', '__MACOSX/._llama-server.exe', 'cpu/.DS_Store']) {
        writeDriveFile(root, `runtime/llama.cpp/win/${rel}`, 'macOS metadata')
      }
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.problems).toEqual([])
      expect(res.checks.runtimeHashed).toBe(true)
    })

    // An install records a link by its own name only when it resolves to a file (runtime-download.ts recordedKind and both
    // fetch-runtime twins), so the walk counts such a link and never counts or enters a link to a folder. The file-link
    // half needs the right to make one (Windows: symlink privilege; every CI leg has it).
    it('counts a link in an engine folder only when it resolves to a file (T3.8)', async () => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-links-')
      const win = join(root, 'runtime', 'llama.cpp', 'win')
      const target = tempDir('hilbertraum-commercial-rt-link-target-')
      writeFileSync(join(target, 'inside.dll'), 'x')
      symlinkSync(target, join(win, 'linked-folder'), 'junction')
      expect((await assertCommercialDrive(root, [chat], sources(), null, null, kit())).problems).toEqual([])
      try {
        symlinkSync(join(target, 'inside.dll'), join(win, 'linked.dll'), 'file')
      } catch (err) {
        if (['EPERM', 'EACCES'].includes((err as NodeJS.ErrnoException).code ?? '')) return
        throw err
      }
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(unrecorded(res.problems)).toEqual([
        `runtime build win/x64 vulkan: 1 file under runtime/llama.cpp/win is not recorded in the install marker: linked.dll${WAY_OUT('runtime/llama.cpp/win')}`
      ])
    })

    // One cause, one line: a map without the program's hash, the --connect tunnel (#729) and a net swap left inside the
    // folder (#986) are each their own line already, never also a list of files.
    it.each<[string, (root: string, win: string) => void, RegExp]>([
      [
        'a marker without the program hash',
        (_root, win) => {
          writeRuntimeMarker(win, { version: 'b9585', backend: 'vulkan', os: 'win', arch: 'x64' })
          writeFileSync(join(win, 'ggml.dll'), 'a library')
        },
        /records no SHA-256 for llama-server\.exe/
      ],
      ['llama-connect beside the program', (_root, win) => writeFileSync(join(win, 'llama-connect.exe'), 'tunnel'), /llama-connect\.exe under runtime\/llama\.cpp\/win must not ship/],
      ['a net swap left inside the folder', (_root, win) => writeInstall(join(win, 'cpu.new'), { version: 'b9585', backend: 'cpu', os: 'win', arch: 'x64' }), /win\/cpu\.new is left from an interrupted engine install/]
    ])('reports %s once, with no list of unrecorded files (T3.8)', async (_name, damage, line) => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-onecause-')
      damage(root, join(root, 'runtime', 'llama.cpp', 'win'))
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.problems.filter((p) => line.test(p))).toHaveLength(1)
      expect(unrecorded(res.problems)).toEqual([])
    })

    it.skipIf(!canMakeUnreadable)('fails closed on a folder under the engine it cannot list (T3.8)', async () => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-rt-unlistable-')
      writeDriveFile(root, 'runtime/llama.cpp/win/backends/ggml-cuda.dll', 'x')
      const undo = makeUnreadable(join(root, 'runtime', 'llama.cpp', 'win', 'backends'))
      try {
        const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
        expect(res.problems).toEqual([
          expect.stringMatching(
            /^runtime build win\/x64 vulkan: runtime\/llama\.cpp\/win\/backends\/ could not be listed \(E[A-Z]+\) — check the drive, then run the gate again$/
          )
        ])
        expect(res.checks.runtimeHashed).toBe(false)
      } finally {
        undo()
      }
    })

    // T3.8 sheet §2: the new refusals come in a fixed order: the Kit key after the policy posture, user data, the engine
    // files, the root apps, then the record (its lines refer to the apps) and the support end, last.
    it('lists the new refusals in the gate order: Kit key, user data, engine files, apps, record, support end (T3.8)', async () => {
      const { root, chat } = sellableEngines('hilbertraum-commercial-order-')
      writePolicy(root, buildPolicyJson())
      writeDriveFile(root, 'updates/update.log', 'x')
      writeFileSync(join(root, 'runtime', 'llama.cpp', 'win', 'Thumbs.db'), 'x')
      rmSync(join(root, ARTIFACT['mac-arm64']))
      provisionExtractedApp(root, APP_VERSION)
      rmSync(join(root, RECORD))
      rmSync(join(root, STAMP))
      const res = await assertCommercialDrive(root, [chat], sources(), null, null, kit())
      expect(res.problems).toEqual([
        KIT_KEY_LINE,
        `user data present on a drive meant to ship empty: updates/update.log${STARTED}`,
        `runtime build win/x64 vulkan: 1 file under runtime/llama.cpp/win is not recorded in the install marker: Thumbs.db${WAY_OUT('runtime/llama.cpp/win')}`,
        `app artifact "HilbertRaum.app" is an extracted app folder — a Kit carries ${ARTIFACT['mac-arm64']} (the start file unpacks it): ` +
          `replace the folder by the zip, then write the record again: ${WRITE_RECORD}`,
        RECORD_MISSING_LINE,
        STAMP_MISSING_LINE
      ])
    })

    it('skips the marker check when no runtimeSources are passed (runtimeCurrent stays true)', async () => {
      const root = tempDir('hilbertraum-commercial-rt-skip-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      provisionApp(root)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(true)
    })

    // ---- Phase 36: the whisper family rides the same gate (binary = whisper-cli) ----

    const whisperSources = (): RuntimeSources => {
      const res = validateRuntimeSources({
        llama_cpp: {
          version: 'b9585',
          builds: [
            {
              os: 'win',
              arch: 'x64',
              backend: 'vulkan',
              url: 'https://example.test/win-vulkan.zip',
              sha256: 'REPLACE_WITH_REAL_HASH',
              extract_to: 'runtime/llama.cpp/win'
            }
          ]
        },
        whisper_cpp: {
          version: 'v1.8.6',
          builds: [
            {
              os: 'win',
              arch: 'x64',
              backend: 'cpu',
              url: 'https://example.test/whisper-bin-x64.zip',
              sha256: 'REPLACE_WITH_REAL_HASH',
              extract_to: 'runtime/whisper.cpp/win'
            }
          ]
        }
      })
      if (!res.whisper) throw new Error('fixture invalid: ' + res.errors.join(', '))
      return res.whisper
    }

    function writeWhisperInstall(root: string): void {
      const dir = join(root, 'runtime', 'whisper.cpp', 'win')
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, 'whisper-cli.exe'), 'fake-whisper')
      writeRuntimeMarker(dir, {
        version: 'v1.8.6',
        backend: 'cpu',
        os: 'win',
        arch: 'x64',
        binaries: { 'whisper-cli.exe': createHash('sha256').update('fake-whisper').digest('hex') }
      })
    }

    it('passes when the whisper pin has a whisper-cli binary + matching marker', async () => {
      const root = tempDir('hilbertraum-commercial-wh-ok-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      provisionApp(root)
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources(), null, kit())
      expect(res.ok).toBe(true)
      expect(res.checks.runtimeCurrent).toBe(true)
      expect(res.checks.runtimeHashed).toBe(true)
    })

    it('fails when the whisper-cli binary is missing under the whisper pin', async () => {
      const root = tempDir('hilbertraum-commercial-wh-nobin-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      rmSync(join(root, 'runtime', 'whisper.cpp', 'win', 'whisper-cli.exe'))
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources())
      expect(res.ok).toBe(false)
      expect(res.checks.runtimeCurrent).toBe(false)
      expect(res.problems.some((p) => /whisper-cli binary missing/.test(p))).toBe(true)
    })

    it('fails when the whisper marker version does not match the whisper pin', async () => {
      const root = tempDir('hilbertraum-commercial-wh-stale-')
      writePolicy(root, buildPolicyJson({ kit: true }))
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      writeInstalls(root)
      writeWhisperInstall(root)
      writeRuntimeMarker(join(root, 'runtime', 'whisper.cpp', 'win'), {
        version: 'v1.7.0',
        backend: 'cpu',
        os: 'win',
        arch: 'x64'
      })
      const res = await assertCommercialDrive(root, [chat], sources(), whisperSources())
      expect(res.ok).toBe(false)
      expect(res.problems.some((p) => /whisper build .*does not match the pinned v1\.8\.6/.test(p))).toBe(
        true
      )
    })
  })

  // #233: the gate requires the app artifact + launcher for every platform the kit is
  // declared for, exactly one artifact per platform, with the version the builder names.
  describe('app artifacts + launchers per declared platform (#233)', () => {
    /** Everything but the app: posture, skill, notices, one weight. */
    function otherwiseValidDrive(prefix: string): { root: string; chat: ModelManifest } {
      const root = tempDir(prefix)
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      return { root, chat }
    }

    it('fails with no app artifact at all (launchers present)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-noapp-')
      for (const p of ALL_PLATFORMS) writeFileSync(join(root, LAUNCHER[p]), 'launcher')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.problems.length).toBeGreaterThan(0)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.checks.launchersPresent).toBe(true)
      expect(res.checks.platformMatrixDeclared).toBe(true)
      for (const p of ALL_PLATFORMS) {
        expect(res.problems.some((m) => m.includes(p) && /no app artifact/i.test(m)), p).toBe(true)
      }
    })

    it('fails on a zero-byte app artifact', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-zeroapp-')
      provisionApp(root)
      writeFileSync(join(root, ARTIFACT['win-x64']), Buffer.alloc(0))
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.problems.some((m) => m.includes(ARTIFACT['win-x64']) && /zero bytes/i.test(m))).toBe(true)
    })

    it('fails on a wrong-arch artifact name (not a release artifact of any declared platform)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-wrongarch-')
      provisionApp(root, ['win-x64', 'linux-x64'])
      writeFileSync(join(root, LAUNCHER['mac-arm64']), 'launcher')
      writeFileSync(join(root, `HilbertRaum-${APP_VERSION}-mac-x64.app.zip`), 'app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.problems.some((m) => m.includes('mac-x64'))).toBe(true)
      expect(res.problems.some((m) => m.includes('mac-arm64') && /no app artifact/i.test(m))).toBe(true)
    })

    it('fails when a declared platform has its artifact but no launcher', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-nolauncher-')
      provisionApp(root)
      rmSync(join(root, LAUNCHER['linux-x64']))
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.launchersPresent).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(true)
      expect(res.problems.some((m) => m.includes(LAUNCHER['linux-x64']))).toBe(true)
    })

    it('fails when the declared platform set is only partly provisioned', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-partial-')
      provisionApp(root, ['win-x64'])
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.checks.launchersPresent).toBe(false)
      expect(res.problems.some((m) => m.includes('mac-arm64'))).toBe(true)
      expect(res.problems.some((m) => m.includes('linux-x64'))).toBe(true)
    })

    it('fails when two app artifacts of one platform sit at the root (an older build beside the new one)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-twoapps-')
      provisionApp(root)
      writeFileSync(join(root, 'HilbertRaum-0.1.58-portable.exe'), 'old-app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      const dup = res.problems.find((m) => /more than one app artifact/i.test(m))
      expect(dup).toBeDefined()
      expect(dup).toContain('HilbertRaum-0.1.58-portable.exe')
      expect(dup).toContain(ARTIFACT['win-x64'])
    })

    it('fails when the only artifact carries another version than the one being built', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-oldversion-')
      provisionApp(root)
      rmSync(join(root, ARTIFACT['win-x64']))
      writeFileSync(join(root, 'HilbertRaum-0.1.58-portable.exe'), 'old-app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.problems.some((m) => m.includes('0.1.58') && m.includes(APP_VERSION))).toBe(true)
    })

    it('fails when the drive carries an artifact for a platform the kit is NOT declared for', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-undeclared-')
      provisionApp(root)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit(['win-x64']))
      expect(res.ok).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.problems.some((m) => m.includes(ARTIFACT['mac-arm64']) && /not declared/i.test(m))).toBe(true)
      expect(res.problems.some((m) => m.includes(ARTIFACT['linux-x64']) && /not declared/i.test(m))).toBe(true)
    })

    it('a single-platform kit passes with just that platform declared and provisioned', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-winonly-')
      provisionApp(root, ['win-x64'])
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit(['win-x64']))
      expect(res.ok).toBe(true)
      expect(res.checks.platformMatrixDeclared).toBe(true)
      expect(res.checks.appArtifactsPresent).toBe(true)
      expect(res.checks.launchersPresent).toBe(true)
    })

    // T3.8 (owner 2026-11-26, the T3.8 sheet Q1; reverses #233's earlier acceptance, which predates the drive record): a
    // Kit carries the macOS app as its zip, as the builder copies it. An extracted `.app` folder carries no version for
    // release 1's rule, so the record cannot name it and T5.10 cannot verify it: refused with one line, its Info.plist
    // never read. Any root folder ending `.app`, a hidden one included (wider than the root classifier, whose `*` skips a
    // leading dot); it still counts as the mac app, so one beside the zip is also "more than one".
    const appFolderLine = (name: string): string =>
      `app artifact "${name}" is an extracted app folder — a Kit carries ${ARTIFACT['mac-arm64']} (the start file unpacks it): ` +
      `replace the folder by the zip, then write the record again: ${WRITE_RECORD}`
    /** The gate's lines about the root apps: what it says of each artifact and of the mac platform. */
    const appLines = (problems: string[]): string[] => problems.filter((m) => m.startsWith('app artifact') || /^(win-x64|mac-arm64|linux-x64): /.test(m))

    it('refuses a lone extracted .app, whatever version its Info.plist carries (T3.8; was a pass for its own version, #233)', async () => {
      for (const version of [APP_VERSION, '0.1.58']) {
        const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-appdir-')
        provisionApp(root)
        rmSync(join(root, ARTIFACT['mac-arm64']))
        provisionExtractedApp(root, version)
        const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
        expect(res.ok, version).toBe(false)
        expect(res.checks.appArtifactsPresent, version).toBe(false)
        expect(appLines(res.problems), version).toEqual([appFolderLine('HilbertRaum.app')])
      }
    })

    it('refuses a hidden extracted .app too (T3.8)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-appdir-hidden-')
      provisionApp(root)
      rmSync(join(root, ARTIFACT['mac-arm64']))
      mkdirSync(join(root, '.HilbertRaum.app', 'Contents'), { recursive: true })
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(appLines(res.problems)).toEqual([appFolderLine('.HilbertRaum.app')])
    })

    it('refuses a .app beside the .app.zip: the folder, and more than one mac app (T3.8)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-appdir-both-')
      provisionApp(root)
      provisionExtractedApp(root, APP_VERSION)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.ok).toBe(false)
      expect(res.problems).toContain(appFolderLine('HilbertRaum.app'))
      const dup = res.problems.find((m) => /more than one app artifact/i.test(m))
      expect(dup).toBeDefined()
      expect(dup).toContain('HilbertRaum.app')
      expect(dup).toContain(ARTIFACT['mac-arm64'])
    })

    // T3.8 (Δ-64): the gate judges the root apps by T3.3a's rootArtifactOf, one classifier (the record's app_version was
    // chosen by it, and release 1's version rule reads the root through it). A name inside a platform's glob whose
    // segment is no version is that platform's app of no known version.
    it.each([
      ['a segment that is no version', 'HilbertRaum-latest-portable.exe'],
      ['an empty segment', 'HilbertRaum--portable.exe']
    ])('refuses a win artifact whose name carries no version: %s (T3.8)', async (_title, name) => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-noversion-')
      provisionApp(root)
      rmSync(join(root, ARTIFACT['win-x64']))
      writeFileSync(join(root, name), 'app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(appLines(res.problems)).toEqual([`win-x64: app artifact "${name}" carries no version in its name (expected ${ARTIFACT['win-x64']})`])
    })

    // The Windows start file finds its app without case (cmd's glob), so a second app in another case is a second app to
    // it (#235): the gate's own rule for any other root file named like an app ignores case (the T3.8 sheet F5, Q8; the
    // classifier stays exact until P6, CF-33).
    const notAnArtifactLine = (name: string): string =>
      `app artifact "${name}" is not a release artifact of any platform (expected HilbertRaum-<version>-portable.exe, ` +
      'HilbertRaum-<version>-mac-arm64.app.zip, HilbertRaum-<version>.AppImage)'
    it.each([
      ['an older app in another case', 'hilbertraum-0.1.58-portable.exe'],
      ['a name no platform uses', `HilbertRaum-${APP_VERSION}-mac-x64.app.zip`]
    ])('refuses any other root file named like an app: %s (T3.8)', async (_title, name) => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-notanapp-')
      provisionApp(root)
      writeFileSync(join(root, name), 'app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(appLines(res.problems)).toEqual([notAnArtifactLine(name)])
    })

    // T3.8: the one spelling besides the classifier is the expected name in the gate's lines (KIT_PLATFORM_SPECS, the
    // exported table on purpose here); each must be its platform's app to the classifier, carrying that version.
    it.each(['0.1.59', '1.4.0-rc.1'])("every platform's expected artifact name is its app to the root classifier, carrying %s (T3.8)", (v) => {
      const system: Record<KitPlatform, string> = { 'win-x64': 'win32', 'mac-arm64': 'darwin', 'linux-x64': 'linux' }
      for (const p of KIT_PLATFORMS) expect(rootArtifactOf(KIT_PLATFORM_SPECS[p].artifact(v), 'file'), p).toEqual({ system: system[p], version: v })
    })

    // W-33 (Δ-37, T1.11 P3-3; T3.8): release 1's Windows start file tells a running app by opening it for writing
    // (docs/app-updates.md §5.6), so a read-only app reads "in flight" at every start: the launch counter never counts and
    // a broken new version never falls back. The gate refuses a root app no one may write (on Windows: the read-only
    // attribute).
    it('refuses a root app that is read-only (T3.8)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-readonly-')
      provisionApp(root)
      const exe = join(root, ARTIFACT['win-x64'])
      chmodSync(exe, 0o444)
      try {
        const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
        expect(res.problems).toEqual([
          `app artifact "${ARTIFACT['win-x64']}" is read-only — clear the read-only attribute (attrib -r on Windows, chmod u+w ` +
            "on macOS or Linux): with it set, release 1's start file reads the app as running at every start, and its launch " +
            'counter never counts'
        ])
        expect(res.checks.appArtifactsPresent).toBe(false)
      } finally {
        chmodSync(exe, 0o666)
      }
      expect((await assertCommercialDrive(root, [chat], null, null, null, kit())).problems).toEqual([])
    })

    it('fails closed when no platform matrix is declared (nothing to check the app against)', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-nomatrix-')
      provisionApp(root)
      const res = await assertCommercialDrive(root, [chat])
      expect(res.ok).toBe(false)
      expect(res.checks.platformMatrixDeclared).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(false)
      expect(res.checks.launchersPresent).toBe(false)
      expect(res.problems.some((m) => /platform/i.test(m))).toBe(true)
    })

    it('rejects an empty, duplicated or unknown platform declaration and a missing version', async () => {
      const { root, chat } = otherwiseValidDrive('hilbertraum-commercial-badmatrix-')
      provisionApp(root)
      const bad = [
        { platforms: [] as KitPlatform[], appVersion: APP_VERSION },
        { platforms: ['win-x64', 'win-x64'] as KitPlatform[], appVersion: APP_VERSION },
        { platforms: ['win-arm64' as KitPlatform], appVersion: APP_VERSION },
        { platforms: ALL_PLATFORMS, appVersion: '' }
      ]
      for (const opts of bad) {
        const res = await assertCommercialDrive(root, [chat], null, null, null, opts)
        expect(res.ok, JSON.stringify(opts)).toBe(false)
        expect(res.checks.platformMatrixDeclared, JSON.stringify(opts)).toBe(false)
      }
    })
  })

  // T3.8 (W-33 M1, W-20, W-17): the two files the Kit builder writes last. The record reads as T3.3a's frozen reader reads
  // it, and its app_version must be the one version the root's apps carry by rootArtifactOf (the helper's own rule); the
  // support end reads through readKitSupport and must be the builder's 8 bytes. Each line names the way out; the record
  // lines say to check again after writing it, since -VerifyOnly writes nothing (the hand-copy flow, T3.3b F4).
  describe('the release record and the support end (T3.8)', () => {
    /** A drive the gate passes. */
    function kitDrive(prefix: string): { root: string; chat: ModelManifest } {
      const root = tempDir(prefix)
      writePolicy(root, buildPolicyJson({ kit: true }))
      provisionAppSkill(root)
      provisionLicenseArtifacts(root)
      const chat = writeVerifiedWeight(root, 'chat', 'models/chat/qwen.gguf', 'chat-weights')
      provisionApp(root)
      return { root, chat }
    }
    const NO_VERSION_LINE =
      'config/drive-release.json records no app version — the apps were copied onto the drive after the record was ' +
      `written: write it again: ${WRITE_RECORD}, then run the check again (-VerifyOnly / --verify-only writes nothing)`

    it.each<[string, (root: string) => void, string]>([
      ['no record', (root) => rmSync(join(root, RECORD)), RECORD_MISSING_LINE],
      ['a record that is not JSON', (root) => writeRecord(root, 'not json'), `config/drive-release.json is damaged (not-json) — write it again: ${WRITE_RECORD}`],
      [
        'a folder where the record belongs',
        (root) => {
          rmSync(join(root, RECORD))
          mkdirSync(join(root, RECORD))
        },
        `config/drive-release.json is damaged (not-a-file) — delete what is at that name, then write it again: ${WRITE_RECORD}`
      ],
      ['a record without an app version (apps copied after it was written)', (root) => writeRecord(root, JSON.stringify({ format: 1, systems: [], files: [] })), NO_VERSION_LINE],
      ['a record whose app version is no version', (root) => writeRecord(root, JSON.stringify({ format: 1, app_version: 'latest' })), NO_VERSION_LINE],
      [
        'a record of another version',
        (root) => writeRecord(root, JSON.stringify({ format: 1, app_version: '0.1.58' })),
        `config/drive-release.json records app version 0.1.58, the apps on the drive carry ${APP_VERSION} — write the record again: ${WRITE_RECORD}`
      ]
    ])('refuses a Kit with %s', async (_title, edit, line) => {
      const { root, chat } = kitDrive('hilbertraum-commercial-record-')
      edit(root)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.problems).toEqual([line])
      expect(res.checks.releaseRecordCurrent).toBe(false)
      expect(res.checks.appArtifactsPresent).toBe(true)
      expect(res.checks.supportEndStamped).toBe(true)
    })

    it('refuses a record it cannot read just now, naming the errno token', async () => {
      const { root, chat } = kitDrive('hilbertraum-commercial-record-deny-')
      denyReading(join(root, RECORD))
      try {
        const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
        expect(res.problems).toEqual([expect.stringMatching(/^config\/drive-release\.json could not be read \(E[A-Z]+\) — check the drive, then run the gate again$/)])
        expect(res.checks.releaseRecordCurrent).toBe(false)
      } finally {
        allowReading(join(root, RECORD))
      }
    })

    it("refuses a record when the apps carry no single version, after the apps' own line", async () => {
      const { root, chat } = kitDrive('hilbertraum-commercial-record-mixed-')
      rmSync(join(root, ARTIFACT['mac-arm64']))
      writeFileSync(join(root, 'HilbertRaum-0.1.58-mac-arm64.app.zip'), 'app-bytes')
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.problems).toEqual([
        `mac-arm64: app artifact "HilbertRaum-0.1.58-mac-arm64.app.zip" is version 0.1.58, the kit is being built as ${APP_VERSION}`,
        `config/drive-release.json records app version ${APP_VERSION}, but the apps on the drive carry no single version — ` +
          `fix the apps (see above), then write the record again: ${WRITE_RECORD}`
      ])
      expect(res.checks.releaseRecordCurrent).toBe(false)
    })

    // The helper and the gate agree: what write-drive-release.mjs records over the drive (the builder's last write) passes.
    it('passes the record write-drive-release.mjs writes over the drive', async () => {
      const { root, chat } = kitDrive('hilbertraum-commercial-record-helper-')
      rmSync(join(root, RECORD))
      writeFileSync(join(root, 'config', 'drive.json'), '{}') // the helper writes only on a prepared drive
      const helper = join(__dirname, '..', '..', '..', '..', 'scripts', 'lib', 'write-drive-release.mjs')
      const run = spawnSync(process.execPath, ['--no-warnings', helper, '--target', root], { encoding: 'utf8' })
      expect(run.status, `${run.stdout}${run.stderr}`).toBe(0)
      expect(run.stdout).toContain(`app_version=${APP_VERSION} `)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.problems).toEqual([])
      expect(res.ok).toBe(true)
    })

    const UNREADABLE_STAMP = (fault: string): string =>
      `config/kit-support.txt is not a support end the app can read (${fault}) — look at it by hand; to stamp the Kit ` +
      'again, delete the file on purpose and run build-commercial-drive with -SupportEnd / --support-end'
    const STAMP_BYTES_LINE =
      "config/kit-support.txt holds a month, but not in the builder's bytes (YYYY-MM and one line feed) — delete the file on " +
      'purpose and stamp it again with build-commercial-drive -SupportEnd / --support-end'
    it.each<[string, (root: string) => void, string]>([
      ['no support end', (root) => rmSync(join(root, STAMP)), STAMP_MISSING_LINE],
      [
        'a folder where the stamp belongs',
        (root) => {
          rmSync(join(root, STAMP))
          mkdirSync(join(root, STAMP))
        },
        UNREADABLE_STAMP('not-a-file')
      ],
      ['a month that does not exist', (root) => writeFileSync(join(root, STAMP), '2031-13\n'), UNREADABLE_STAMP('not-a-month')],
      ['the month with CR LF (a hand edit)', (root) => writeFileSync(join(root, STAMP), '2031-12\r\n'), STAMP_BYTES_LINE],
      ['the month after a byte-order mark', (root) => writeFileSync(join(root, STAMP), '﻿2031-12\n'), STAMP_BYTES_LINE],
      ['the month without its line feed', (root) => writeFileSync(join(root, STAMP), '2031-12'), STAMP_BYTES_LINE]
    ])('refuses a Kit with %s', async (_title, edit, line) => {
      const { root, chat } = kitDrive('hilbertraum-commercial-stamp-')
      edit(root)
      const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
      expect(res.problems).toEqual([line])
      expect(res.checks.supportEndStamped).toBe(false)
      expect(res.checks.releaseRecordCurrent).toBe(true)
    })

    it('refuses a support end it cannot read just now, naming the errno token', async () => {
      const { root, chat } = kitDrive('hilbertraum-commercial-stamp-deny-')
      denyReading(join(root, STAMP))
      try {
        const res = await assertCommercialDrive(root, [chat], null, null, null, kit())
        expect(res.problems).toEqual([expect.stringMatching(/^config\/kit-support\.txt could not be read \(E[A-Z]+\) — check the drive, then run the gate again$/)])
        expect(res.checks.supportEndStamped).toBe(false)
      } finally {
        allowReading(join(root, STAMP))
      }
    })
  })
})
