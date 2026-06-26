import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildBankAnswer } from '../../src/main/services/skills/analysis/bank-statement'
import { buildInvoiceAnswer } from '../../src/main/services/skills/analysis/invoice'
import {
  reconcileBalances,
  summarizeCashflow,
  type TransactionInput
} from '../../src/main/services/skills/tools/bank-statement'
import { validateInvoiceTotals, type InvoiceInput } from '../../src/main/services/skills/tools/invoice'
import { t, type MessageKey, type MessageParams } from '../../src/shared/i18n'

// A-1 (audit 2026-06-26) — SKILL.md ⇔ deterministic-answer PARITY.
//
// For a TOOL skill the SKILL.md body is INERT on the primary answer path: when the analysis handler
// applies, the answer is reimplemented in deterministic TS (`buildBankAnswer` / `buildInvoiceAnswer`),
// which never reads the SKILL.md instructions (the body only rides the off-topic relevance fallback —
// architecture.md §19). The honesty posture is therefore CODE-enforced, and the body + the code can
// silently drift. This test pins the contract in BOTH directions, so an edit to EITHER the SKILL.md
// body OR the answer TS that breaks a honesty bullet fails:
//   - the SKILL.md body STILL states each honesty bullet (a watered-down body fails the body half), and
//   - the answer builder STILL produces the matching honest branch for a constructed
//     unreconciled / contradicted / mixed-currency / missing-figure case (a regression in the branch
//     logic fails the TS half).
// The expected copy is derived via `tr(...)` from i18n, so re-wording a localized string flows through
// to both sides equally — the parity asserted here is body↔branch, not exact wording.

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', '..')
const BANK_SKILL_MD = readFileSync(join(REPO_ROOT, 'app-skills', 'bank-statement', 'SKILL.md'), 'utf8')
const INVOICE_SKILL_MD = readFileSync(join(REPO_ROOT, 'app-skills', 'invoice', 'SKILL.md'), 'utf8')

const tr = (key: MessageKey, params?: MessageParams): string => t('en', key, params)
/** Mirrors the answer builders' private `fmt` (two-decimal, like the printed figures). */
const fmt = (n: number): string => n.toFixed(2)

describe('SKILL.md ⇔ buildBankAnswer parity (A-1)', () => {
  // A single-currency statement whose SECOND row's printed running balance contradicts the amounts
  // (baseline row is `unknown`; row 2 expects 1954.10 + 100.00 = 2054.10, prints 9999.99 → mismatch).
  const rows: TransactionInput[] = [
    { date: '2026-01-02', description: 'Grocery', amount: -45.9, currency: 'EUR', balanceAfter: 1954.1 },
    { date: '2026-01-03', description: 'Salary', amount: 100.0, currency: 'EUR', balanceAfter: 9999.99 }
  ]
  const reconcile = reconcileBalances(rows)
  const summary = summarizeCashflow(rows)
  const totalsLine = (): string =>
    tr('skills.bankAnalysis.totals', {
      inAmount: fmt(summary.totalIn),
      outAmount: fmt(summary.totalOut),
      netAmount: fmt(summary.net),
      currency: summary.currency!
    })

  it('body: bank SKILL.md states the unreconciled-before-total / reconcile / never-invent bullets', () => {
    expect(BANK_SKILL_MD).toContain('before presenting a total')
    expect(BANK_SKILL_MD).toContain('do not reconcile with the transactions, say so plainly')
    expect(BANK_SKILL_MD).toContain('Do not invent a figure the statement does not state')
  })

  it('TS: unreconciled rows lead BEFORE the total (the "before presenting a total" bullet)', () => {
    expect(reconcile.rows.some((r) => r.status === 'mismatch')).toBe(true) // sanity: the case is unreconciled
    const answer = buildBankAnswer(tr, { rows, summary, reconcile, categories: null, status: 'complete' })
    const unreconciled = answer.indexOf(tr('skills.bankAnalysis.unreconciledHeading'))
    const totals = answer.indexOf(totalsLine())
    expect(unreconciled).toBeGreaterThanOrEqual(0)
    expect(totals).toBeGreaterThan(unreconciled)
  })

  it('TS: a contradicted statement REFUSES a total (the "say so plainly / never invent" bullet)', () => {
    const answer = buildBankAnswer(tr, { rows, summary, reconcile, categories: null, status: 'contradicted' })
    expect(answer).toContain(tr('skills.bankAnalysis.incompleteNoTotal'))
    expect(answer).not.toContain(totalsLine()) // no mis-read/partial sum dressed up as the total
  })

  it('TS: a mixed-currency statement invents NO single combined total (the never-invent bullet)', () => {
    const mixed: TransactionInput[] = [
      { date: '2026-01-02', description: 'A', amount: -10, currency: 'EUR' },
      { date: '2026-01-03', description: 'B', amount: -20, currency: 'USD' }
    ]
    const mixedSummary = summarizeCashflow(mixed)
    expect(mixedSummary.currency).toBeUndefined() // no single currency → no combined total is computable
    const answer = buildBankAnswer(tr, {
      rows: mixed,
      summary: mixedSummary,
      reconcile: reconcileBalances(mixed),
      categories: null,
      status: 'unverified'
    })
    expect(answer).toContain(tr('skills.bankAnalysis.noCurrency'))
  })
})

describe('SKILL.md ⇔ buildInvoiceAnswer parity (A-1)', () => {
  it('body: invoice SKILL.md states the reconcile / unreconciled-before-total / never-invent bullets', () => {
    expect(INVOICE_SKILL_MD).toContain('If the totals do not reconcile')
    expect(INVOICE_SKILL_MD).toContain('before presenting a total')
    expect(INVOICE_SKILL_MD).toContain('Do not invent a figure the invoice does not state')
  })

  it('TS: a failed totals check leads BEFORE the totals (the reconcile + before-a-total bullets)', () => {
    // net = 100 (line items sum), but net + tax (100 + 20) ≠ printed gross 999 → netPlusTaxIsGross mismatch.
    const invoice: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: [{ description: 'Widget', lineTotal: 100, currency: 'EUR' }],
      totals: { netTotal: 100, taxTotal: 20, grossTotal: 999 }
    }
    const validation = validateInvoiceTotals(invoice)
    expect(validation.checks.some((c) => c.status === 'mismatch')).toBe(true) // sanity: it does not reconcile
    const answer = buildInvoiceAnswer(tr, { invoice, validation })
    const unreconciled = answer.indexOf(tr('skills.invoiceAnalysis.unreconciledHeading'))
    const totals = answer.indexOf(tr('skills.invoiceAnalysis.totalsHeading'))
    expect(unreconciled).toBeGreaterThanOrEqual(0)
    expect(totals).toBeGreaterThan(unreconciled)
  })

  it('TS: an absent figure is NEVER invented (the "do not invent a figure" bullet)', () => {
    // Only a net is stated — no tax, no gross. The answer prints the net verbatim and fabricates no gross.
    const invoice: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: [{ description: 'Widget', lineTotal: 100, currency: 'EUR' }],
      totals: { netTotal: 100 }
    }
    const answer = buildInvoiceAnswer(tr, { invoice, validation: validateInvoiceTotals(invoice) })
    expect(answer).toContain(tr('skills.invoiceAnalysis.net', { amount: '100.00', currency: 'EUR' }))
    // The static lead of the gross line (derived from i18n, wording-robust) must not appear at all.
    const grossLead = tr('skills.invoiceAnalysis.gross', { amount: 'AMT', currency: 'CUR' }).split('AMT')[0]
    expect(answer).not.toContain(grossLead)
  })

  it('TS: an invoice that prints no totals says so, inventing nothing (the never-invent bullet)', () => {
    const invoice: InvoiceInput = {
      header: { currency: 'EUR' },
      lineItems: [{ description: 'Widget', lineTotal: 100, currency: 'EUR' }],
      totals: {}
    }
    const answer = buildInvoiceAnswer(tr, { invoice, validation: validateInvoiceTotals(invoice) })
    expect(answer).toContain(tr('skills.invoiceAnalysis.noTotals'))
  })
})
