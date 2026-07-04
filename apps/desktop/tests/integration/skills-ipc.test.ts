import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'

// Skills plan Phase S4 — IPC round-trip (the registerCollectionsIpc test precedent) + the §22-M1
// content-class sentinel grep: a secret string is pushed through a skill's SKILL.md body/title AND
// through a REJECTED malicious import, then we prove it never reaches `runtime_events` NOR a
// preview/import IPC error payload.

const ipcState = vi.hoisted(() => ({
  handlers: new Map<string, unknown>(),
  openDialog: { canceled: true as boolean, filePaths: [] as string[] },
  saveDialog: { canceled: true as boolean, filePath: undefined as string | undefined }
}))
vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: unknown) => ipcState.handlers.set(channel, fn),
    removeHandler: (channel: string) => ipcState.handlers.delete(channel)
  },
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async () => ({ canceled: ipcState.openDialog.canceled, filePaths: ipcState.openDialog.filePaths }),
    showSaveDialog: async () => ({ canceled: ipcState.saveDialog.canceled, filePath: ipcState.saveDialog.filePath })
  },
  app: { getVersion: () => '0.0.0-test' }
}))

import { registerSkillsIpc } from '../../src/main/ipc/registerSkillsIpc'
import { IPC } from '../../src/shared/ipc'
import { openDatabase, type Db } from '../../src/main/services/db'
import { seedSettings } from '../../src/main/services/settings'
import { createAuditRecorder, listAuditEvents } from '../../src/main/services/audit'
import { createSkillRegistry } from '../../src/main/services/skills/registry'
import type { AppContext } from '../../src/main/services/context'
import type { SkillInfo, SkillPreview } from '../../src/shared/types'
import { invoke, type IpcHandlers } from '../helpers/ipc'

const handlers = ipcState.handlers as unknown as IpcHandlers

const SENTINEL = 'XSKILL_SENTINEL_my_secret_account_is_99999'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-skill-ipc-'))
}

function skillMd(id: string, body: string): string {
  return ['---', `id: ${id}`, `title: ${id} skill`, `description: ${body}`, 'version: 1.0.0', '---', body].join('\n')
}

async function writeZip(members: Array<{ name: string; content: string }>): Promise<string> {
  const zip = new JSZip()
  for (const m of members) zip.file(m.name, m.content)
  const buf = await zip.generateAsync({ type: 'nodebuffer' })
  const path = join(tempDir(), 'pkg.skill.zip')
  writeFileSync(path, buf)
  return path
}

interface Harness {
  ctx: AppContext
  db: Db
  appSkillsDir: string
  userSkillsDir: string
}

function makeHarness(): Harness {
  const root = tempDir()
  const appSkillsDir = join(root, 'app-skills')
  const userSkillsDir = join(root, 'user-skills')
  const db = openDatabase(join(root, 'test.sqlite'))
  seedSettings(db)
  const audit = createAuditRecorder(() => db)
  const skills = createSkillRegistry({ getDb: () => db, appSkillsDir, userSkillsDir })
  const ctx = {
    db,
    paths: { workspacePath: root },
    workspace: { isUnlocked: () => true, documentCipher: () => null },
    isDev: false,
    audit,
    skills,
    ocrEngine: undefined
  } as unknown as AppContext
  registerSkillsIpc(ctx)
  return { ctx, db, appSkillsDir, userSkillsDir }
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
  ipcState.saveDialog.canceled = true
  ipcState.saveDialog.filePath = undefined
})

describe('skills IPC — round-trip lifecycle', () => {
  it('preview → import → list → disable/enable → acknowledge → export → delete', async () => {
    const { db, userSkillsDir } = makeHarness()
    const zip = await writeZip([{ name: 'SKILL.md', content: skillMd('round-trip', 'A round trip skill.') }])

    // preview (no write)
    const { result: prevRaw } = await invoke(handlers, IPC.previewSkillPackage, zip)
    const preview = prevRaw as SkillPreview
    expect(preview.ok).toBe(true)
    expect(preview.id).toBe('round-trip')
    expect(preview.permissionSummary).toContain('cannot access the network')
    expect(existsSync(join(userSkillsDir, 'round-trip'))).toBe(false) // nothing persisted

    // import (enabled-with-warning)
    const { result: impRaw } = await invoke(handlers, IPC.importSkill, zip)
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

  it('pickSkillPackage returns the chosen path (or null on cancel)', async () => {
    makeHarness()
    const { result: cancelled } = await invoke(handlers, IPC.pickSkillPackage)
    expect(cancelled).toBeNull()
    ipcState.openDialog.canceled = false
    ipcState.openDialog.filePaths = ['/tmp/chosen.skill.zip']
    const { result: chosen } = await invoke(handlers, IPC.pickSkillPackage, 'file')
    expect(chosen).toBe('/tmp/chosen.skill.zip')
  })

  it('locked workspace → friendly error, no crash', async () => {
    const root = tempDir()
    const db = openDatabase(join(root, 'test.sqlite'))
    seedSettings(db)
    const skills = createSkillRegistry({
      getDb: () => db,
      appSkillsDir: join(root, 'app-skills'),
      userSkillsDir: join(root, 'user-skills')
    })
    const ctx = {
      db,
      paths: { workspacePath: root },
      workspace: { isUnlocked: () => false, documentCipher: () => null },
      isDev: false,
      skills,
      ocrEngine: undefined
    } as unknown as AppContext
    registerSkillsIpc(ctx)
    await expect(invoke(handlers, IPC.listSkills)).rejects.toThrow(/locked/i)
  })
})

describe('skills IPC — content-class sentinel grep (§22-M1)', () => {
  it('never records skill body content in audit, nor echoes attacker content in an import error', async () => {
    const { db } = makeHarness()

    // 1) A VALID skill whose body/title/description all carry the sentinel — import succeeds and
    //    the body really lands on disk, but the audit event must carry id/source/count only.
    const good = await writeZip([{ name: 'SKILL.md', content: skillMd('secret-skill', SENTINEL) }])
    const { result: info } = await invoke(handlers, IPC.importSkill, good)
    expect((info as SkillInfo).id).toBe('secret-skill')

    // 2) A REJECTED malicious import whose MEMBER NAME carries the sentinel — the structural error
    //    must not echo it back through the IPC payload.
    const evil = await writeZip([
      { name: 'SKILL.md', content: skillMd('evil', SENTINEL) },
      { name: `../${SENTINEL}.txt`, content: SENTINEL }
    ])
    let rejected: unknown
    try {
      await invoke(handlers, IPC.importSkill, evil)
    } catch (e) {
      rejected = e
    }
    expect(rejected).toBeInstanceOf(Error)
    expect((rejected as Error).message).not.toContain(SENTINEL)

    // 3) Preview of a malicious package returns structural errors only — no sentinel.
    const { result: prevRaw } = await invoke(handlers, IPC.previewSkillPackage, evil)
    const preview = prevRaw as SkillPreview
    expect(preview.ok).toBe(false)
    expect(JSON.stringify(preview)).not.toContain(SENTINEL)

    // The audit log carried the lifecycle events but NEVER the body/title/member-name sentinel.
    const audit = allAuditText(db)
    expect(audit).toContain('skill_imported')
    expect(audit).not.toContain(SENTINEL)
  })

  // SEC-N1: a member name with an embedded NUL passes the ../-/drive-/depth checks but would reach
  // writeFileSync, whose ERR_INVALID_ARG_VALUE embeds the RAW (sentinel-bearing) path. Preview must
  // honour its "never throws / returns ok:false" contract AND never leak the path (§22-M1).
  it('a NUL-byte member name (SEC-N1) → preview returns ok:false structurally, never throws or leaks the path', async () => {
    const { db } = makeHarness()
    const NUL = String.fromCharCode(0)
    const nul = await writeZip([
      { name: 'SKILL.md', content: skillMd('nul-evil', SENTINEL) },
      { name: `${SENTINEL}${NUL}.txt`, content: SENTINEL }
    ])
    let threw = false
    let preview: SkillPreview | undefined
    try {
      const { result } = await invoke(handlers, IPC.previewSkillPackage, nul)
      preview = result as SkillPreview
    } catch {
      threw = true
    }
    // Contract: preview NEVER throws — it returns a structural failure instead.
    expect(threw).toBe(false)
    expect(preview?.ok).toBe(false)
    // safeRelPath rejected the NUL STRUCTURALLY (the fixed `invalidPath` reason), not via the
    // generic inner-catch fallback (`unreadableZip`).
    expect(preview?.errorCodes).toContain('invalidPath')
    // Neither the attacker sentinel nor the NUL byte appears anywhere in the serialized payload.
    const serialized = JSON.stringify(preview)
    expect(serialized).not.toContain(SENTINEL)
    expect(serialized.includes(NUL)).toBe(false)
    // The DB audit log never recorded the sentinel either.
    expect(allAuditText(db)).not.toContain(SENTINEL)
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

    await invoke(handlers, IPC.listSkills) // triggers the lazy post-unlock reconcile
    const { result } = await invoke(handlers, IPC.skillReconcileStatus)
    const status = result as { errorCount: number; errorCodes: string[] }
    expect(status.errorCount).toBe(2)
    expect([...status.errorCodes].sort()).toEqual(['invalidFolderName', 'invalidManifest'])
    expect(JSON.stringify(status)).not.toContain(SENTINEL)
  })

  it('reports zeros for a clean skills tree', async () => {
    makeHarness()
    await invoke(handlers, IPC.listSkills)
    const { result } = await invoke(handlers, IPC.skillReconcileStatus)
    expect(result).toEqual({ errorCount: 0, errorCodes: [] })
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
    await invoke(handlers, IPC.importSkill, fixed)
    const { result: after } = await invoke(handlers, IPC.skillReconcileStatus)
    expect(after).toEqual({ errorCount: 0, errorCodes: [] })
  })
})
