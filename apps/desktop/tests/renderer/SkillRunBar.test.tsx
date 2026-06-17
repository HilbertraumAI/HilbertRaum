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
    expect(onRun).toHaveBeenCalledWith('extract_transactions', false)
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
    expect(onRun).toHaveBeenCalledWith('synthetic_write', true)
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

  it('RESULT: a failed run shows the friendly error, a cancelled run says nothing was saved', () => {
    const { rerender } = render(
      withI18n(
        <SkillRunBar
          run={run({ state: 'failed', error: 'This statement could not be saved. Nothing was changed.' })}
          runnableTools={[]}
          onRun={vi.fn()}
          onCancel={vi.fn()}
          onDismiss={vi.fn()}
        />
      )
    )
    expect(screen.getByText(/could not be saved/)).toBeInTheDocument()
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
})
