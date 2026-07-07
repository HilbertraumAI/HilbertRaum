import type { CountMessageKey, MessageKey } from './i18n'

// The self-describing Tier-2 tool descriptor table (skills audit §6.2, Phase A2). ONE pure-data
// record per WIRED tool is the single source of truth every other layer derives from — instead of
// the same tool name being repeated across ~9 hardcoded sites (the wired-list, the runner switch,
// the renderer label/done maps, the per-export save-dialog metadata, …). Adding a 9th tool means
// adding ONE descriptor here.
//
// This module is PURE DATA importable from BOTH processes (like `shared/types.ts` / `shared/i18n`):
// it holds i18n KEYS (never resolved strings) and enum tokens, so the RENDERER can build its
// label/done copy maps from the same table the MAIN registry/dispatch use, with no `run` closures,
// no `node:*`, and no bank/invoice specifics crossing the boundary. The gate contract itself (the
// `SkillTool` — name/schemas/permissions/run) stays in `shared/types.ts`; this describes the tool's
// WIRING (how it dispatches, what its result means, how the renderer labels it), keyed by name.
//
// The trust model is UNCHANGED by this table: a tool still lives only in the app's static registry
// and a skill can never register or self-grant one. A descriptor is app-authored metadata, not a
// capability — listing a name here grants nothing on its own (`resolveWiredTools` still intersects
// with the app-owned registry, and `skillCanRunTools` still gates run to `source==='app'`).

/**
 * How a wired tool dispatches to its persistence seam (`tool-runs.ts` `buildToolRunner`):
 *   - `extract`    — reads the document and (re-)extracts its structured rows (`replaceExisting`).
 *   - `downstream` — operates on the already-extracted rows (validate/categorize/summarize).
 *   - `export`     — serializes the extracted data to a user-chosen file (confirm-gated).
 * The renderer never needs this; the dispatch uses it to keep the wired set derived, not hardcoded.
 */
export type SkillToolSeamKind = 'extract' | 'downstream' | 'export'

/**
 * The shape of a run's terminal outcome, which the renderer maps to copy:
 *   - `count`     — a plain pluralized count ("Extracted N transactions." / "Saved N rows.").
 *   - `reconcile` — a pass/fail balance verdict keyed off `resultKind` (reconciled/unchecked/…).
 *   - `redaction` — "clean" (nothing found, copy saved) vs "redacted" (N items hidden).
 *   - `edit` — "none" (no matching text found) vs "edited"/"editedPartial" (N changes applied; the
 *     partial variant when some requested text wasn't found — Phase 8, D76).
 */
export type SkillToolResultShape = 'count' | 'reconcile' | 'redaction' | 'edit'

/**
 * Per-export save-dialog metadata (U5 / audit §6.2): the dialog's title, its filter label, and the
 * file extension(s) it offers. Carries i18n KEYS (not resolved strings) — the IPC layer owns `tMain`
 * and resolves them, so this stays content-free + testable. The ONE hardcoded CSV dialog used to
 * serve EVERY export (redaction's "Save redacted copy" got an "Export transactions" title with a
 * `.csv` filter fighting `redacted.txt` on Windows); each export tool now names its own dialog here.
 */
export interface SkillToolSaveDialog {
  titleKey: MessageKey
  filterNameKey: MessageKey
  extensions: string[]
}

/** The reconcile-shape done copy (validate tools): three verdict keys keyed off `resultKind`. */
export interface ReconcileDoneKeys {
  reconciled: MessageKey
  unchecked: MessageKey
  unreconciled: CountMessageKey
}

/** The redaction-shape done copy: nothing-found vs N-items-hidden, each in a normal (LLM-assisted) and
 *  a DEGRADED (rule-based floor only — the model was unavailable) variant (Phase 7, D78 honesty). */
export interface RedactionDoneKeys {
  clean: MessageKey
  redacted: CountMessageKey
  /** DEGRADED variants (no runtime / locate failed): the copy says "rule-based detection only". */
  cleanFloor: MessageKey
  redactedFloor: CountMessageKey
}

/** The edit-shape done copy (Phase 8, D76/D78): no-match vs N-changes-applied, with a partial variant
 *  when some requested text wasn't found and was skipped. Counts only — never the find/replace values. */
export interface EditDoneKeys {
  /** No matching text was found — nothing was changed. */
  none: MessageKey
  /** N changes applied (every requested change was found + spliced). */
  edited: CountMessageKey
  /** N changes applied, but some requested text wasn't found and was skipped (dropped > 0). */
  editedPartial: CountMessageKey
}

/** The self-describing wiring of one Tier-2 tool — the single source the other layers derive from. */
export interface SkillToolDescriptor {
  /** The registry tool name (matches the `SkillTool.name` / SKILL.md `allowedTools` entry). */
  name: string
  /** The renderer's display-label catalog key (OFFER button + busy/needsExtraction interpolation). */
  labelKey: MessageKey
  /** Which dispatch seam the runner uses — keeps the wired set derived, not a parallel hardcoded list. */
  seamKind: SkillToolSeamKind
  /** True ⇒ a write/export/destructive tool the renderer confirm-gates. MUST agree with the tool's
   *  `permissions` (`toolRequiresConfirmation`) — a registry test pins the two together. */
  confirm: boolean
  /** How the renderer maps the terminal outcome to copy (drives which done branch fires). */
  resultShape: SkillToolResultShape
  /** The count-pluralized "done" base key for a `count`-shaped result. Undefined ⇒ the legacy
   *  `chat.skill.run.done` base ("Extracted N transactions."). Unused by non-count shapes. */
  doneKey?: CountMessageKey
  /** The verdict keys for a `reconcile`-shaped result (validate tools). */
  reconcileKeys?: ReconcileDoneKeys
  /** The verdict keys for a `redaction`-shaped result. */
  redactionKeys?: RedactionDoneKeys
  /** The done keys for an `edit`-shaped result (Phase 8). */
  editKeys?: EditDoneKeys
  /** The save-dialog metadata for an `export`-shape tool (title/filter/extensions). */
  dialog?: SkillToolSaveDialog
}

// The four save dialogs, named once here (were four `SAVE_DIALOG_*` consts in `tool-runs.ts`).
const DIALOG_CSV: SkillToolSaveDialog = {
  titleKey: 'main.dialog.exportCsv',
  filterNameKey: 'main.dialog.filterCsv',
  extensions: ['csv']
}
const DIALOG_JSON: SkillToolSaveDialog = {
  titleKey: 'main.dialog.exportJson',
  filterNameKey: 'main.dialog.filterJson',
  extensions: ['json']
}
const DIALOG_XML: SkillToolSaveDialog = {
  titleKey: 'main.dialog.exportXml',
  filterNameKey: 'main.dialog.filterXml',
  extensions: ['xml']
}
const DIALOG_REDACTED: SkillToolSaveDialog = {
  titleKey: 'main.dialog.exportRedacted',
  filterNameKey: 'main.dialog.filterText',
  extensions: ['txt']
}
// Phase 8: the edited-copy save dialog — .txt this phase (same-format DOCX export is Phase 9). Its own
// title/filter (not the CSV/redacted dialog) so the saved `edited.txt` filename isn't fought on Windows.
const DIALOG_EDITED: SkillToolSaveDialog = {
  titleKey: 'main.dialog.exportEdited',
  filterNameKey: 'main.dialog.filterText',
  extensions: ['txt']
}

/**
 * The canonical, ordered descriptor table for every WIRED Tier-2 tool. The order IS the wired-list
 * order (`WIRED_TOOL_NAMES`) and the run-bar OFFER order. The registry's test-only canary
 * `count_selected_documents` (X-2) is deliberately ABSENT — it is registered but exposes no live
 * capability (no run seam, no run-bar surface), so it has no wiring to describe.
 */
export const SKILL_TOOL_DESCRIPTORS: readonly SkillToolDescriptor[] = [
  {
    name: 'extract_transactions',
    labelKey: 'chat.skill.tool.extractTransactions',
    seamKind: 'extract',
    confirm: false,
    resultShape: 'count' // doneKey omitted ⇒ the legacy "Extracted N transactions." base
  },
  {
    name: 'validate_statement_balances',
    labelKey: 'chat.skill.tool.validateBalances',
    seamKind: 'downstream',
    confirm: false,
    resultShape: 'reconcile',
    reconcileKeys: {
      reconciled: 'chat.skill.run.done.reconciled',
      unchecked: 'chat.skill.run.done.unchecked',
      unreconciled: 'chat.skill.run.done.unreconciled'
    }
  },
  {
    name: 'categorize_transactions',
    labelKey: 'chat.skill.tool.categorize',
    seamKind: 'downstream',
    confirm: false,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.categorize'
  },
  {
    name: 'summarize_cashflow',
    labelKey: 'chat.skill.tool.summarize',
    seamKind: 'downstream',
    confirm: false,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.summarize'
  },
  {
    name: 'export_transactions_csv',
    labelKey: 'chat.skill.tool.exportCsv',
    seamKind: 'export',
    confirm: true,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.export',
    dialog: DIALOG_CSV
  },
  {
    name: 'extract_invoice',
    labelKey: 'chat.skill.tool.extractInvoice',
    seamKind: 'extract',
    confirm: false,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.extractInvoice'
  },
  {
    name: 'validate_invoice_totals',
    labelKey: 'chat.skill.tool.validateInvoiceTotals',
    seamKind: 'downstream',
    confirm: false,
    resultShape: 'reconcile',
    reconcileKeys: {
      reconciled: 'chat.skill.run.done.invoiceReconciled',
      unchecked: 'chat.skill.run.done.invoiceUnchecked',
      unreconciled: 'chat.skill.run.done.invoiceUnreconciled'
    }
  },
  {
    name: 'export_invoice_csv',
    labelKey: 'chat.skill.tool.exportInvoiceCsv',
    seamKind: 'export',
    confirm: true,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.export',
    dialog: DIALOG_CSV
  },
  {
    name: 'export_invoice_json',
    labelKey: 'chat.skill.tool.exportInvoiceJson',
    seamKind: 'export',
    confirm: true,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.export',
    dialog: DIALOG_JSON
  },
  {
    name: 'export_invoice_xml',
    labelKey: 'chat.skill.tool.exportInvoiceXml',
    seamKind: 'export',
    confirm: true,
    resultShape: 'count',
    doneKey: 'chat.skill.run.done.export',
    dialog: DIALOG_XML
  },
  {
    name: 'redact_document',
    labelKey: 'chat.skill.tool.redactDocument',
    seamKind: 'export',
    confirm: true,
    resultShape: 'redaction',
    redactionKeys: {
      clean: 'chat.skill.run.done.redactedClean',
      redacted: 'chat.skill.run.done.redacted',
      cleanFloor: 'chat.skill.run.done.redactedCleanFloor',
      redactedFloor: 'chat.skill.run.done.redactedFloor'
    },
    dialog: DIALOG_REDACTED
  },
  {
    name: 'apply_document_edits',
    labelKey: 'chat.skill.tool.applyDocumentEdits',
    seamKind: 'export',
    confirm: true,
    resultShape: 'edit',
    editKeys: {
      none: 'chat.skill.run.done.editedNone',
      edited: 'chat.skill.run.done.edited',
      editedPartial: 'chat.skill.run.done.editedPartial'
    },
    dialog: DIALOG_EDITED
  }
]

const DESCRIPTOR_BY_NAME: ReadonlyMap<string, SkillToolDescriptor> = new Map(
  SKILL_TOOL_DESCRIPTORS.map((d) => [d.name, d])
)

/** The wired tool names, in dispatch/offer order — derived from the descriptor table (audit §6.2). */
export const WIRED_TOOL_NAMES: readonly string[] = SKILL_TOOL_DESCRIPTORS.map((d) => d.name)

/** Look up a wired tool's descriptor by name (own-table only). Undefined for the canary / unknowns. */
export function getToolDescriptor(name: string): SkillToolDescriptor | undefined {
  return DESCRIPTOR_BY_NAME.get(name)
}

/** True when a tool name is wired (has a descriptor + a run seam) — the canary is not. */
export function isWiredToolName(name: string): boolean {
  return DESCRIPTOR_BY_NAME.has(name)
}
