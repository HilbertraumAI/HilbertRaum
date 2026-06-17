import { useState } from 'react'
import type { MessageKey } from '@shared/i18n'
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
  extract_transactions: 'chat.skill.tool.extractTransactions'
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
        ? tCount('chat.skill.run.done', run.transactionCount ?? 0)
        : run.state === 'cancelled'
          ? t('chat.skill.run.cancelled')
          : run.error || t('chat.skill.run.failedGeneric')
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
