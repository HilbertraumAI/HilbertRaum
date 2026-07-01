import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { writeFile } from 'node:fs/promises'
import { IPC } from '../../shared/ipc'
import type { AppContext } from '../services/context'
import type {
  RunnableToolSet,
  SkillInfo,
  SkillPreview,
  SkillRunState,
  SkillSuggestion,
  StartSkillRunRequest,
  StartSkillRunResult
} from '../../shared/types'
import { buildDocumentSegmentReader } from './documentSegments'
import { getSettings } from '../services/settings'
import { tMain } from '../services/i18n'
import { log } from '../services/logging'
import { skillNeedsNewerApp } from '../../shared/skill-manifest'
import { getSkill, getSkillsByDeclaredId, setSkillEnabled } from '../services/skills/registry'
import { suggestSkillsForTurn } from '../services/skills/suggest'
import { SkillRunController } from '../services/skills/run-controller'
import {
  buildToolRunner,
  resolveInScopeDocumentIds,
  runnableToolNames,
  runnableToolsForSkill,
  skillCanRunTools,
  toSkillToolAudit,
  toolRunNeedsConfirmation
} from '../services/skills/tool-runs'
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

  // The single app-orchestrated tool-run lifecycle (skills plan §12.2, S11b). Held in this closure
  // (at most one run at a time) — no AppContext plumbing needed. Generic: it knows nothing about
  // banks; the `tool-runs.ts` dispatch supplies the bank seam as an opaque runner.
  const runController = new SkillRunController()
  const runAudit = toSkillToolAudit(ctx.audit)

  // The MAIN-side CSV write for `export_transactions_csv` (skills plan §9.5, S11c — the first
  // FS-write from a skill tool). The tool only PRODUCES the CSV; this saves it to a user-chosen path
  // via a save dialog (the exportSkill/exportConversation precedent). Returns whether the user saved;
  // the path + CSV content are NEVER logged or audited (only "saved N rows" surfaces — §22-M1).
  const saveTextFile = async (defaultFileName: string, content: string): Promise<boolean> => {
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: tMain('main.dialog.exportCsv'),
      defaultPath: defaultFileName,
      filters: [{ name: tMain('main.dialog.filterCsv'), extensions: ['csv'] }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content, 'utf8')
    return true
  }

  // The FAITHFUL content reach for the extract/redaction tools — ONE reader shared with the chat
  // analysis IPC (`registerRagIpc`) so the run-bar button and the chat answer can never disagree on
  // whether geometry-aware layout reconstruction was used (the drift that made the "Extract
  // transactions" button report a different transaction count than the chat answer for the same
  // document). See `documentSegments.ts`.
  const readDocumentSegments = buildDocumentSegmentReader(ctx)

  // Developer mode (the model-leniency precedent): the user toggle OR a dev build. Gates the
  // downgrade override (DS15) only — never a security control (version is unsigned).
  const developerMode = (): boolean => {
    try {
      return getSettings(ctx.db).developerMode || ctx.isDev
    } catch {
      return ctx.isDev
    }
  }

  const appVersion = app.getVersion()
  const installerDeps = () => ({
    appSkillsDir: ctx.skills!.appSkillsDir,
    userSkillsDir: ctx.skills!.userSkillsDir,
    appVersion
  })

  ipcMain.handle(IPC.listSkills, (): SkillInfo[] => {
    requireUnlocked()
    // ctx.skills.list() reconciles disk→DB once per session on first read (the ratified
    // post-unlock lazy reconcile); project each row to SkillInfo with its duplicate-id flag.
    const records = ctx.skills!.list()
    // Count declared ids in one pass so duplicateId is O(n), not O(n²).
    const idCounts = new Map<string, number>()
    for (const r of records) idCounts.set(r.id, (idCounts.get(r.id) ?? 0) + 1)
    return records.map((r) => recordToInfo(r, (idCounts.get(r.id) ?? 0) > 1, appVersion))
  })

  ipcMain.handle(IPC.getSkill, (_e, installId: string): SkillInfo | null => {
    requireUnlocked()
    const record = ctx.skills!.get(installId)
    return record ? skillInfo(ctx.db, record, appVersion) : null
  })

  // Deterministic skill suggestion for the composer picker (skills plan §10.2/§16, S8). Scope is
  // resolved MAIN-side from the conversationId (§22-C4); the draft `question` is content and is
  // scored but NEVER logged or audited (reads aren't audited). Returns at most one OFFER — the
  // picker pins it and the user taps to accept; nothing is applied here.
  ipcMain.handle(
    IPC.suggestSkills,
    (_e, conversationId: string, question?: string): SkillSuggestion[] => {
      requireUnlocked()
      // First read also reconciles disk→DB (lazy post-unlock) so a just-enabled skill is a candidate.
      ctx.skills!.list()
      return suggestSkillsForTurn(
        ctx.db,
        typeof conversationId === 'string' ? conversationId : '',
        typeof question === 'string' ? question : '',
        appVersion
      )
    }
  )

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
    // §6.5 gate: a skill needing a newer app stays listed-but-disabled — refuse to enable it (the
    // renderer also disables the toggle off `info.incompatible`; this is the defensive backstop).
    if (skillNeedsNewerApp(record.manifest.compatibility.minAppVersion, appVersion)) {
      throw new Error(tMain('main.skills.incompatible'))
    }
    setSkillEnabled(ctx.db, installId, true)
    for (const sib of getSkillsByDeclaredId(ctx.db, record.id)) {
      if (sib.installId !== installId && sib.enabled) setSkillEnabled(ctx.db, sib.installId, false)
    }
    ctx.audit?.('skill_enabled', 'Skill enabled', { id: record.id, source: record.source })
    const updated = getSkill(ctx.db, installId)!
    return skillInfo(ctx.db, updated, appVersion)
  })

  ipcMain.handle(IPC.disableSkill, (_e, installId: string): SkillInfo => {
    requireUnlocked()
    const record = getSkill(ctx.db, installId)
    if (!record) throw new Error(SKILL_IMPORT_ERRORS.notFound)
    setSkillEnabled(ctx.db, installId, false)
    ctx.audit?.('skill_disabled', 'Skill disabled', { id: record.id, source: record.source })
    const updated = getSkill(ctx.db, installId)!
    return skillInfo(ctx.db, updated, appVersion)
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
    return skillInfo(ctx.db, updated, appVersion)
  })

  // ---- Tier-2 app-orchestrated tool runs (skills plan §6/§12.2/§16, S11b) -------------------------
  // DS4: a run is started by the APP from a USER action, never by the model parsing `tool_calls`.
  // requireUnlocked + LOGS NOTHING content-bearing — the conversation/document scope is content
  // (§22-C4), resolved MAIN-side here; only the run's ids/counts reach the renderer + the audit.

  // The wired, runnable tools for a skill in a conversation's scope, PLUS the in-scope target
  // document ids (U-1) — empty when none apply (no in-scope documents, or the skill reserves no
  // tools). Drives the calm transcript run affordance + its target name/chooser. The ids are
  // content-free (the §6 ids/counts posture); the renderer maps them to NAMES from its own loaded
  // document list, so a title never crosses this boundary.
  ipcMain.handle(
    IPC.listRunnableTools,
    (_e, skillInstallId: string, conversationId: string): RunnableToolSet => {
      requireUnlocked()
      const empty: RunnableToolSet = { tools: [], documentIds: [] }
      if (typeof skillInstallId !== 'string' || skillInstallId.length === 0) return empty
      ctx.skills!.list() // lazy post-unlock reconcile so a just-enabled skill is considered
      const skill = ctx.skills!.get(skillInstallId)
      if (!skill || skill.unavailableAt != null || !skill.enabled) return empty
      // §6.5/M1 gate at the use-site (airtight): an enabled-but-incompatible skill offers no tools.
      if (runnableToolNames(skill, appVersion).length === 0) return empty
      // Only offer when there is at least one indexed document in scope to run against.
      const docIds = resolveInScopeDocumentIds(ctx.db, typeof conversationId === 'string' ? conversationId : '')
      if (docIds.length === 0) return empty
      return { tools: runnableToolsForSkill(skill, appVersion), documentIds: docIds }
    }
  )

  // Start a run. Resolves the document scope MAIN-side, confirm-gates write/export tools, and hands a
  // content-free runner to the controller. Returns ids/counts only (never the extracted rows).
  ipcMain.handle(IPC.startSkillRun, (_e, req: StartSkillRunRequest): StartSkillRunResult => {
    requireUnlocked()
    const skillInstallId = typeof req?.skillInstallId === 'string' ? req.skillInstallId : ''
    const toolName = typeof req?.toolName === 'string' ? req.toolName : ''
    const conversationId = typeof req?.conversationId === 'string' ? req.conversationId : ''
    const skill = skillInstallId ? ctx.skills!.get(skillInstallId) : undefined
    if (!skill || skill.unavailableAt != null || !skill.enabled) {
      return { started: false, error: tMain('main.skills.run.unavailable') }
    }
    // SEC-1 trust gate (defense in depth): refuse a forged IPC call carrying a USER skill's id before
    // anything runs. `runnableToolNames` below already returns [] for a non-app skill (so the next
    // check also refuses), but making the trust decision explicit at the run entry keeps it from being
    // an emergent property of one filter. The refusal reuses the generic, content-free
    // `run.unavailable` string — no skill title/path is interpolated, so nothing content-bearing is
    // surfaced or logged (the §22-M1 ids/counts-only posture; the privacy sentinel-grep stays green).
    if (!skillCanRunTools(skill)) {
      return { started: false, error: tMain('main.skills.run.unavailable') }
    }
    // §6.5/M1 gate at the use-site (airtight): an enabled-but-incompatible skill refuses to run —
    // `runnableToolNames` returns [] for it, so the tool is not in the wired set.
    if (!runnableToolNames(skill, appVersion).includes(toolName)) {
      return { started: false, error: tMain('main.skills.run.unavailable') }
    }
    // Confirm-gate write/export tools (read-only tools run without a per-call prompt — §12.2).
    if (toolRunNeedsConfirmation(toolName) && req?.confirmed !== true) {
      return { started: false, needsConfirmation: true }
    }
    // The v1 tools are single-document (plan §8). Resolve the in-scope set MAIN-side; the run
    // targets the first by default, or the renderer's chosen `documentId` when it is in that set.
    const docIds = resolveInScopeDocumentIds(ctx.db, conversationId)
    if (docIds.length === 0) {
      return { started: false, error: tMain('main.skills.run.noDocument') }
    }
    // U-1: a renderer-supplied target id is UNTRUSTED — accept it ONLY when it is in the freshly
    // resolved in-scope set, never trusting a renderer id past the scope filter. An out-of-scope id
    // is refused (a defensive backstop — the renderer only ever offers ids from `documentIds`).
    const requestedId = typeof req?.documentId === 'string' ? req.documentId : ''
    if (requestedId && !docIds.includes(requestedId)) {
      return { started: false, error: tMain('main.skills.run.documentOutOfScope') }
    }
    const targetId = requestedId || docIds[0]
    const runner = buildToolRunner(
      ctx.db,
      toolName,
      { skillInstallId, conversationId, documentId: targetId, confirmed: req?.confirmed },
      runAudit,
      // `docTasks` routes `categorize_transactions` into the doctask lane (D26 exclusion, Phase 33).
      { saveTextFile, readDocumentSegments, docTasks: ctx.docTasks }
    )
    if (!runner) return { started: false, error: tMain('main.skills.run.unavailable') }
    try {
      // API-3 (backend-audit 2026-06-27): `documentCount` is the v1 constant 1 because every wired
      // tool is single-document (`buildToolRunner` targets exactly `targetId`). TODO: when a
      // multi-document tool lands, set this to the real target count (e.g. the resolved scope size)
      // so the run state + audit don't understate scope — it must become a count, not a constant.
      const run = runController.start({ skillInstallId, toolName, documentCount: 1, runner })
      return { started: true, run }
    } catch {
      // One-at-a-time: a run is already in flight. Friendly, content-free.
      return { started: false, error: tMain('main.skills.run.busy') }
    }
  })

  ipcMain.handle(IPC.getSkillRun, (_e, runHandle: string): SkillRunState | null =>
    runController.get(typeof runHandle === 'string' ? runHandle : '')
  )

  ipcMain.handle(IPC.cancelSkillRun, (_e, runHandle?: string | null): void => {
    runController.cancel(typeof runHandle === 'string' && runHandle.length > 0 ? runHandle : null)
  })

  // Drop a terminal run once the renderer has shown its outcome (the acknowledge handshake — the
  // controller keeps a terminal run readable until this clears it). No-op on a still-running handle.
  ipcMain.handle(IPC.clearSkillRun, (_e, runHandle?: string | null): void => {
    runController.clear(typeof runHandle === 'string' && runHandle.length > 0 ? runHandle : null)
  })
}
