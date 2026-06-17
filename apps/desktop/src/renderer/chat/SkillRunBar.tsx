import { useState } from 'react'
import type { CountMessageKey, MessageKey } from '@shared/i18n'
import type { RunnableTool, SkillRunState } from '@shared/types'
import { useT } from '../i18n'
import { Button, ConfirmDialog, Spinner } from '../components'

// The calm Tier-2 tool-run affordance in the chat surface (skills plan §12.2/§15, S11b). Three
// quiet states in one place, all content-free (ids/counts only):
//   1. OFFER — when the active skill has wired tools in scope: a small "Extract transactions" button.
//   2. RUNNING — "Running: <tool> on <N> documents…" + Cancel (the doc-task busy-row precedent).
//   3. RESULT — "Extracted N transactions." / friendly failure / "Stopped." + Dismiss.
// A write/export tool (S11c) is confirm-gated: clicking it raises the ConfirmDialog (the
// model-download / lock-now precedent) before the run starts. Read-only tools run straight away.
//
// Pure + props-driven (the SkillPicker pattern): ChatScreen owns the store wiring; this only renders.

// Tool name → display-label catalog key. A small label map (not logic) keeps copy in the catalogs
// and the rest of the bar generic; an unmapped tool falls back to its raw name.
const TOOL_LABEL_KEY: Record<string, MessageKey> = {
  extract_transactions: 'chat.skill.tool.extractTransactions',
  validate_statement_balances: 'chat.skill.tool.validateBalances',
  categorize_transactions: 'chat.skill.tool.categorize',
  summarize_cashflow: 'chat.skill.tool.summarize',
  export_transactions_csv: 'chat.skill.tool.exportCsv'
}

// Tool name → the count-pluralized "done" message base key (tCount appends .one/.other). Extract has
// no entry — it keeps the legacy `chat.skill.run.done` base. validate_statement_balances is handled
// separately (its outcome is a pass/fail discriminator, not a plain count).
const TOOL_DONE_KEY: Record<string, CountMessageKey> = {
  categorize_transactions: 'chat.skill.run.done.categorize',
  summarize_cashflow: 'chat.skill.run.done.summarize',
  export_transactions_csv: 'chat.skill.run.done.export'
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
  /** Start a tool (confirmed=true once the user accepted the write/export confirm modal). */
  onRun: (toolName: string, confirmed: boolean) => void
  onCancel: () => void
  /** Dismiss a finished (terminal) run's result row. */
  onDismiss: () => void
  /** Suppress the offer while a chat answer is streaming (the run still polls). */
  disabled?: boolean
}

export function SkillRunBar({
  run,
  runnableTools,
  onRun,
  onCancel,
  onDismiss,
  disabled
}: SkillRunBarProps): JSX.Element | null {
  const { t, tCount } = useT()
  const [confirmTool, setConfirmTool] = useState<RunnableTool | null>(null)

  const toolLabel = (name: string): string => {
    const key = TOOL_LABEL_KEY[name]
    return key ? t(key) : name
  }

  // The calm "done" line per tool (content-free — a count and/or a pass/fail discriminator only).
  const doneMessage = (state: SkillRunState): string => {
    const count = state.transactionCount ?? 0
    if (state.toolName === 'validate_statement_balances') {
      if (state.resultKind === 'reconciled') return t('chat.skill.run.done.reconciled')
      if (state.resultKind === 'unchecked') return t('chat.skill.run.done.unchecked')
      return tCount('chat.skill.run.done.unreconciled', count)
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

  const onClickTool = (tool: RunnableTool): void => {
    if (tool.requiresConfirmation) setConfirmTool(tool)
    else onRun(tool.name, false)
  }

  // --- RUNNING ---
  if (run && run.state === 'running') {
    return (
      <div className="skill-run-bar" role="status" aria-live="polite">
        <span className="skill-run-status">
          <Spinner />{' '}
          {tCount('chat.skill.run.running', run.documentCount, { tool: toolLabel(run.toolName) })}
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
    return (
      <div className="skill-run-bar" role="status" aria-live="polite">
        <span className="skill-run-status">{message}</span>
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
          if (confirmTool) onRun(confirmTool.name, true)
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
