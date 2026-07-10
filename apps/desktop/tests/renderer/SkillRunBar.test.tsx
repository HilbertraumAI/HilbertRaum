// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillRunBar } from '../../src/renderer/chat'
import { I18nProvider } from '../../src/renderer/i18n'
import type { RunnableTool, SkillRunState } from '../../src/shared/types'

// Skills plan §12.2/§15 (S11b) — the calm tool-run bar: OFFER → RUNNING → RESULT, plus the
// write/export CONFIRM modal. Pure + props-driven (the SkillPicker test precedent).

function withI18n(ui: React.ReactElement): React.ReactElement {
  return <I18nProvider>{ui}</I18nProvider>
}

function run(over: Partial<SkillRunState> = {}): SkillRunState {
  return {
    runHandle: 'h1',
    skillInstallId: 'app:bank-statement',
    toolName: 'extract_transactions',
    documentCount: 1,
    state: 'running',
    progress: { done: 0, total: 0 },
    ...over
  }
}

const readOnly: RunnableTool = { name: 'extract_transactions', requiresConfirmation: false }
const writeTool: RunnableTool = { name: 'synthetic_write', requiresConfirmation: true }

afterEach(cleanup)

describe('SkillRunBar (S11b)', () => {
  it('renders no visible bar with no run and no offered tools (only the always-mounted live region — SKA-41)', () => {
    const { container } = render(
      withI18n(<SkillRunBar run={null} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    // SKA-41: the aria-live status region is ALWAYS mounted (so the first announcement isn't missed),
    // but it is empty and there is no visible bar content.
    expect(container.querySelector('.skill-run-bar')).toBeNull()
    const live = container.querySelector('[role="status"]')
    expect(live).not.toBeNull()
    expect(live).toBeEmptyDOMElement()
  })

  it('OFFER: a read-only tool runs immediately (no confirm modal)', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(<SkillRunBar run={null} runnableTools={[readOnly]} onRun={onRun} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    await user.click(screen.getByRole('button', { name: 'Extract transactions' }))
    expect(onRun).toHaveBeenCalledWith('extract_transactions', false, undefined)
  })

  it('OFFER: a write/export tool raises the confirm modal and runs only on confirm', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(<SkillRunBar run={null} runnableTools={[writeTool]} onRun={onRun} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    await user.click(screen.getByRole('button', { name: 'synthetic_write' }))
    // The modal appears; nothing has run yet.
    expect(screen.getByText('Run this tool?')).toBeInTheDocument()
    expect(onRun).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Run' }))
    expect(onRun).toHaveBeenCalledWith('synthetic_write', true, undefined)
  })

  it('RUNNING: shows the busy row and Cancel fires onCancel', async () => {
    const onCancel = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar run={run()} runnableTools={[]} onRun={vi.fn()} onCancel={onCancel} onDismiss={vi.fn()} />
      )
    )
    expect(screen.getByText(/Running: Extract transactions on 1 document/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalled()
  })

  it('RESULT: a done run shows the count and Dismiss fires onDismiss', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'done', transactionCount: 2 })}
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={onDismiss}
        />
      )
    )
    expect(screen.getByText('Extracted 2 transactions.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  it('RESULT: a failed run shows the LOCALIZED error (mapped from errorCode, not the raw English), a cancelled run says nothing was saved', () => {
    // The renderer localizes from the content-free errorCode (I1) — never the English run.error.
    const { rerender } = render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'failed', errorCode: 'persistFailed', error: 'This statement could not be saved. Nothing was changed.' })}
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText("This couldn’t be saved. Nothing was changed.")).toBeInTheDocument()
    // An unknown/absent code falls back to the localized generic line (never a raw English string).
    rerender(
      withI18n(
        <SkillRunBar run={run({ state: 'failed' })} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />
      )
    )
    expect(screen.getByText("That didn't work. Nothing was changed.")).toBeInTheDocument()
    rerender(
      withI18n(
        <SkillRunBar run={run({ state: 'cancelled' })} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />
      )
    )
    expect(screen.getByText('Stopped. Nothing was saved.')).toBeInTheDocument()
  })

  // U5 (audit ux-15): the needsExtraction failure names the ACTUAL extract button to click first —
  // interpolated per the FAILING tool's domain (bank downstream tool → "Extract transactions";
  // invoice downstream tool → "Extract invoice"), never the old generic "run this tool".
  it('RESULT: needsExtraction names the domain-correct extract button', () => {
    const { rerender } = render(
      withI18n(
        <SkillRunBar
          run={run({ toolName: 'validate_statement_balances', state: 'failed', errorCode: 'needsExtraction' })}
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText(/Read the document first with the “Extract transactions” button/)).toBeInTheDocument()
    rerender(
      withI18n(
        <SkillRunBar
          run={run({ toolName: 'export_invoice_json', state: 'failed', errorCode: 'needsExtraction' })}
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText(/Read the document first with the “Extract invoice” button/)).toBeInTheDocument()
  })

  // S11c — per-tool done copy + validate's pass/fail discriminator (resultKind), content-free.
  it('RESULT: per-tool done messages (categorize / summarize / export)', () => {
    const cases: Array<[SkillRunState['toolName'], number, string]> = [
      ['categorize_transactions', 3, 'Categorized 3 transactions.'],
      ['summarize_cashflow', 3, 'Summarized 3 transactions.'],
      ['export_transactions_csv', 2, 'Saved 2 rows.']
    ]
    for (const [toolName, count, text] of cases) {
      cleanup()
      render(
        withI18n(
          <SkillRunBar
            run={run({ toolName, state: 'done', transactionCount: count })}
            runnableTools={[]}
            onRun={vi.fn()}
            onCancel={vi.fn()}
            onDismiss={vi.fn()}
          />
        )
      )
      expect(screen.getByText(text)).toBeInTheDocument()
    }
  })

  it('RESULT: validate reconcile verdicts key off resultKind', () => {
    const v = (resultKind: string, count = 0): SkillRunState =>
      run({ toolName: 'validate_statement_balances', state: 'done', resultKind, transactionCount: count })
    const { rerender } = render(
      withI18n(<SkillRunBar run={v('reconciled')} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    expect(screen.getByText('Balances reconcile.')).toBeInTheDocument()
    rerender(
      withI18n(<SkillRunBar run={v('unreconciled', 2)} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    expect(screen.getByText(/2 rows don't reconcile/)).toBeInTheDocument()
    rerender(
      withI18n(<SkillRunBar run={v('unchecked')} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    expect(screen.getByText(/No running balance/)).toBeInTheDocument()
  })

  // U-1 — the target-document affordance: a single in-scope doc shows its name; >1 offers a chooser;
  // the chosen id (never a title) rides back through onRun; the busy row names the running target.
  it('OFFER (single in-scope doc): shows the name and passes its id to onRun', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[readOnly]}
          targetDocuments={[{ id: 'd1', name: 'invoice_2024.pdf' }]}
          onRun={onRun}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    // The single target's name is shown (the chooser trigger is disabled — no choice to make).
    expect(screen.getByText('invoice_2024.pdf')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /choose target document/i })).toBeDisabled()
    await user.click(screen.getByRole('button', { name: 'Extract transactions' }))
    expect(onRun).toHaveBeenCalledWith('extract_transactions', false, 'd1')
  })

  it('OFFER (multi-doc): choosing a different document passes THAT id to onRun', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[readOnly]}
          targetDocuments={[
            { id: 'd1', name: 'first.pdf' },
            { id: 'd2', name: 'second.pdf' }
          ]}
          onRun={onRun}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    // Defaults to the first document; clicking the tool without choosing uses it.
    const chooser = screen.getByRole('button', { name: /choose target document/i })
    expect(chooser).toBeEnabled()
    // Open the chooser and pick the second document.
    await user.click(chooser)
    await user.click(await screen.findByRole('menuitemradio', { name: /second\.pdf/i }))
    await user.click(screen.getByRole('button', { name: 'Extract transactions' }))
    expect(onRun).toHaveBeenCalledWith('extract_transactions', false, 'd2')
  })

  it('RUNNING: the busy row names the target document when known', () => {
    render(
      withI18n(
        <SkillRunBar
          run={run()}
          runnableTools={[]}
          runningDocumentName="invoice_2024.pdf"
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText('Running: Extract transactions on invoice_2024.pdf…')).toBeInTheDocument()
  })

  // U-2 — the post-extract categorize is an EXPLICIT one-tap offer on the result row (no longer a
  // hidden background enqueue on extract). It targets the SAME document the extract ran on (its id,
  // remembered renderer-side), and only appears after a successful rows>0 extract.
  it('RESULT (extract done, rows>0): offers a one-tap categorize that targets the same document', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'done', transactionCount: 2 })}
          runnableTools={[]}
          runningDocumentId="d1"
          onRun={onRun}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    // The result line still shows the extract count; the categorize follow-up sits beside Dismiss.
    expect(screen.getByText('Extracted 2 transactions.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Categorize transactions' }))
    // Fires the existing categorize run path with the remembered extract target id (D26 doctask lane).
    expect(onRun).toHaveBeenCalledWith('categorize_transactions', false, 'd1')
  })

  // U3 (audit ux-6): in plain-chat mode the routed answer relay is inert, so the routed post-extract
  // categorize follow-up is hidden (its breakdown answer would be unreachable). The extract result
  // line itself still shows.
  it('RESULT (extract done, rows>0): hides the categorize follow-up when routed runs are unreachable', () => {
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'done', transactionCount: 2 })}
          runnableTools={[]}
          runningDocumentId="d1"
          offerRoutedFollowups={false}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText('Extracted 2 transactions.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Categorize transactions' })).not.toBeInTheDocument()
  })

  it('RESULT (extract done, rows>0, id unknown): the categorize offer falls back to main’s default', async () => {
    const onRun = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'done', transactionCount: 2 })}
          runnableTools={[]}
          onRun={onRun}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: 'Categorize transactions' }))
    // No remembered id (e.g. after a remount) ⇒ undefined ⇒ main targets the first in-scope document.
    expect(onRun).toHaveBeenCalledWith('categorize_transactions', false, undefined)
  })

  // SKA-6 (audit 2026-07-03, U6): the categorize offer must REFUSE (hide) when its remembered target
  // document is no longer in this conversation's scope — never retarget across scopes.
  it('RESULT (extract done, rows>0): hides the categorize offer when its target is out of scope', () => {
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'done', transactionCount: 2 })}
          runnableTools={[]}
          runningDocumentId="d1"
          categorizeTargetInScope={false}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText('Extracted 2 transactions.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Categorize transactions' })).not.toBeInTheDocument()
  })

  // SKA-40: a run the store gave up polling shows a labelled, dismissable "state unknown" row.
  it('STATE UNKNOWN: shows the labelled row and Dismiss fires onDismiss', async () => {
    const onDismiss = vi.fn()
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'running' })}
          stateUnknown
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={onDismiss}
        />
      )
    )
    expect(screen.getByText(/Couldn.t check on this skill/)).toBeInTheDocument()
    // No Cancel — the run's live state is unknown, only Dismiss remains.
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onDismiss).toHaveBeenCalled()
  })

  // SKA-39: the busy row renders the run's done/total when the tool reports real progress (dead before).
  // The progress rides a SEPARATE aria-hidden span (visible, not announced per tick), so the run line
  // and the progress are asserted separately.
  it('RUNNING: shows done/total progress (aria-hidden) when the tool reports it', () => {
    const { container } = render(
      withI18n(
        <SkillRunBar
          run={run({ progress: { done: 12, total: 45 } })}
          runningDocumentName="statement.pdf"
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText(/Running: Extract transactions on statement\.pdf…/)).toBeInTheDocument()
    const progress = container.querySelector('.skill-run-progress')
    expect(progress).toHaveTextContent('(12/45)')
    expect(progress).toHaveAttribute('aria-hidden', 'true') // announced once, not per tick
  })

  it('RESULT: the categorize offer is absent for a 0-row extract, a non-extract done, and a non-done run', () => {
    const noOffer = (over: Partial<SkillRunState>): void => {
      cleanup()
      render(
        withI18n(
          <SkillRunBar run={run(over)} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />
        )
      )
      expect(screen.queryByRole('button', { name: 'Categorize transactions' })).not.toBeInTheDocument()
    }
    noOffer({ state: 'done', transactionCount: 0 }) // an empty extract has nothing to categorize
    noOffer({ state: 'done', toolName: 'categorize_transactions', transactionCount: 3 }) // not after categorize
    noOffer({ state: 'done', toolName: 'extract_invoice', transactionCount: 3 }) // invoices have no categorize
    noOffer({ state: 'failed', errorCode: 'persistFailed' }) // a failed extract offers nothing
    noOffer({ state: 'cancelled' }) // a stopped extract offers nothing
  })

  // #44 — a terminal, un-dismissed run must NOT hide the OFFER: the deterministic edit-routing answer
  // points at the "Apply text edits" button unconditionally, so the button has to exist whenever the
  // tools are runnable. The result row renders above the restored offer until it is dismissed.
  it('OFFER coexists with a terminal RESULT row (#44) — for done, failed and cancelled runs', () => {
    const editTool: RunnableTool = { name: 'apply_document_edits', requiresConfirmation: true }
    const terminal = run({ toolName: 'apply_document_edits', state: 'done', resultKind: 'edited', count: 2 })
    const { rerender } = render(
      withI18n(
        <SkillRunBar run={terminal} runnableTools={[editTool]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />
      )
    )
    // Both surfaces at once: the result line (with Dismiss) AND the offered run button.
    expect(screen.getByText('Applied 2 changes and saved an edited copy. Review it before sharing.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Apply text edits' })).toBeInTheDocument()
    rerender(
      withI18n(
        <SkillRunBar
          run={run({ toolName: 'apply_document_edits', state: 'failed', errorCode: 'editFailed' })}
          runnableTools={[editTool]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Apply text edits' })).toBeInTheDocument()
    rerender(
      withI18n(
        <SkillRunBar
          run={run({ toolName: 'apply_document_edits', state: 'cancelled' })}
          runnableTools={[editTool]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByRole('button', { name: 'Apply text edits' })).toBeInTheDocument()
  })

  it('OFFER stays suppressed while a run is IN FLIGHT (running / state-unknown) — #44 keeps the old guard', () => {
    const { rerender } = render(
      withI18n(
        <SkillRunBar run={run()} runnableTools={[readOnly]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />
      )
    )
    expect(screen.queryByRole('button', { name: 'Extract transactions' })).not.toBeInTheDocument()
    rerender(
      withI18n(
        <SkillRunBar
          run={run()}
          stateUnknown
          runnableTools={[readOnly]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.queryByRole('button', { name: 'Extract transactions' })).not.toBeInTheDocument()
  })

  // #45 — the pre-run confirm for the document-transform tools states the OUTPUT format up front:
  // .docx keeps its Word format; a PDF (or any other source) saves as a plain-text .txt copy. The
  // cliff was previously only discoverable in the save dialog / result file.
  it('CONFIRM (#45): a PDF target warns the copy will be plain text (.txt)', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[{ name: 'apply_document_edits', requiresConfirmation: true }]}
          targetDocuments={[{ id: 'd1', name: 'contract.pdf' }]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: 'Apply text edits' }))
    expect(
      screen.getByText('The saved copy will be plain text (.txt) — the original layout and formatting are not kept.')
    ).toBeInTheDocument()
  })

  it('CONFIRM (#45): a .docx target says the copy keeps its Word format', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[{ name: 'redact_document', requiresConfirmation: true }]}
          targetDocuments={[{ id: 'd1', name: 'Letter.DOCX' }]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: 'Redact personal data' }))
    expect(screen.getByText('The saved copy keeps this document’s Word format (.docx).')).toBeInTheDocument()
  })

  it('CONFIRM (#45): with no known target name it falls back to the full output matrix', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[{ name: 'redact_document', requiresConfirmation: true }]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: 'Redact personal data' }))
    expect(
      screen.getByText('Word documents (.docx) keep their format; PDFs and other formats save as a plain-text (.txt) copy.')
    ).toBeInTheDocument()
  })

  it('CONFIRM (#45/RD-2): an UNRESOLVED target (name null) falls back to the matrix — never asserts ".txt"', async () => {
    // RD-2 (full-audit 2026-07-10): an unresolved target used to reach here as the localized
    // "this document" placeholder — truthy, extension-less — so the confirm asserted a plain-text
    // .txt copy even for a .docx source. The name is now null at the data level; the chooser shows
    // the placeholder at render time, and the format line honestly falls back to the full matrix.
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[{ name: 'redact_document', requiresConfirmation: true }]}
          targetDocuments={[{ id: 'd1', name: null }]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    // The display site still shows the placeholder (no display regression).
    expect(screen.getByText('this document')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Redact personal data' }))
    expect(
      screen.getByText('Word documents (.docx) keep their format; PDFs and other formats save as a plain-text (.txt) copy.')
    ).toBeInTheDocument()
    expect(screen.queryByText('The saved copy will be plain text (.txt) — the original layout and formatting are not kept.')).not.toBeInTheDocument()
  })

  it('CONFIRM (RD-6): a pending confirm does not re-open when the offer disappears and returns', async () => {
    // RD-6 (full-audit 2026-07-10): `confirmTool` is state, so it used to survive the offer row
    // unmounting (tools emptied by a scope change) and silently RE-OPENED the dialog the moment
    // the offer returned. It is now cleared once the tool is no longer offered.
    const user = userEvent.setup()
    const shared = { run: null, onRun: vi.fn(), onCancel: vi.fn(), onDismiss: vi.fn() }
    const { rerender } = render(withI18n(<SkillRunBar {...shared} runnableTools={[writeTool]} />))
    await user.click(screen.getByRole('button', { name: 'synthetic_write' }))
    expect(screen.getByText('Run this tool?')).toBeInTheDocument()

    // The offer unmounts (its tool left the runnable set) — the dialog goes with it…
    rerender(withI18n(<SkillRunBar {...shared} runnableTools={[]} />))
    expect(screen.queryByText('Run this tool?')).not.toBeInTheDocument()

    // …and when the offer returns, the stale confirm must stay closed (teeth: without the clear,
    // the still-set confirmTool re-opens the modal with no user action).
    rerender(withI18n(<SkillRunBar {...shared} runnableTools={[writeTool]} />))
    expect(screen.queryByText('Run this tool?')).not.toBeInTheDocument()
  })

  it('CONFIRM (#45): a plain export tool (no document transform) shows NO output-format line', async () => {
    const user = userEvent.setup()
    render(
      withI18n(
        <SkillRunBar
          run={null}
          runnableTools={[{ name: 'export_transactions_csv', requiresConfirmation: true }]}
          targetDocuments={[{ id: 'd1', name: 'statement.pdf' }]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    await user.click(screen.getByRole('button', { name: 'Export to CSV' }))
    expect(screen.getByText('Run this tool?')).toBeInTheDocument()
    expect(screen.queryByText(/plain text \(\.txt\)/)).not.toBeInTheDocument()
    expect(screen.queryByText(/Word format/)).not.toBeInTheDocument()
  })
})
