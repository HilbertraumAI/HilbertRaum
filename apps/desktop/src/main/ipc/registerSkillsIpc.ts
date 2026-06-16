import { BrowserWindow, dialog, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type { SkillInfo, SkillPreview } from '../../shared/types'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { getSkill, getSkillsByDeclaredId, setSkillEnabled } from '../services/skills/registry'
import {
  deleteSkill,
  exportSkill,
  importSkill,
  previewSkillPackage,
  recordToInfo,
  skillInfo,
  SkillImportError,
  SKILL_IMPORT_ERRORS
} from '../services/skills/installer'

// IPC for Skills (instruction packages; skills plan §16). All DB-backed handlers requireUnlocked
// (the collections precedent) and resolve ALL validation MAIN-side — `previewSkillPackage` is the
// single validation truth; the renderer never re-validates.
//
// AUDIT PRIVACY (§22-M1): every skill event records the declared id + source/trust + (for import)
// the file COUNT only — NEVER the package content, the SKILL.md body, or member file names. And no
// rejection ever echoes attacker-supplied content: the installer's structural error strings are
// fixed (SKILL_IMPORT_ERRORS), so a malicious import cannot smuggle its bytes into an IPC error
// payload. Both invariants are covered by the sentinel-grep test.

export function registerSkillsIpc(ctx: AppContext): void {
  const requireUnlocked = (): void => {
    if (!ctx.workspace.isUnlocked()) throw new Error(tMain('main.skills.locked'))
  }

  // Developer mode (the model-leniency precedent): the user toggle OR a dev build. Gates the
  // downgrade override (DS15) only — never a security control (version is unsigned).
  const developerMode = (): boolean => {
    try {
      return getSettings(ctx.db).developerMode || ctx.isDev
    } catch {
      return ctx.isDev
    }
  }

  const installerDeps = () => ({
    appSkillsDir: ctx.skills!.appSkillsDir,
    userSkillsDir: ctx.skills!.userSkillsDir
  })

  ipcMain.handle(IPC.listSkills, (): SkillInfo[] => {
    requireUnlocked()
    // ctx.skills.list() reconciles disk→DB once per session on first read (the ratified
    // post-unlock lazy reconcile); project each row to SkillInfo with its duplicate-id flag.
    const records = ctx.skills!.list()
    // Count declared ids in one pass so duplicateId is O(n), not O(n²).
    const idCounts = new Map<string, number>()
    for (const r of records) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1)
    return records.map((r) => recordToInfo(r, (idCounts.get(r.id) ?? 0) > 1))
  })

  ipcMain.handle(IPC.getSkill, (_e, installId: string): SkillInfo | null => {
    requireUnlocked()
    const record = ctx.skills!.get(installId)
    return record ? skillInfo(ctx.db, record) : null
  })

  // Open the OS picker for a `.skill.zip` file OR a folder containing SKILL.md (the pickDocuments
  // precedent; renderer has no dialog access). Windows can't mix file+dir in one dialog, so the
  // caller chooses a mode. Returns the chosen path or null (cancelled).
  ipcMain.handle(IPC.pickSkillPackage, async (_e, mode?: 'file' | 'folder'): Promise<string | null> => {
    const options =
      mode === 'folder'
        ? { title: tMain('main.dialog.importSkillFolder'), properties: ['openDirectory'] as Array<'openDirectory'> }
        : {
            title: tMain('main.dialog.importSkill'),
            properties: ['openFile'] as Array<'openFile'>,
            filters: [
              { name: tMain('main.dialog.filterSkill'), extensions: ['skill.zip', 'zip'] },
              { name: tMain('main.dialog.filterAll'), extensions: ['*'] }
            ]
          }
    const win = BrowserWindow.getFocusedWindow()
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  // Validate an import source FULLY in a transient dir, WITHOUT writing (OQ-2). Never throws on a
  // bad package — returns `ok: false` with structural reasons so the renderer can show them.
  ipcMain.handle(IPC.previewSkillPackage, (_e, source: string): SkillPreview => {
    requireUnlocked()
    return previewSkillPackage(ctx.db, source, installerDeps(), { developerMode: developerMode() })
  })

  // Validate → unzip/copy into user-skills/<id>/ → install enabled-with-warning (DS7). A failed
  // import persists nothing (the staging dir is deleted). Throws a friendly structural reason.
  ipcMain.handle(IPC.importSkill, (_e, source: string): SkillInfo => {
    requireUnlocked()
    try {
      const { info, fileCount } = importSkill(ctx.db, source, installerDeps(), {
        developerMode: developerMode()
      })
      log.info('Skill imported', { id: info.id, source: info.source, fileCount })
      // Audit privacy: declared id + source + file COUNT only — never names/content.
      ctx.audit?.('skill_imported', 'Skill imported', { id: info.id, source: info.source, fileCount })
      return info
    } catch (e) {
      // Re-throw the structural (content-free) message; never leak a raw stack/path.
      if (e instanceof SkillImportError) throw new Error(e.message)
      log.warn('Skill import failed', { reason: 'unexpected' })
      throw new Error(SKILL_IMPORT_ERRORS.invalidManifest)
    }
  })

  // Export a skill as a `.skill.zip` (package tree only — §9.5). Save dialog runs in MAIN.
  ipcMain.handle(IPC.exportSkill, async (_e, installId: string): Promise<string | null> => {
    requireUnlocked()
    const record = ctx.skills!.get(installId)
    if (!record) throw new Error(SKILL_IMPORT_ERRORS.notFound)
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: tMain('main.dialog.exportSkill'),
      defaultPath: `${record.id}.skill.zip`,
      filters: [{ name: tMain('main.dialog.filterSkill'), extensions: ['skill.zip'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return null
    exportSkill(ctx.db, installId, result.filePath, installerDeps())
    // Export is not a distinct audit event in v1 (skills plan §16 enumerates import/delete/
    // enable/disable); a local log line is enough — the chosen path is user-private.
    log.info('Skill exported', { id: record.id })
    return result.filePath
  })

  ipcMain.handle(IPC.deleteSkill, (_e, installId: string): void => {
    requireUnlocked()
    const record = ctx.skills!.get(installId)
    if (!record) return
    deleteSkill(ctx.db, installId, installerDeps())
    log.info('Skill deleted', { id: record.id, source: record.source })
    ctx.audit?.('skill_deleted', 'Skill deleted', { id: record.id, source: record.source })
  })

  // Enable a skill, enforcing one-active-per-id (DS12): enabling X disables every other installed
  // skill sharing its declared id. Deterministic + server-guaranteed (the S5 UI surfaces it as an
  // "offer to disable the other"). Returns the updated SkillInfo.
  ipcMain.handle(IPC.enableSkill, (_e, installId: string): SkillInfo => {
    requireUnlocked()
    const record = getSkill(ctx.db, installId)
    if (!record) throw new Error(SKILL_IMPORT_ERRORS.notFound)
    setSkillEnabled(ctx.db, installId, true)
    for (const sib of getSkillsByDeclaredId(ctx.db, record.id)) {
      if (sib.installId !== installId && sib.enabled) setSkillEnabled(ctx.db, sib.installId, false)
    }
    ctx.audit?.('skill_enabled', 'Skill enabled', { id: record.id, source: record.source })
    const updated = getSkill(ctx.db, installId)!
    return skillInfo(ctx.db, updated)
  })

  ipcMain.handle(IPC.disableSkill, (_e, installId: string): SkillInfo => {
    requireUnlocked()
    const record = getSkill(ctx.db, installId)
    if (!record) throw new Error(SKILL_IMPORT_ERRORS.notFound)
    setSkillEnabled(ctx.db, installId, false)
    ctx.audit?.('skill_disabled', 'Skill disabled', { id: record.id, source: record.source })
    const updated = getSkill(ctx.db, installId)!
    return skillInfo(ctx.db, updated)
  })

  // Acknowledge a user skill's import warning (DS7) — clears the persistent "review what it can do"
  // state. App skills are pre-acknowledged; this is a no-op for them.
  ipcMain.handle(IPC.acknowledgeSkillWarning, (_e, installId: string): SkillInfo => {
    requireUnlocked()
    const record = getSkill(ctx.db, installId)
    if (!record) throw new Error(SKILL_IMPORT_ERRORS.notFound)
    ctx.db.prepare('UPDATE skills SET warning_ack = 1, updated_at = ? WHERE install_id = ?').run(
      new Date().toISOString(),
      installId
    )
    const updated = getSkill(ctx.db, installId)!
    return skillInfo(ctx.db, updated)
  })
}
