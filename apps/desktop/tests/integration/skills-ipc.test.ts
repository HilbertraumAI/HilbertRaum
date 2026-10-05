import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, symlinkSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

// Skills plan Phase S4 — IPC round-trip (the registerCollectionsIpc test precedent) + the §22-M1
// content-class sentinel grep: a secret string is pushed through a skill's SKILL.md body/title AND
// through a REJECTED malicious import, then we prove it never reaches `runtime_events` NOR a
// preview/import IPC error payload.

// Recording pass-through wrapper over `node:fs` (#240). Every call still reaches the real
// filesystem; the mock only RECORDS `(fn, path)` for paths that carry the per-test probe token,
// so a test can prove that a renderer string was rejected BEFORE the first filesystem call.
// (`vi.spyOn(fs, …)` records nothing for a module that binds the ESM namespace — the
// workspace-vault-durability.test.ts idiom is the one that works.) Hoisted above the imports.
const fsLog = vi.hoisted(() => ({
  probe: '',
  calls: [] as Array<{ fn: string; path: string }>
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const record = <F extends (...args: never[]) => unknown>(fn: string, real: F): F =>
    ((...args: unknown[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0])
      if (fsLog.probe !== '' && p.includes(fsLog.probe)) fsLog.calls.push({ fn, path: p })
      return (real as unknown as (...a: unknown[]) => unknown)(...args)
    }) as unknown as F
  const mocked = {
    ...actual,
    lstatSync: record('lstatSync', actual.lstatSync),
    statSync: record('statSync', actual.statSync),
    realpathSync: record('realpathSync', actual.realpathSync),
    readdirSync: record('readdirSync', actual.readdirSync),
    readFileSync: record('readFileSync', actual.readFileSync)
  }
  return { ...mocked, default: mocked }
})
/** Arm the recorder for paths containing `probe` (a fresh token per test) and clear the log. */
function armFsLog(probe: string): void {
  fsLog.probe = probe
  fsLog.calls.length = 0
}

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  openDialog: { canceled: true as boolean, filePaths: [] as string[], opened: 0 },
  saveDialog: { canceled: true as boolean, filePath: undefined as string | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => {
      ipcState.openDialog.opened += 1
      return { canceled: ipcState.openDialog.canceled, filePaths: ipcState.openDialog.filePaths }
    },
    showSaveDialog: async () => ({ canceled: ipcState.saveDialog.canceled, filePath: ipcState.saveDialog.filePath })
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerSkillsIpc } from '../../src/main/ipc/registerSkillsIpc'
import { IPC } from '../../src/shared/ipc'
import type { Db } from '../../src/main/services/db'
import { listAuditEvents } from '../../src/main/services/audit'
import { getSkill, getSkillsByDeclaredId } from '../../src/main/services/skills/registry'
import { DEFAULT_SKILL_LIMITS } from '../../src/main/services/skills/limits'
import type { AppContext } from '../../src/main/services/context'
import type { SkillInfo, SkillPreview } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'
import { tempRoot } from '../helpers/db-fixtures'
import { skillMdText, writeSkillPackage } from '../helpers/skill-fixtures'
import { makeSkillsWorld, makeSkillsIpcContext } from '../helpers/skills-world'

const handlers = ipcState.handlers as unknown as IpcHandlers

const SENTINEL = 'XSKILL_SENTINEL_my_secret_account_is_99999'

const tempDir = (): string => tempRoot('skill-ipc')

// description = body: the sentinel grep relies on the body text also landing in the description.
const skillMd = (id: string, body: string): string => skillMdText({ id, title: `${id} skill`, description: body, body })

async function writeZip(members: Array<{ name: string; content: string }>): Promise<string> {
  const zip = new JSZip()
  for (const m of members) zip.file(m.name, m.content)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const path = join(tempDir(), 'pkg.skill.zip')
  writeFileSync(path, buf)
  return path
}

/**
 * Mint a picker token for `path` the way the renderer gets one: drive the (mocked) OS dialog
 * through `pickSkillPackage` (#240). Preview and import take that token, never a raw path.
 */
async function pickToken(path: string, mode: 'file' | 'folder' = 'file'): Promise<string> {
  ipcState.openDialog.canceled = false
  ipcState.openDialog.filePaths = [path]
  const { result } = await invoke(handlers, IPC.pickSkillPackage, mode)
  ipcState.openDialog.canceled = true
  ipcState.openDialog.filePaths = []
  return (result as { token: string }).token
}

interface Harness {
  ctx: AppContext
  db: Db
  appSkillsDir: string
  userSkillsDir: string
}

function makeHarness(): Harness {
  const w = makeSkillsWorld('skill-ipc', { createDirs: false })
  const ctx = makeSkillsIpcContext(w)
  registerSkillsIpc(ctx)
  return { ctx, db: w.db, appSkillsDir: w.appSkillsDir, userSkillsDir: w.userSkillsDir }
}

function allAuditText(db: Db): string {
  return listAuditEvents(db, { limit: 5000 })
    .map((e) => `${e.type} ${e.message} ${JSON.stringify(e.metadata)}`)
    .join('\n')
}

beforeEach(() => {
  ipcState.handlers.clear()
  ipcState.openDialog.canceled = true
  ipcState.openDialog.filePaths = []
  ipcState.openDialog.opened = 0
  ipcState.saveDialog.canceled = true
  ipcState.saveDialog.filePath = undefined
  armFsLog('')
})

describe('skills IPC — round-trip lifecycle', () => {
  it('preview → import → list → disable/enable → acknowledge → export → delete', async () => {
    const { db, userSkillsDir } = makeHarness()
    const zip = await writeZip([{ name: 'SKILL.md', content: skillMd('round-trip', 'A round trip skill.') }])

    // pick → preview (no write) → import, one token for the round trip (#240)
    const token = await pickToken(zip)
    const { result: prevRaw } = await invoke(handlers, IPC.previewSkillPackage, token)
    const preview = prevRaw as SkillPreview
    expect(preview.ok).toBe(true)
    expect(preview.id).toBe('round-trip')
    expect(preview.permissionSummary).toContain('cannot access the network')
    expect(existsSync(join(userSkillsDir, 'round-trip'))).toBe(false) // nothing persisted

    // import (enabled-with-warning)
    const { result: impRaw } = await invoke(handlers, IPC.importSkill, token)
    const info = impRaw as SkillInfo
    expect(info.enabled).toBe(true)
    expect(info.warningAck).toBe(false)

    // list
    const { result: listRaw } = await invoke(handlers, IPC.listSkills)
    expect((listRaw as SkillInfo[]).map((s) => s.id)).toContain('round-trip')

    // disable / enable
    const { result: disRaw } = await invoke(handlers, IPC.disableSkill, info.installId)
    expect((disRaw as SkillInfo).enabled).toBe(false)
    const { result: enRaw } = await invoke(handlers, IPC.enableSkill, info.installId)
    expect((enRaw as SkillInfo).enabled).toBe(true)

    // acknowledge the warning
    const { result: ackRaw } = await invoke(handlers, IPC.acknowledgeSkillWarning, info.installId)
    expect((ackRaw as SkillInfo).warningAck).toBe(true)

    // export (save dialog → a file)
    const dest = join(tempDir(), 'out.skill.zip')
    ipcState.saveDialog.canceled = false
    ipcState.saveDialog.filePath = dest
    const { result: exportPath } = await invoke(handlers, IPC.exportSkill, info.installId)
    expect(exportPath).toBe(dest)
    expect(existsSync(dest)).toBe(true)

    // delete
    await invoke(handlers, IPC.deleteSkill, info.installId)
    const { result: gone } = await invoke(handlers, IPC.getSkill, info.installId)
    expect(gone).toBeNull()
    expect(existsSync(join(userSkillsDir, 'round-trip'))).toBe(false)

    // the expected lifecycle audit events landed
    const types = listAuditEvents(db, { limit: 5000 }).map((e) => e.type)
    for (const t of ['skill_imported', 'skill_disabled', 'skill_enabled', 'skill_deleted']) {
      expect(types, `missing ${t}`).toContain(t)
    }
  })

  it('pickSkillPackage returns { token, path } for the chosen path (or null on cancel) (#240)', async () => {
    makeHarness()
    const { result: cancelled } = await invoke(handlers, IPC.pickSkillPackage)
    expect(cancelled).toBeNull()
    ipcState.openDialog.canceled = false
    ipcState.openDialog.filePaths = ['/tmp/chosen.skill.zip']
    const { result: chosen } = await invoke(handlers, IPC.pickSkillPackage, 'file')
    // The path is renderer display only; the token is what preview/import redeem.
    expect(chosen).toEqual({ token: expect.any(String), path: '/tmp/chosen.skill.zip' })
    expect((chosen as { token: string }).token).not.toBe('')
    // Two picks never share a token.
    const { result: again } = await invoke(handlers, IPC.pickSkillPackage, 'file')
    expect((again as { token: string }).token).not.toBe((chosen as { token: string }).token)
  })

  it('locked workspace → friendly error, no crash', async () => {
    const w = makeSkillsWorld('skill-ipc', { createDirs: false })
    // No `audit` key at all in this ctx (the locked-workspace test never builds a recorder).
    registerSkillsIpc(makeSkillsIpcContext(w, { unlocked: false, audit: false }))
    await expect(invoke(handlers, IPC.listSkills)).rejects.toThrow(/locked/i)
    // The picker is gated too: no OS dialog opens while the workspace is locked (#240).
    ipcState.openDialog.canceled = false
    ipcState.openDialog.filePaths = ['/tmp/locked.skill.zip']
    await expect(invoke(handlers, IPC.pickSkillPackage, 'file')).rejects.toThrow(/locked/i)
    expect(ipcState.openDialog.opened).toBe(0)
  })
})

describe('skills IPC — content-class sentinel grep (§22-M1)', () => {
  it('never records skill body content in audit, nor echoes attacker content in an import error', async () => {
    const { db } = makeHarness()

    // 1) A VALID skill whose body/title/description all carry the sentinel — import succeeds and
    //    the body really lands on disk, but the audit event must carry id/source/count only.
    const good = await writeZip([{ name: 'SKILL.md', content: skillMd('secret-skill', SENTINEL) }])
    const { result: info } = await invoke(handlers, IPC.importSkill, await pickToken(good))
    expect((info as SkillInfo).id).toBe('secret-skill')

    // 2) A REJECTED malicious import whose MEMBER NAME carries the sentinel — the structural error
    //    must not echo it back through the IPC payload.
    const evil = await writeZip([
      { name: 'SKILL.md', content: skillMd('evil', SENTINEL) },
      { name: `../${SENTINEL}.txt`, content: SENTINEL }
    ])
    let rejected: unknown
    try {
      await invoke(handlers, IPC.importSkill, await pickToken(evil))
    } catch (e) {
      rejected = e
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).not.toContain(SENTINEL)

    // 3) Preview of a malicious package returns structural errors only — no sentinel.
    const { result: prevRaw } = await invoke(handlers, IPC.previewSkillPackage, await pickToken(evil))
    const preview = prevRaw as SkillPreview
    expect(preview.ok).toBe(false)
    expect(JSON.stringify(preview)).not.toContain(SENTINEL)

    // The audit log carried the lifecycle events but NEVER the body/title/member-name sentinel.
    const audit = allAuditText(db)
    expect(audit).toContain('skill_imported')
    expect(audit).not.toContain(SENTINEL)
  })
})

// SKA-32 (audit 2026-07-03, U7): the Settings → Skills "N folders could not be read" surfacing.
// The payload is COUNTS + fixed reason codes only — a broken drop-in folder's name (arbitrary user
// text) must never cross the IPC (§22-M1).
describe('skills IPC — reconcile status (SKA-32)', () => {
  it('reports counts + codes for unreadable drop-in folders, never the folder name', async () => {
    const { userSkillsDir } = makeHarness()
    // A drop-in with a YAML typo (the audit's motivating case) + an invalid folder name carrying
    // the sentinel. Both must surface only as count/code.
    mkdirSync(join(userSkillsDir, 'broken-yaml'), { recursive: true })
    writeFileSync(
      join(userSkillsDir, 'broken-yaml', 'SKILL.md'),
      `---\nid: broken-yaml\ntitle: "unterminated\n---\nBody.`
    )
    mkdirSync(join(userSkillsDir, `Bad ${SENTINEL}`), { recursive: true })
    writeFileSync(join(userSkillsDir, `Bad ${SENTINEL}`, 'SKILL.md'), 'not even frontmatter')

    // No listSkills first: the status handler's own list() must trigger the lazy reconcile.
    const { result } = await invoke(handlers, IPC.skillReconcileStatus)
    const status = result as { errorCount: number; errorCodes: string[] }
    expect(status.errorCount).toBe(2)
    expect([...status.errorCodes].sort()).toEqual(['invalidFolderName', 'invalidManifest'])
    expect(JSON.stringify(status)).not.toContain(SENTINEL)
  })

  // Review hardening: an import (which reconciles through the MODULE function) must refresh the
  // handle's summary — otherwise fixing a broken drop-in by importing a corrected zip left a
  // phantom "folder could not be read" notice until restart.
  it('the status refreshes after an import fixes the tree (no phantom notice)', async () => {
    const { userSkillsDir } = makeHarness()
    mkdirSync(join(userSkillsDir, 'fixme'), { recursive: true })
    writeFileSync(join(userSkillsDir, 'fixme', 'SKILL.md'), 'not even frontmatter')
    await invoke(handlers, IPC.listSkills)
    const { result: before } = await invoke(handlers, IPC.skillReconcileStatus)
    expect((before as { errorCount: number }).errorCount).toBe(1)

    // The user fixes it by importing a corrected package of the same id (replaces the folder).
    const fixed = await writeZip([{ name: 'SKILL.md', content: skillMd('fixme', 'Now valid.') }])
    await invoke(handlers, IPC.importSkill, await pickToken(fixed))
    const { result: after } = await invoke(handlers, IPC.skillReconcileStatus)
    expect(after).toEqual({ errorCount: 0, errorCodes: [] })
  })
})

// #240: preview/import redeem a picker token — a renderer-supplied STRING is refused before the
// first filesystem call. The recorder above proves the "before": with a probe token in the path,
// an empty call log means nothing was lstat'ed/stat'ed/read. The walk bounds are kept as
// inequalities (the installer's own limits), never as observed counts. Proves nothing about
// UNC/SMB — no network path is ever handed to a real filesystem call in any test.
describe('skills IPC — picker token binds preview/import to the OS dialog (#240)', () => {
  /** A folder-kind package tree under a probe-named temp root. */
  function folderPackage(probe: string, body = 'A folder skill.'): string {
    const root = mkdtempSync(join(tmpdir(), `hilbertraum-skill-${probe}-`))
    const pkg = join(root, 'pkg')
    mkdirSync(pkg)
    writeFileSync(join(pkg, 'SKILL.md'), skillMd('folder-skill', body))
    return pkg
  }

  it('a non-token string or junk is rejected by preview AND import with no filesystem call', async () => {
    const { userSkillsDir } = makeHarness()
    const probe = `probe-${randomUUID()}`
    armFsLog(probe)
    // A path that does not exist: the pre-fix installer lstat'ed it first (and only).
    const missing = join(tmpdir(), `${probe}-missing.skill.zip`)
    await expect(invoke(handlers, IPC.previewSkillPackage, missing)).rejects.toThrow()
    expect(fsLog.calls).toEqual([])
    await expect(invoke(handlers, IPC.importSkill, missing)).rejects.toThrow()
    expect(fsLog.calls).toEqual([])
    // An EXISTING, valid package named directly (not picked) is refused just the same.
    const real = folderPackage(probe)
    await expect(invoke(handlers, IPC.previewSkillPackage, real)).rejects.toThrow()
    await expect(invoke(handlers, IPC.importSkill, real)).rejects.toThrow()
    expect(fsLog.calls).toEqual([])
    expect(existsSync(join(userSkillsDir, 'folder-skill'))).toBe(false)
    // Junk (non-string, empty, unknown uuid) is refused the same way.
    for (const junk of [undefined, null, 42, '', randomUUID(), { token: 'x' }]) {
      await expect(invoke(handlers, IPC.previewSkillPackage, junk)).rejects.toThrow()
      await expect(invoke(handlers, IPC.importSkill, junk)).rejects.toThrow()
    }
    expect(fsLog.calls).toEqual([])
  })

  it('the token from pickSkillPackage previews, then imports once, then is spent', async () => {
    const { userSkillsDir } = makeHarness()
    const probe = `probe-${randomUUID()}`
    const pkg = folderPackage(probe)
    const token = await pickToken(pkg, 'folder')
    armFsLog(probe)
    // Preview does not spend the token (the renderer previews, then confirms).
    const { result: p1 } = await invoke(handlers, IPC.previewSkillPackage, token)
    expect((p1 as SkillPreview).ok).toBe(true)
    const { result: p2 } = await invoke(handlers, IPC.previewSkillPackage, token)
    expect((p2 as SkillPreview).ok).toBe(true)
    expect(fsLog.calls[0]).toEqual({ fn: 'lstatSync', path: pkg })
    // Import spends it.
    const { result: info } = await invoke(handlers, IPC.importSkill, token)
    expect((info as SkillInfo).id).toBe('folder-skill')
    expect(existsSync(join(userSkillsDir, 'folder-skill'))).toBe(true)
    // A replay of the spent token: refused, no filesystem call.
    armFsLog(probe)
    await expect(invoke(handlers, IPC.importSkill, token)).rejects.toThrow()
    await expect(invoke(handlers, IPC.previewSkillPackage, token)).rejects.toThrow()
    expect(fsLog.calls).toEqual([])
  })

  it('a picked folder with a junction loop: the walk terminates and the link is refused', async () => {
    makeHarness()
    const probe = `probe-${randomUUID()}`
    const pkg = folderPackage(probe)
    // A directory link back to the package root (a Windows junction needs no privilege; a
    // 'dir' symlink elsewhere).
    try {
      symlinkSync(pkg, join(pkg, 'loop'), 'junction')
    } catch {
      symlinkSync(pkg, join(pkg, 'loop'), 'dir')
    }
    const token = await pickToken(pkg, 'folder')
    armFsLog(probe)
    const { result } = await invoke(handlers, IPC.previewSkillPackage, token)
    expect((result as SkillPreview).ok).toBe(false)
    // Refused as a link, not as an over-deep walk that followed it.
    expect((result as SkillPreview).errorCodes).toEqual(['symlink'])
    expect(fsLog.calls[0]).toEqual({ fn: 'lstatSync', path: pkg })
  })

  it('a deep tree and a wide tree stay inside the installer bounds (inequalities)', async () => {
    makeHarness()
    const probe = `probe-${randomUUID()}`
    // Depth 50: one nested directory per level.
    const deep = folderPackage(probe)
    let cur = deep
    for (let i = 0; i < 50; i++) {
      cur = join(cur, `d${i}`)
      mkdirSync(cur)
      writeFileSync(join(cur, 'note.txt'), 'x')
    }
    armFsLog(probe)
    const { result: deepRes } = await invoke(handlers, IPC.previewSkillPackage, await pickToken(deep, 'folder'))
    expect((deepRes as SkillPreview).ok).toBe(false)
    expect(fsLog.calls[0]).toEqual({ fn: 'lstatSync', path: deep })
    expect(fsLog.calls.filter((c) => c.fn === 'readdirSync').length).toBeLessThanOrEqual(DEFAULT_SKILL_LIMITS.maxDepth + 2)
    // Width 500: flat files beside SKILL.md.
    const wide = folderPackage(probe)
    for (let i = 0; i < 500; i++) writeFileSync(join(wide, `f${i}.txt`), 'x')
    armFsLog(probe)
    const { result: wideRes } = await invoke(handlers, IPC.previewSkillPackage, await pickToken(wide, 'folder'))
    expect((wideRes as SkillPreview).ok).toBe(false)
    expect(fsLog.calls[0]).toEqual({ fn: 'lstatSync', path: wide })
    expect(fsLog.calls.filter((c) => c.fn === 'readFileSync').length).toBeLessThanOrEqual(DEFAULT_SKILL_LIMITS.maxFiles + 1)
  })
})

/** A skills world with seeded skill folders and the handlers registered over it (#583). */
function seededHarness(
  seed: { app?: Array<Parameters<typeof writeSkillPackage>[1]>; user?: Array<Parameters<typeof writeSkillPackage>[1]> },
  o: { reconcile?: boolean; unlocked?: boolean } = {}
): Harness {
  const w = makeSkillsWorld('skill-ipc', {
    reconcile: o.reconcile,
    seedApp: (dir) => seed.app?.forEach((s) => writeSkillPackage(dir, s)),
    seedUser: (dir) => seed.user?.forEach((s) => writeSkillPackage(dir, s))
  })
  const ctx = makeSkillsIpcContext(w, { unlocked: o.unlocked })
  registerSkillsIpc(ctx)
  return { ctx, db: w.db, appSkillsDir: w.appSkillsDir, userSkillsDir: w.userSkillsDir }
}

const enabledOf = (db: Db, installId: string): boolean | undefined => getSkill(db, installId)?.enabled

// #583: `setSkillEnabled` is a bare UPDATE — the one-active-per-id sweep and the newer-app refusal
// live only in this handler (the registry's reconcile safety net is a different path).
describe('skills IPC — enableSkill policy (#583)', () => {
  it('enabling one same-id skill disables the other, in both directions', async () => {
    const { db } = seededHarness(
      { app: [{ id: 'shared' }, { id: 'bystander' }], user: [{ id: 'shared' }] },
      { reconcile: true }
    )
    // Precondition: the app skill is installed enabled, the user drop-in is not.
    expect(enabledOf(db, 'app:shared')).toBe(true)
    expect(enabledOf(db, 'user:shared')).toBe(false)
    expect(enabledOf(db, 'app:bystander')).toBe(true)

    await invoke(handlers, IPC.enableSkill, 'user:shared')
    expect(enabledOf(db, 'user:shared')).toBe(true)
    expect(enabledOf(db, 'app:shared')).toBe(false)
    expect(enabledOf(db, 'app:bystander')).toBe(true)

    await invoke(handlers, IPC.enableSkill, 'app:shared')
    expect(enabledOf(db, 'app:shared')).toBe(true)
    expect(enabledOf(db, 'user:shared')).toBe(false)
    expect(enabledOf(db, 'app:bystander')).toBe(true)
    expect(getSkillsByDeclaredId(db, 'shared').filter((s) => s.enabled)).toHaveLength(1)
  })

  it('refuses enabling a skill that needs a newer app and changes nothing', async () => {
    const { db } = seededHarness({ user: [{ id: 'too-new', minAppVersion: '99.0.0' }] }, { reconcile: true })
    expect(enabledOf(db, 'user:too-new')).toBe(false)
    await expect(invoke(handlers, IPC.enableSkill, 'user:too-new')).rejects.toThrow(/newer version/i)
    expect(enabledOf(db, 'user:too-new')).toBe(false)
    expect(listAuditEvents(db, { limit: 5000 }).map((e) => e.type)).not.toContain('skill_enabled')
  })
})

// #583: the IPC parts of the suggestion path (the scoring service is covered elsewhere).
describe('skills IPC — suggestSkills (#583)', () => {
  it('offers the matching enabled skill on a cold session and never an incompatible one', async () => {
    const triggers = { keywords: ['bank statement'] }
    // The registry here has no app version, so BOTH rows are enabled; only the handler's own
    // `appVersion` argument can keep the too-new one out.
    seededHarness({
      app: [
        { id: 'aa-new-only', minAppVersion: '99.0.0', triggers },
        { id: 'zz-compatible', triggers }
      ]
    })
    // No list/reconcile first: the handler's own `ctx.skills.list()` must populate the registry.
    const { result } = await invoke(handlers, IPC.suggestSkills, 'c1', 'please read my bank statement')
    expect(result).toEqual([{ installId: 'app:zz-compatible', title: 'Skill zz-compatible' }])
  })

  it('junk args return nothing; a locked workspace refuses', async () => {
    seededHarness({ app: [{ id: 'bank', triggers: { keywords: ['bank statement'] } }] })
    const { result } = await invoke(handlers, IPC.suggestSkills, 42, {})
    expect(result).toEqual([])
    ipcState.handlers.clear()
    seededHarness({ app: [{ id: 'bank' }] }, { unlocked: false })
    await expect(invoke(handlers, IPC.suggestSkills, 'c1', 'bank statement')).rejects.toThrow(/locked/i)
  })
})

// #583: the round trip above only proves the skill is gone; the status refresh after a delete is the
// handler's explicit `reconcile()`.
describe('skills IPC — deleteSkill refreshes the reconcile status (#583)', () => {
  it('the reconcile status refreshes after a delete', async () => {
    const { userSkillsDir } = makeHarness()
    const zip = await writeZip([{ name: 'SKILL.md', content: skillMd('to-delete', 'Delete me.') }])
    const { result: imp } = await invoke(handlers, IPC.importSkill, await pickToken(zip))
    const { installId } = imp as SkillInfo
    const { result: before } = await invoke(handlers, IPC.skillReconcileStatus)
    expect((before as { errorCount: number }).errorCount).toBe(0)

    // Break a drop-in AFTER the session reconciled: only the delete handler's reconcile sees it.
    mkdirSync(join(userSkillsDir, 'broken-later'), { recursive: true })
    writeFileSync(join(userSkillsDir, 'broken-later', 'SKILL.md'), 'not even frontmatter')
    await invoke(handlers, IPC.deleteSkill, installId)
    const { result: after } = await invoke(handlers, IPC.skillReconcileStatus)
    expect(after).toEqual({ errorCount: 1, errorCodes: ['invalidManifest'] })
  })

  it('deleting an unknown id resolves without error and records no audit event', async () => {
    const { db } = makeHarness()
    await invoke(handlers, IPC.deleteSkill, 'user:never-installed') // a throw fails the test
    expect(listAuditEvents(db, { limit: 5000 }).map((e) => e.type)).not.toContain('skill_deleted')
  })
})
