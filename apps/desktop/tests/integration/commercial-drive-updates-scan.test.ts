import { describe, it, expect } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertCommercialDrive } from '../../src/main/services/commercial-drive'
import { buildPolicyJson } from '../../src/main/services/drive'
import { rootApps } from '../../src/main/services/updates/drive-release'
import type { ModelManifest } from '../../src/shared/manifest'
import type { KitPlatform } from '../../src/shared/runtime-sources'
import { validManifest, writeDriveFile } from '../helpers/manifest-fixtures'

// The root scans as built, against a drive that holds a staged update (app-update T6.2, Δ-80 row 7; F-18's root-glob
// half; docs/app-updates.md §4.2 "the update file's own name", §4.4 "The root globs release 1 reads", §9.5 the sell
// gate): staging writes nothing but under updates/, so a staged update's app files (files/HilbertRaum-<v>-portable.exe and
// the rest) are never a root app, for the root-app classifier (rootApps, drive-release.ts) nor for the sell gate's app
// lines; and the sell gate refuses a drive with any entry in updates/ (T3.8), a staged update included, and a root file
// `HilbertRaum-*` that is no app (an update file named inside that prefix included), while an update file named outside
// it is no app and no problem. commercial-drive.ts is P5's: this file reads it and pins what it does today. The names are
// spelled here as literals, as commercial-drive.test.ts spells them, so the test stays an independent check.

const APP_VERSION = '0.1.59'
const ALL_PLATFORMS: KitPlatform[] = ['win-x64', 'mac-arm64', 'linux-x64']
const ARTIFACT: Record<KitPlatform, string> = {
  'win-x64': `HilbertRaum-${APP_VERSION}-portable.exe`,
  'mac-arm64': `HilbertRaum-${APP_VERSION}-mac-arm64.app.zip`,
  'linux-x64': `HilbertRaum-${APP_VERSION}.AppImage`
}
const LAUNCHER: Record<KitPlatform, string> = {
  'win-x64': 'Start HilbertRaum.cmd',
  'mac-arm64': 'Start HilbertRaum.command',
  'linux-x64': 'start-hilbertraum.sh'
}
/** What the gate adds to a line for an entry in `updates/` (T3.8). */
const STARTED = ' — this drive was started: delete the updates/ folder (a test start belongs on a copy, never on the Kit)'
const NOT_AN_APP = (name: string): string =>
  `app artifact "${name}" is not a release artifact of any platform (expected HilbertRaum-<version>-portable.exe, ` +
  'HilbertRaum-<version>-mac-arm64.app.zip, HilbertRaum-<version>.AppImage)'

/** A drive the gate passes (commercial-drive.test.ts's "passes on a verified, commercial-posture drive"), and its weight. */
function sellableDrive(): { root: string; chat: ModelManifest } {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-commercial-updates-scan-'))
  mkdirSync(join(root, 'config'), { recursive: true })
  writeFileSync(join(root, 'config', 'policy.json'), JSON.stringify(buildPolicyJson({ kit: true })))
  const skill = join(root, 'app-skills', 'bank-statement')
  mkdirSync(skill, { recursive: true })
  writeFileSync(join(skill, 'SKILL.md'), ['---', 'id: bank-statement', 'title: bank-statement', 'description: a skill', 'version: 1.0.0', '---', 'Guidance.'].join('\n'))
  for (const name of ['LICENSE', 'THIRD-PARTY-NOTICES.md', 'DRIVE-NOTICES.md']) writeFileSync(join(root, name), `${name} text`)
  const chat = validManifest({
    id: 'chat',
    local_path: 'models/chat/qwen.gguf',
    sha256: writeDriveFile(root, 'models/chat/qwen.gguf', 'chat-weights'),
    license_review: { status: 'approved', reviewed_by: 'legal', reviewed_at: '2026-06-09', notes: '' },
    bundled_on_preconfigured_drive: true
  })
  for (const p of ALL_PLATFORMS) {
    writeFileSync(join(root, ARTIFACT[p]), 'app-bytes')
    writeFileSync(join(root, LAUNCHER[p]), 'launcher')
  }
  writeFileSync(join(root, 'config', 'drive-release.json'), JSON.stringify({ format: 1, app_version: APP_VERSION }))
  writeFileSync(join(root, 'config', 'kit-support.txt'), '2031-12\n')
  return { root, chat }
}

/** A staged update of version 1.1.0 as record §4.2 lays it out: its app files under files/, its markers beside them. */
function stageUpdate(root: string): void {
  const dir = join(root, 'updates', 'staging', '1.1.0')
  mkdirSync(join(dir, 'files'), { recursive: true })
  for (const name of ['HilbertRaum-1.1.0-portable.exe', 'HilbertRaum-1.1.0-mac-arm64.app.zip', 'HilbertRaum-1.1.0.AppImage', 'apply.cmd', 'apply.sh']) {
    writeFileSync(join(dir, 'files', name), 'member-bytes')
  }
  writeFileSync(join(dir, 'hilbertraum-release.dsse.json'), '{}')
  writeFileSync(join(dir, 'staged.txt'), '12 apply.cmd\n')
  writeFileSync(join(dir, 'staged.json'), '{"format":1,"version":"1.1.0","files":[]}')
}

const gate = (root: string, chat: ModelManifest) => assertCommercialDrive(root, [chat], null, null, null, { platforms: ALL_PLATFORMS, appVersion: APP_VERSION })

describe('the root scans with a staged update on the drive (Δ-80 row 7; record §4.2, §4.4, §9.5)', () => {
  it('the sellable drive passes, and its root apps are the three root files', async () => {
    const { root, chat } = sellableDrive()
    expect(rootApps(root).map((app) => app.name).sort()).toEqual(Object.values(ARTIFACT).sort())
    expect((await gate(root, chat)).problems).toEqual([])
  })

  it('a staged update is never a root app: rootApps lists the root files alone', () => {
    const { root } = sellableDrive()
    stageUpdate(root)
    expect(rootApps(root).map((app) => ({ name: app.name, version: app.version }))).toEqual(
      Object.values(ARTIFACT)
        .sort()
        .map((name) => ({ name, version: APP_VERSION }))
    )
  })

  it('the sell gate refuses a drive with a staged update (an entry in updates/), and counts none of its files as an app', async () => {
    const { root, chat } = sellableDrive()
    stageUpdate(root)
    const res = await gate(root, chat)
    expect(res.problems).toEqual([`user data present on a drive meant to ship empty: updates/staging/*${STARTED}`])
    expect(res.checks.noUserData).toBe(false)
    expect(res.checks.appArtifactsPresent).toBe(true)
  })

  it('the sell gate refuses a leftover probe file, the one name an import writes before it reads the file (T3.8)', async () => {
    const { root, chat } = sellableDrive()
    mkdirSync(join(root, 'updates'))
    writeFileSync(join(root, 'updates', '.write-probe'), 'x')
    expect((await gate(root, chat)).problems).toEqual([`user data present on a drive meant to ship empty: updates/.write-probe${STARTED}`])
  })

  it.each(['HilbertRaum-1.1.0.hrupdate', 'hilbertraum-1.1.0.hrupdate'])(
    'the sell gate refuses a root file %s: an update file named inside the HilbertRaum-* prefix (any case) is no app',
    async (name) => {
      const { root, chat } = sellableDrive()
      writeFileSync(join(root, name), 'update-bytes')
      expect(rootApps(root).map((app) => app.name)).not.toContain(name)
      const res = await gate(root, chat)
      expect(res.problems).toEqual([NOT_AN_APP(name)])
      expect(res.checks.appArtifactsPresent).toBe(false)
    }
  )

  // T6.2 part 1b (CF-33; record §4.4 "Case"): each system's own start file decides, through rootArtifactOf, which the gate
  // calls. What changed: a Windows app name in another case was "not a release artifact of any platform" and left the
  // Kit without its Windows app; it is the Windows app now, carrying the version as written.
  it.each(['hilbertraum-0.1.59-portable.exe', 'HilbertRaum-0.1.59-PORTABLE.EXE'])(
    'a Kit whose Windows app is named %s passes the gate: its start file starts it, so it is the win-x64 app',
    async (name) => {
      const { root, chat } = sellableDrive()
      rmSync(join(root, ARTIFACT['win-x64']))
      writeFileSync(join(root, name), 'app-bytes')
      expect(rootApps(root).find((app) => app.system === 'win32')).toMatchObject({ name, version: APP_VERSION })
      expect((await gate(root, chat)).problems).toEqual([])
    }
  )

  // The app in another case replaces the app (a file system that folds case holds one of the two names).
  it.each<[string, KitPlatform]>([
    ['hilbertraum-0.1.59.AppImage', 'linux-x64'],
    ['HilbertRaum-0.1.59.appimage', 'linux-x64'],
    ['HilbertRaum-0.1.59-mac-arm64.app.ZIP', 'mac-arm64']
  ])('a macOS or Linux app named in another case (%s) is no app: refused as a HilbertRaum-* file, and the Kit lacks that app', async (name, platform) => {
    const { root, chat } = sellableDrive()
    rmSync(join(root, ARTIFACT[platform]))
    writeFileSync(join(root, name), 'app-bytes')
    expect(rootApps(root).map((app) => app.name)).not.toContain(name)
    expect((await gate(root, chat)).problems).toEqual([NOT_AN_APP(name), `${platform}: no app artifact at the drive root (expected ${ARTIFACT[platform]})`])
  })

  // Two names that differ only in case can sit side by side only where the file system keeps case apart (ext4: CI's
  // ubuntu leg); NTFS, exFAT and APFS hold one of them.
  const keepsCaseApart = ((): boolean => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-commercial-updates-scan-case-'))
    writeFileSync(join(dir, 'a'), '')
    return !existsSync(join(dir, 'A'))
  })()
  it.runIf(keepsCaseApart)('two Windows apps that differ only in case are two Windows apps: the gate refuses the second', async () => {
    const { root, chat } = sellableDrive()
    const other = ARTIFACT['win-x64'].toLowerCase()
    writeFileSync(join(root, other), 'app-bytes')
    expect(rootApps(root).filter((app) => app.system === 'win32').map((app) => app.name).sort()).toEqual([ARTIFACT['win-x64'], other].sort())
    const res = await gate(root, chat)
    expect(res.problems).toHaveLength(1)
    expect(res.problems[0]).toMatch(/^win-x64: more than one app artifact at the drive root \(.+\) — a drive must carry exactly one; delete the others$/)
    expect(res.problems[0]).toContain(other)
  })

  it.each(['update-1.1.0.hrupdate', 'HilbertRaum_1.1.0.hrupdate', 'Kit-update.hrupdate'])(
    'an update file named outside the prefix at the root (%s) is no app and no problem',
    async (name) => {
      const { root, chat } = sellableDrive()
      writeFileSync(join(root, name), 'update-bytes')
      expect(rootApps(root).map((app) => app.name)).not.toContain(name)
      expect((await gate(root, chat)).problems).toEqual([])
    }
  )
})
