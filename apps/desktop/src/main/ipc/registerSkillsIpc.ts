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
import { buildDocumentSegmentReader, buildOriginalDocumentReader } from './documentSegments'
import { bomFor } from './save-export'
import { getLatestUserMessage } from '../services/chat'
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
  toolRunNeedsConfirmation,
  SAVE_DIALOG_CSV,
  type SaveFileDialogMeta
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

  // The app-orchestrated tool-run lifecycle controller (skills plan §12.2, S11b). Held in this closure
  // — no AppContext plumbing needed. Keys runs PER DOCUMENT (A2), so unrelated documents/conversations
  // run in parallel; `listSkillRuns` projects them for a reloaded renderer to re-adopt (U6). Generic:
  // it knows nothing about banks; the `tool-runs.ts` dispatch supplies the bank seam as an opaque runner.
  const runController = new SkillRunController()
  const runAudit = toSkillToolAudit(ctx.audit)
  // GAP-5 (full-audit 2026-07-11): expose the per-document "run in flight?" probe on the context so
  // the docs IPC delete/re-index guards can refuse under a live skill run (the requireNoActiveTask
  // mirror) — the controller itself stays module-local (no lifecycle leaks; a bool is all they need).
  ctx.skillRunActive = (documentId) => runController.isRunning(documentId)

  // The MAIN-side CSV write for `export_transactions_csv` (skills plan §9.5, S11c — the first
  // FS-write from a skill tool). The tool only PRODUCES the CSV; this saves it to a user-chosen path
  // via a save dialog (the exportSkill/exportConversation precedent). Returns whether the user saved;
  // the path + CSV content are NEVER logged or audited (only "saved N rows" surfaces — §22-M1).
  // U5 (audit §6.2): the per-export `dialog` metadata (title/filter/extension) is supplied by the
  // tool-runs dispatch, which knows the tool→format mapping; it defaults to CSV for callers that pass
  // none (bank + invoice CSV). The i18n KEYS are resolved here (this closure owns `tMain`), so the
  // dispatch stays content-free. This kills the one-CSV-dialog-for-every-export drift (a redaction copy
  // no longer gets an "Export transactions" title + a `.csv` filter fighting `redacted.txt`).
  const saveTextFile = async (
    defaultFileName: string,
    content: string,
    dialogMeta: SaveFileDialogMeta = SAVE_DIALOG_CSV
  ): Promise<boolean> => {
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: tMain(dialogMeta.titleKey),
      defaultPath: defaultFileName,
      filters: [{ name: tMain(dialogMeta.filterNameKey), extensions: dialogMeta.extensions }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    // Prefix by the CHOSEN path's extension (audit 2026-07-16 F-10, owner decision D-A 2026-07-17):
    // `.csv` gets the UTF-8 BOM so Excel — the primary consumer of the transactions/invoice CSVs —
    // detects the encoding on double-click (no more garbled umlauts); `.txt` (redacted.txt/edited.txt)
    // now gets the BOM the P4 posture always mandated for plain text. JSON/XML stay BOM-free (bomFor).
    await writeFile(result.filePath, bomFor(result.filePath) + content, 'utf8')
    return true
  }

  // Phase 9 (D77): the MAIN-side BINARY write for the same-format DOCX export — the `.docx` sibling of
  // `saveTextFile` (a `.docx` source → a `.docx` copy). Identical save-dialog + privacy posture (the path +
  // bytes are NEVER logged/audited); the only difference is `writeFile` gets a Buffer with no `'utf8'`.
  const saveBinaryFile = async (
    defaultFileName: string,
    content: Uint8Array,
    dialogMeta: SaveFileDialogMeta = SAVE_DIALOG_CSV
  ): Promise<boolean> => {
    const win = BrowserWindow.getFocusedWindow()
    const options = {
      title: tMain(dialogMeta.titleKey),
      defaultPath: defaultFileName,
      filters: [{ name: tMain(dialogMeta.filterNameKey), extensions: dialogMeta.extensions }]
    }
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    if (result.canceled || !result.filePath) return false
    await writeFile(result.filePath, content)
    return true
  }

  // Phase 9 (D77): probe a document's stored SOURCE format + read its original bytes for the DOCX writer.
  // The seam holds the FS/cipher reach via this injected closure (the §14 ceiling); the tool never does.
  const readOriginalDocument = buildOriginalDocumentReader(ctx)

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
      // SKA-32 (review hardening): the installer reconciles through the MODULE function, which the
      // registry handle's `reconcileStatus()` summary never sees — without this, a user who FIXES a
      // broken drop-in by importing a corrected zip keeps a phantom "folder could not be read"
      // notice until restart (and a newly-broken tree keeps a phantom all-clear). Refresh via the
      // handle so the Settings notice tracks the tree the import just changed.
      ctx.skills!.reconcile()
      return info
    } catch (e) {
      // Re-throw the structural (content-free) message; never leak a raw stack/path.
      if (e instanceof SkillImportError) throw new Error(e.message)
      log.warn('Skill import failed', { reason: 'unexpected' })
      // SKA-33 (review hardening): an UNEXPECTED throw (ENOSPC, an antivirus rename-lock, a DB
      // write failure) is NOT a manifest problem — rethrowing `invalidManifest` here used to be
      // harmless because the renderer collapsed every import failure to the generic toast, but the
      // SKA-33 mapping would now surface it as confident WRONG copy ("The skill manifest is
      // invalid.") for a perfectly valid package. A fixed, content-free, UNMAPPED message keeps the
      // renderer on the generic "couldn't be added" toast for this path.
      throw new Error('The skill could not be added.')
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
    // SKA-32: keep the reconcile-status summary in step with the tree this delete just changed
    // (e.g. the deleted folder was the one that could not be read).
    ctx.skills!.reconcile()
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

  // SKA-32 (audit 2026-07-03, U7): the structural summary of the last reconcile's discovery errors —
  // previously computed and dropped by every consumer, so a power user's drop-in with one YAML typo
  // simply never appeared (no toast, no log, no badge). COUNTS + fixed reason codes only, NEVER a
  // folder name or package content (§22-M1; an invalid folder name is arbitrary user text). The
  // `list()` call first ensures the lazy post-unlock reconcile has actually run this session.
  ipcMain.handle(IPC.skillReconcileStatus, () => {
    requireUnlocked()
    ctx.skills!.list()
    return ctx.skills!.reconcileStatus()
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
    // U-1: a renderer-supplied target id is UNTRUSTED — accepted ONLY when it is in the freshly resolved
    // in-scope set, never trusting a renderer id past the scope filter. When it is NOT in scope — a target
    // left over from a conversation switch (the run bar briefly held the prior chat's document), or a
    // document removed / re-indexing since the bar resolved it — do NOT hard-fail the run when the choice
    // is UNAMBIGUOUS: with exactly one in-scope document, run against it. The out-of-scope id itself is
    // NEVER run (the untrusted-id posture is unchanged — a forged/stale id can only ever fall back to a
    // known in-scope document, so a run can't read outside the chat's scope). With MORE than one in-scope
    // document the pick is genuinely ambiguous, so the user is asked to re-choose.
    const requestedId = typeof req?.documentId === 'string' ? req.documentId : ''
    const requestedInScope = requestedId !== '' && docIds.includes(requestedId)
    // SKA-29 (skills audit 2026-07-03, U6 — the main-side half of SKA-6's wrong-doc chain): the
    // single-doc fallback below is a READ-ONLY convenience (a stale/first-in-scope id conveniently
    // resolves to the one document). For a CONFIRM-GATED write/export tool it is unsafe: a confirmation
    // the user gave for document X must NEVER execute against document Y, so an out-of-scope requested
    // id HARD-REFUSES even when exactly one document is in scope. Read-only tools keep the documented,
    // tested single-doc fallback (its stale-id convenience is the U-1 behaviour).
    const confirmGated = toolRunNeedsConfirmation(toolName)
    if (requestedId !== '' && !requestedInScope && (docIds.length > 1 || confirmGated)) {
      return { started: false, error: tMain('main.skills.run.documentOutOfScope') }
    }
    const targetId = requestedInScope ? requestedId : docIds[0]
    // Phase 8 (D76): the targeted-edit instruction is the conversation's latest user message, resolved
    // MAIN-side (content — used, never logged; the §6/scope posture). Only the edit tool reads it.
    const instruction =
      toolName === 'apply_document_edits' ? getLatestUserMessage(ctx.db, conversationId) ?? undefined : undefined
    const runner = buildToolRunner(
      ctx.db,
      toolName,
      { skillInstallId, conversationId, documentId: targetId, confirmed: req?.confirmed, instruction },
      runAudit,
      // `docTasks` routes `categorize_transactions` into the doctask lane (D26 exclusion, Phase 33).
      // `runtime` (Phase 7/8, D73/D76) is the active chat model for the redaction / document-edit LLM
      // locate pass — null when none runs (redaction degrades to its floor; the edit tool refuses cleanly).
      // `saveBinaryFile` + `readOriginalDocument` (Phase 9, D77) drive the same-format DOCX export.
      {
        saveTextFile,
        saveBinaryFile,
        readOriginalDocument,
        readDocumentSegments,
        docTasks: ctx.docTasks,
        runtime: ctx.runtime?.active() ?? null
      }
    )
    if (!runner) return { started: false, error: tMain('main.skills.run.unavailable') }
    try {
      // API-3 (backend-audit 2026-06-27): `documentCount` is the v1 constant 1 because every wired
      // tool is single-document (`buildToolRunner` targets exactly `targetId`). TODO: when a
      // multi-document tool lands, set this to the real target count (e.g. the resolved scope size)
      // so the run state + audit don't understate scope — it must become a count, not a constant.
      // `documentId` is the controller's per-document concurrency key (audit §6.2): "a skill is
      // already working" now fires only for a run already in flight on this same document.
      // `conversationId` (SKA-6/SKA-17, U6) rides onto the content-free run state so the renderer can
      // gate the bar to the launching conversation and re-adopt it after a reload.
      const run = runController.start({
        skillInstallId,
        toolName,
        documentId: targetId,
        documentCount: 1,
        conversationId,
        runner
      })
      return { started: true, run }
    } catch {
      // One-at-a-time: a run is already in flight ON THIS DOCUMENT. Surface its handle (SKA-17) so a
      // renderer whose own store was reset (a reload) can RE-ADOPT the orphaned run — the fallback
      // re-attach path — instead of being stuck with "cancel it first" and nothing to cancel.
      const running = runController.getByDocument(targetId)
      return { started: false, error: tMain('main.skills.run.busy'), runningHandle: running?.runHandle }
    }
  })

  ipcMain.handle(IPC.getSkillRun, (_e, runHandle: string): SkillRunState | null => {
    requireUnlocked()
    return runController.get(typeof runHandle === 'string' ? runHandle : '')
  })

  // All runs main currently holds (running + terminal-unacknowledged), ids/counts only — a freshly
  // reloaded renderer re-adopts them so an in-flight run keeps its bar and a finished run's outcome is
  // still shown/acknowledgeable (SKA-17; the `listActiveStreamConversations` precedent for skill runs).
  ipcMain.handle(IPC.listSkillRuns, (): SkillRunState[] => {
    requireUnlocked()
    return runController.list()
  })

  // Cancel a run by handle. SKA-25: a NON-EMPTY handle is REQUIRED at the IPC boundary — the no-arg
  // cancel-all (a pre-A2 relic that aborted every in-flight run across all documents/windows) is now
  // internal/test-only. An empty/absent handle is refused (no-op) rather than blasting every run.
  ipcMain.handle(IPC.cancelSkillRun, (_e, runHandle?: string | null): void => {
    requireUnlocked()
    if (typeof runHandle !== 'string' || runHandle.length === 0) return
    runController.cancel(runHandle)
  })

  // Drop a terminal run once the renderer has shown its outcome (the acknowledge handshake — the
  // controller keeps a terminal run readable until this clears it). No-op on a still-running handle.
  // SKA-25: a non-empty handle is required here too (the no-arg clear-all stays internal/test-only).
  ipcMain.handle(IPC.clearSkillRun, (_e, runHandle?: string | null): void => {
    requireUnlocked()
    if (typeof runHandle !== 'string' || runHandle.length === 0) return
    runController.clear(runHandle)
  })
}
