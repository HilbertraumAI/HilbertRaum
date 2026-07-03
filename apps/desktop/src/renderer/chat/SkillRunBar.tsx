import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { CountMessageKey, MessageKey } from '@shared/i18n'
import type { RunnableTool, SkillRunState } from '@shared/types'
import { useT } from '../i18n'
import { Button, ConfirmDialog, Spinner } from '../components'

// The calm Tier-2 tool-run affordance in the chat surface (skills plan §12.2/§15, S11b). Three
// quiet states in one place, all content-free (ids/counts only):
//   1. OFFER — when the active skill has wired tools in scope: a small "Extract transactions" button,
//      preceded by the TARGET document chooser (U-1) when more than one document is in scope.
//   2. RUNNING — "Running: <tool> on <document>…" + Cancel (the doc-task busy-row precedent).
//   3. RESULT — "Extracted N transactions." / friendly failure / "Stopped." + Dismiss. After a
//      successful rows>0 extract it also offers a one-tap "Categorize transactions" follow-up (U-2):
//      the LLM categorize is USER-initiated here, not silently auto-enqueued on extract.
// A write/export tool (S11c) is confirm-gated: clicking it raises the ConfirmDialog (the
// model-download / lock-now precedent) before the run starts. Read-only tools run straight away.
//
// U-1 privacy: the run's target document is identified by ID only across the IPC; the NAME shown
// here is resolved by ChatScreen from its own loaded document list and passed in as a prop, so a
// document title never enters `SkillRunState`/`startSkillRun`. The chosen `documentId` (also an id)
// flows back through `onRun`; main re-validates it against the resolved scope.
//
// Pure + props-driven (the SkillPicker pattern): ChatScreen owns the store wiring; this only renders.

/** A run target the renderer offers: a content-free document id + its renderer-resolved display name. */
export interface SkillRunTarget {
  id: string
  name: string
}

// Tool name → display-label catalog key. A small label map (not logic) keeps copy in the catalogs
// and the rest of the bar generic; an unmapped tool falls back to its raw name.
const TOOL_LABEL_KEY: Record<string, MessageKey> = {
  extract_transactions: 'chat.skill.tool.extractTransactions',
  validate_statement_balances: 'chat.skill.tool.validateBalances',
  categorize_transactions: 'chat.skill.tool.categorize',
  summarize_cashflow: 'chat.skill.tool.summarize',
  export_transactions_csv: 'chat.skill.tool.exportCsv',
  extract_invoice: 'chat.skill.tool.extractInvoice',
  validate_invoice_totals: 'chat.skill.tool.validateInvoiceTotals',
  export_invoice_csv: 'chat.skill.tool.exportInvoiceCsv',
  export_invoice_json: 'chat.skill.tool.exportInvoiceJson',
  export_invoice_xml: 'chat.skill.tool.exportInvoiceXml',
  redact_document: 'chat.skill.tool.redactDocument'
}

// Tool name → the count-pluralized "done" message base key (tCount appends .one/.other). Extract has
// no entry — it keeps the legacy `chat.skill.run.done` base. validate_statement_balances and
// redact_document are handled separately (their outcome carries a discriminator, not a plain count).
const TOOL_DONE_KEY: Record<string, CountMessageKey> = {
  categorize_transactions: 'chat.skill.run.done.categorize',
  summarize_cashflow: 'chat.skill.run.done.summarize',
  export_transactions_csv: 'chat.skill.run.done.export',
  extract_invoice: 'chat.skill.run.done.extractInvoice',
  export_invoice_csv: 'chat.skill.run.done.export',
  export_invoice_json: 'chat.skill.run.done.export',
  export_invoice_xml: 'chat.skill.run.done.export'
}

// Failure reason CODE (content-free, set by the run seam — I1) → localized copy key. An unmapped or
// absent code falls back to the generic failure line, so a German user never sees an English string.
const RUN_ERROR_KEY: Record<string, MessageKey> = {
  unavailable: 'chat.skill.run.error.unavailable',
  needsExtraction: 'chat.skill.run.error.needsExtraction',
  persistFailed: 'chat.skill.run.error.persistFailed',
  exportWriteFailed: 'chat.skill.run.error.exportWriteFailed'
}

export interface SkillRunBarProps {
  /** The active run, or null when none is in flight. */
  run: SkillRunState | null
  /** Wired tools offered for the active skill in scope (empty hides the offer). */
  runnableTools: RunnableTool[]
  /**
   * The in-scope target documents (U-1), in main's resolution order ([0] = default). Exactly one ⇒
   * its name is shown (no choice); more than one ⇒ a chooser. Each carries an id + a renderer-resolved
   * NAME (never an IPC-sourced title). Empty/undefined ⇒ the legacy count label (no name shown).
   */
  targetDocuments?: SkillRunTarget[]
  /** The name of the document the ACTIVE run targets (ChatScreen remembers what it launched), or
   *  null/undefined ⇒ the busy/result row falls back to the legacy "on N documents" count label. */
  runningDocumentName?: string | null
  /** The id of the document the ACTIVE run targets (remembered renderer-side, like the name — the run
   *  state is content-free). Passed back through `onRun` when the user taps the post-extract categorize
   *  offer (U-2), so the categorize runs on the SAME document the extract did. Null ⇒ main defaults to
   *  the first in-scope document. */
  runningDocumentId?: string | null
  /** Start a tool: `confirmed=true` once the user accepted the write/export modal; `documentId` is the
   *  chosen in-scope target (undefined ⇒ main targets the first in-scope document). */
  onRun: (toolName: string, confirmed: boolean, documentId?: string) => void
  onCancel: () => void
  /** Dismiss a finished (terminal) run's result row. */
  onDismiss: () => void
  /** Suppress the offer while a chat answer is streaming (the run still polls). */
  disabled?: boolean
  /**
   * U3 (audit ux-6): whether ROUTED follow-ups (the post-extract "Categorize transactions" offer)
   * may be surfaced. False in plain-chat mode, where the routed answer relay is inert, so the
   * follow-up's real output (the category breakdown routed into the transcript) would be unreachable.
   * Defaults to true (documents mode). The offered routed tools themselves are filtered upstream.
   */
  offerRoutedFollowups?: boolean
}

/**
 * The target-document chooser (U-1) — a quiet Radix dropdown matching the composer-footer menus
 * (DepthMenu/ScopePopover). With a single target it shows the name, disabled (no choice to make);
 * with several it opens a radio list. Names are renderer-resolved; only the chosen ID leaves here.
 */
function TargetMenu({
  targets,
  selectedId,
  onSelect,
  disabled
}: {
  targets: SkillRunTarget[]
  selectedId: string
  onSelect: (id: string) => void
  disabled?: boolean
}): JSX.Element {
  const { t } = useT()
  const selected = targets.find((d) => d.id === selectedId) ?? targets[0]
  const single = targets.length <= 1
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button
          type="button"
          className="footer-menu-btn skill-run-target"
          disabled={disabled || single}
          aria-label={t('chat.skill.run.chooseDocument')}
        >
          <span className="skill-run-target-name">{selected?.name}</span>
          {!single && (
            <>
              {' '}
              <span aria-hidden="true">▾</span>
            </>
          )}
        </button>
      </DropdownMenu.Trigger>
      {!single && (
        <DropdownMenu.Portal>
          <DropdownMenu.Content className="menu" align="start" sideOffset={6}>
            <DropdownMenu.RadioGroup value={selected?.id} onValueChange={onSelect}>
              {targets.map((d) => (
                <DropdownMenu.RadioItem key={d.id} value={d.id} className="menu-item menu-radio">
                  <span className="menu-radio-mark" aria-hidden="true">
                    <DropdownMenu.ItemIndicator>●</DropdownMenu.ItemIndicator>
                  </span>
                  <span>{d.name}</span>
                </DropdownMenu.RadioItem>
              ))}
            </DropdownMenu.RadioGroup>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      )}
    </DropdownMenu.Root>
  )
}

export function SkillRunBar({
  run,
  runnableTools,
  targetDocuments,
  runningDocumentName,
  runningDocumentId,
  onRun,
  onCancel,
  onDismiss,
  disabled,
  offerRoutedFollowups = true
}: SkillRunBarProps): JSX.Element | null {
  const { t, tCount } = useT()
  const [confirmTool, setConfirmTool] = useState<RunnableTool | null>(null)
  // The user's chosen target. Defaults to (and clamps back to) the first in-scope document, so a
  // scope change never leaves a stale selection pointing outside the offered set.
  const targets = targetDocuments ?? []
  const [chosenId, setChosenId] = useState<string | null>(null)
  const selectedId = targets.find((d) => d.id === chosenId)?.id ?? targets[0]?.id ?? ''

  const toolLabel = (name: string): string => {
    const key = TOOL_LABEL_KEY[name]
    return key ? t(key) : name
  }

  // The busy/result "what document" line. Prefers the renderer-resolved target NAME (U-1); falls back
  // to the legacy count label when the name is unknown (e.g. after a screen remount lost it).
  const runningLine = (state: SkillRunState): string =>
    runningDocumentName
      ? t('chat.skill.run.runningOn', { tool: toolLabel(state.toolName), document: runningDocumentName })
      : tCount('chat.skill.run.running', state.documentCount, { tool: toolLabel(state.toolName) })

  // The calm "done" line per tool (content-free — a count and/or a pass/fail discriminator only).
  const doneMessage = (state: SkillRunState): string => {
    const count = state.transactionCount ?? 0
    if (state.toolName === 'validate_statement_balances') {
      if (state.resultKind === 'reconciled') return t('chat.skill.run.done.reconciled')
      if (state.resultKind === 'unchecked') return t('chat.skill.run.done.unchecked')
      return tCount('chat.skill.run.done.unreconciled', count)
    }
    if (state.toolName === 'validate_invoice_totals') {
      if (state.resultKind === 'reconciled') return t('chat.skill.run.done.invoiceReconciled')
      if (state.resultKind === 'unchecked') return t('chat.skill.run.done.invoiceUnchecked')
      return tCount('chat.skill.run.done.invoiceUnreconciled', count)
    }
    if (state.toolName === 'redact_document') {
      // 'clean' = nothing detected (a copy was still saved); 'redacted' = N items hidden.
      if (state.resultKind === 'clean') return t('chat.skill.run.done.redactedClean')
      return tCount('chat.skill.run.done.redacted', count)
    }
    const base = TOOL_DONE_KEY[state.toolName]
    return tCount(base ?? 'chat.skill.run.done', count)
  }

  // The localized failure line — mapped from the content-free reason code (I1), never the raw
  // English `run.error` (which stays for the local log only).
  const failureMessage = (state: SkillRunState): string => {
    const key = state.errorCode ? RUN_ERROR_KEY[state.errorCode] : undefined
    return t(key ?? 'chat.skill.run.failedGeneric')
  }

  const runTool = (tool: RunnableTool): void => onRun(tool.name, false, selectedId || undefined)

  const onClickTool = (tool: RunnableTool): void => {
    if (tool.requiresConfirmation) setConfirmTool(tool)
    else runTool(tool)
  }

  // --- RUNNING ---
  if (run && run.state === 'running') {
    return (
      <div className="skill-run-bar" role="status" aria-live="polite">
        <span className="skill-run-status">
          <Spinner /> {runningLine(run)}
        </span>
        <Button size="sm" onClick={onCancel}>
          {t('chat.skill.run.cancel')}
        </Button>
      </div>
    )
  }

  // --- RESULT (terminal) ---
  if (run) {
    const message =
      run.state === 'done'
        ? doneMessage(run)
        : run.state === 'cancelled'
          ? t('chat.skill.run.cancelled')
          : failureMessage(run)
    // U-2: after a successful extract that produced rows, offer the LLM categorize as a one-tap,
    // USER-initiated action (it is NO LONGER auto-enqueued in the background on extract). Targets the
    // SAME document the extract ran on — its id is remembered renderer-side (the run state is
    // content-free); a lost id (null, e.g. after a remount) falls back to main's first-in-scope default.
    const offerCategorize =
      offerRoutedFollowups &&
      run.state === 'done' &&
      run.toolName === 'extract_transactions' &&
      (run.transactionCount ?? 0) > 0
    return (
      <div className="skill-run-bar" role="status" aria-live="polite">
        <span className="skill-run-status">{message}</span>
        {offerCategorize && (
          <Button
            size="sm"
            disabled={disabled}
            onClick={() => onRun('categorize_transactions', false, runningDocumentId ?? undefined)}
          >
            {t('chat.skill.run.categorizeOffer')}
          </Button>
        )}
        <Button size="sm" onClick={onDismiss}>
          {t('chat.skill.run.dismiss')}
        </Button>
      </div>
    )
  }

  // --- OFFER ---
  if (runnableTools.length === 0) return null
  return (
    <div className="skill-run-bar">
      {targets.length > 0 && (
        <TargetMenu targets={targets} selectedId={selectedId} onSelect={setChosenId} disabled={disabled} />
      )}
      {runnableTools.map((tool) => (
        <Button key={tool.name} size="sm" disabled={disabled} onClick={() => onClickTool(tool)}>
          {toolLabel(tool.name)}
        </Button>
      ))}
      <ConfirmDialog
        open={confirmTool != null}
        title={t('chat.skill.confirm.title')}
        confirmLabel={t('chat.skill.confirm.ok')}
        onConfirm={() => {
          if (confirmTool) onRun(confirmTool.name, true, selectedId || undefined)
          setConfirmTool(null)
        }}
        onCancel={() => setConfirmTool(null)}
        t={t}
      >
        {t('chat.skill.confirm.body')}
      </ConfirmDialog>
    </div>
  )
}
