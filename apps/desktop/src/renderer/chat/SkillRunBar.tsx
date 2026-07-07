import { useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import type { MessageKey } from '@shared/i18n'
import type { RunnableTool, SkillRunState } from '@shared/types'
import { getToolDescriptor } from '@shared/skill-tools'
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

// The tool's display label, done copy and result-shape all come from the self-describing tool
// registry (`@shared/skill-tools`, audit §6.2) — the renderer no longer keeps parallel label/done
// maps that drift from the wired set. A tool with no descriptor (should not happen for an offered
// tool) falls back to its raw name / the legacy count base.

// Failure reason CODE (content-free, set by the run seam — I1) → localized copy key. An unmapped or
// absent code falls back to the generic failure line, so a German user never sees an English string.
// `needsExtraction` is handled separately in `failureMessage` (it interpolates the `{button}` label),
// so it is intentionally not in this static map.
const RUN_ERROR_KEY: Record<string, MessageKey> = {
  unavailable: 'chat.skill.run.error.unavailable',
  persistFailed: 'chat.skill.run.error.persistFailed',
  exportWriteFailed: 'chat.skill.run.error.exportWriteFailed',
  // Phase 8 (D76) — the document-edit refusals (no floor for edits): no model, no instruction, or a
  // model failure mid-locate. Each maps to a friendly, actionable line.
  needsModel: 'chat.skill.run.error.needsModel',
  needsInstruction: 'chat.skill.run.error.needsInstruction',
  editFailed: 'chat.skill.run.error.editFailed'
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
  /**
   * SKA-6 (audit 2026-07-03, U6): whether the post-extract "Categorize" offer's remembered target
   * document is still in THIS conversation's scope. False ⇒ hide the offer (never retarget across
   * scopes — extract doc X, then categorize must not silently run against doc Y). Defaults to true.
   */
  categorizeTargetInScope?: boolean
  /**
   * SKA-40: the store gave up polling this run after repeated IPC errors — show a labelled "state
   * unknown" row (dismissable) instead of silently dropping a live run. Defaults to false.
   */
  stateUnknown?: boolean
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
  categorizeTargetInScope = true,
  stateUnknown = false,
  onRun,
  onCancel,
  onDismiss,
  disabled,
  offerRoutedFollowups = true
}: SkillRunBarProps): JSX.Element {
  const { t, tCount } = useT()
  const [confirmTool, setConfirmTool] = useState<RunnableTool | null>(null)
  // The user's chosen target. Defaults to (and clamps back to) the first in-scope document, so a
  // scope change never leaves a stale selection pointing outside the offered set.
  const targets = targetDocuments ?? []
  const [chosenId, setChosenId] = useState<string | null>(null)
  const selectedId = targets.find((d) => d.id === chosenId)?.id ?? targets[0]?.id ?? ''

  const toolLabel = (name: string): string => {
    const key = getToolDescriptor(name)?.labelKey
    return key ? t(key) : name
  }

  // The busy/result "what document" line. Prefers the renderer-resolved target NAME (U-1); falls back
  // to the legacy count label when the name is unknown (e.g. after a screen remount lost it). This is
  // the ANNOUNCED text; SKA-39's `done/total` progress rides a SEPARATE aria-hidden span below so a
  // long run doesn't fire one polite announcement per tick (the whole line stays announced once).
  const runningLine = (state: SkillRunState): string =>
    runningDocumentName
      ? t('chat.skill.run.runningOn', { tool: toolLabel(state.toolName), document: runningDocumentName })
      : tCount('chat.skill.run.running', state.documentCount, { tool: toolLabel(state.toolName) })

  // The calm "done" line per tool, fully descriptor-driven (audit §6.2 — content-free: a count
  // and/or a pass/fail discriminator only). The descriptor's `resultShape` picks the branch and
  // carries the exact copy keys, so the renderer holds no per-tool copy map. `count ?? transactionCount`
  // reads the generic count with the deprecated alias as a fallback for one release.
  const doneMessage = (state: SkillRunState): string => {
    const count = state.count ?? state.transactionCount ?? 0
    const d = getToolDescriptor(state.toolName)
    if (d?.resultShape === 'reconcile' && d.reconcileKeys) {
      if (state.resultKind === 'reconciled') return t(d.reconcileKeys.reconciled)
      if (state.resultKind === 'unchecked') return t(d.reconcileKeys.unchecked)
      return tCount(d.reconcileKeys.unreconciled, count)
    }
    if (d?.resultShape === 'redaction' && d.redactionKeys) {
      // 'clean' = nothing detected (a copy was still saved); 'redacted' = N items hidden. The *Floor
      // variants (Phase 7, D78) are the DEGRADED run — the model was unavailable, so only rule-based
      // detection ran; the copy says so honestly.
      if (state.resultKind === 'clean') return t(d.redactionKeys.clean)
      if (state.resultKind === 'cleanFloor') return t(d.redactionKeys.cleanFloor)
      if (state.resultKind === 'redactedFloor') return tCount(d.redactionKeys.redactedFloor, count)
      return tCount(d.redactionKeys.redacted, count)
    }
    if (d?.resultShape === 'edit' && d.editKeys) {
      // 'none' = nothing matched verbatim (no file written); 'editedPartial' = N applied but some
      // requested text wasn't found and was skipped; 'edited' = N applied, all found (Phase 8, D76/D78).
      if (state.resultKind === 'none') return t(d.editKeys.none)
      if (state.resultKind === 'editedPartial') return tCount(d.editKeys.editedPartial, count)
      return tCount(d.editKeys.edited, count)
    }
    return tCount(d?.doneKey ?? 'chat.skill.run.done', count)
  }

  // The localized failure line — mapped from the content-free reason code (I1), never the raw
  // English `run.error` (which stays for the local log only). `needsExtraction` names the ACTUAL
  // extract button the user must click first (U5 / ux-15) — the `{button}` interpolation mirrors the
  // redaction routing copy — resolved to the failing tool's own domain (invoice vs bank).
  const failureMessage = (state: SkillRunState): string => {
    if (state.errorCode === 'needsExtraction') {
      const extractTool = state.toolName.includes('invoice') ? 'extract_invoice' : 'extract_transactions'
      return t('chat.skill.run.error.needsExtraction', { button: toolLabel(extractTool) })
    }
    const key = state.errorCode ? RUN_ERROR_KEY[state.errorCode] : undefined
    return t(key ?? 'chat.skill.run.failedGeneric')
  }

  const runTool = (tool: RunnableTool): void => onRun(tool.name, false, selectedId || undefined)

  const onClickTool = (tool: RunnableTool): void => {
    if (tool.requiresConfirmation) setConfirmTool(tool)
    else runTool(tool)
  }

  // The RUN row (running / result / state-unknown) renders INSIDE the always-mounted live region below
  // (SKA-41), so its text is both visible AND announced from ONE element (no hidden duplicate). The
  // OFFER renders OUTSIDE the region — a passive affordance, not a status change to announce.
  let runRow: JSX.Element | null = null
  let offerRow: JSX.Element | null = null

  if (run && stateUnknown) {
    // SKA-40: the store gave up polling after repeated IPC errors — keep a labelled, dismissable row
    // rather than silently dropping a live run (today one transient error orphaned it).
    runRow = (
      <div className="skill-run-bar">
        <span className="skill-run-status">{t('chat.skill.run.stateUnknown')}</span>
        <Button size="sm" onClick={onDismiss}>
          {t('chat.skill.run.dismiss')}
        </Button>
      </div>
    )
  } else if (run && run.state === 'running') {
    // --- RUNNING ---
    runRow = (
      <div className="skill-run-bar">
        <span className="skill-run-status">
          <Spinner /> {runningLine(run)}
          {/* SKA-39: the live `done/total` progress is aria-hidden — visible, but excluded from the
              polite live region's announced content so a 45-step extract doesn't queue 45 spoken
              updates (the run line itself is announced once when it appears). */}
          {run.progress.total > 0 && (
            <span className="skill-run-progress" aria-hidden="true">
              {' '}
              ({run.progress.done}/{run.progress.total})
            </span>
          )}
        </span>
        <Button size="sm" onClick={onCancel}>
          {t('chat.skill.run.cancel')}
        </Button>
      </div>
    )
  } else if (run) {
    // --- RESULT (terminal) ---
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
    // SKA-6: `categorizeTargetInScope` hides the offer when that remembered id is NO LONGER in the
    // current conversation's scope, so a categorize can never retarget across scopes (never trusting
    // main's single-doc fallback).
    const offerCategorize =
      offerRoutedFollowups &&
      categorizeTargetInScope &&
      run.state === 'done' &&
      run.toolName === 'extract_transactions' &&
      (run.count ?? run.transactionCount ?? 0) > 0
    runRow = (
      <div className="skill-run-bar">
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
  } else if (runnableTools.length > 0) {
    // --- OFFER ---
    offerRow = (
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

  // SKA-41: ONE always-mounted aria-live status region (the app's own M-U1 lesson — a live region
  // created per state branch can MISS the first announcement, because AT registers the region and its
  // text in the same tick). The region is always present (ChatScreen mounts the bar unconditionally);
  // the RUN row renders inside it so a state change is announced exactly once, from the same element
  // the user sees. Empty when there is no run.
  return (
    <div className="skill-run-bar-wrap">
      <div className="skill-run-live" role="status" aria-live="polite">
        {runRow}
      </div>
      {offerRow}
    </div>
  )
}
