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
  it('renders nothing with no run and no offered tools', () => {
    const { container } = render(
      withI18n(<SkillRunBar run={null} runnableTools={[]} onRun={vi.fn()} onCancel={vi.fn()} onDismiss={vi.fn()} />)
    )
    expect(container).toBeEmptyDOMElement()
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
})
