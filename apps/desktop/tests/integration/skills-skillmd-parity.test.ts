import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSkillManifestFromDir } from '../../src/main/services/skills/manifest'
import { approxPromptTokens, buildSkillFence } from '../../src/main/services/skills/prompt'
import { APP_VOCAB_SKILL_IDS, suggestTerms } from '../../src/main/services/skills/vocabulary'
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

const norm = (xs: string[]): string[] => [...new Set(xs.map((x) => x.trim().toLowerCase()))].sort()

// W5 (audit §4.1/§8.3) — the SKILL.md `triggers.keywords` (the SUGGESTION manifest, a public format) must
// be EXACTLY the skill's `suggest|both` vocabulary terms. `services/skills/vocabulary.ts` is the single
// source both the suggestion scorer and the routing gates read; regenerating the manifest lists from it and
// pinning that equality here is what kills the two-drifting-lists class (a term that offered but never
// routed, or routed but was never offered). Edit the vocabulary — this test then guards the SKILL.md copy.
describe('SKILL.md triggers.keywords ⇔ vocabulary parity (W5)', () => {
  for (const id of APP_VOCAB_SKILL_IDS) {
    it(`${id}: the manifest keyword set equals the vocabulary's suggest|both terms`, () => {
      const res = parseSkillManifestFromDir(join(REPO_ROOT, 'app-skills', id))
      expect(res.ok, `parse ${id}: ${res.errors.join('; ')}`).toBe(true)
      const manifestKeywords = norm(res.manifest!.triggers.keywords)
      const vocabSuggest = norm(suggestTerms(id))
      expect(manifestKeywords).toEqual(vocabSuggest)
    })
  }
})

// U1 (audit §3.6) + SKA-15 (audit 2026-07-03, U7) — every SKILL.md body LEADS with its honesty/safety
// rules, and the rules live in the paragraph `buildSkillFence` actually GUARANTEES. The builder's
// guaranteed minimum is `paragraphs[0]` ONLY: U1's original layout (P0 = "# Heading", P1 = intro,
// P2 = bullets) still decapitated the rules at a tight budget — the minimum shipped a bare heading, or
// (as this test previously pinned at paras[1]) an intro PROMISING rules with none delivered. SKA-15
// merges heading + intro + bullets into ONE paragraph, so the guaranteed-kept minimum IS the rules
// block. Pinned for all 9 shipped app skills, both statically (paragraph shape) and end-to-end
// (trimming the REAL body through `buildSkillFence` at a rules-only budget keeps the bullets).
const ALL_APP_SKILL_IDS = [
  'bank-statement',
  'invoice',
  'document-redaction',
  'document-edit',
  'contract-brief',
  'deadline-obligation-finder',
  'meeting-protocol',
  'share-safe-review',
  'what-changed'
] as const

describe('SKILL.md honesty/safety rules survive the fence-trim minimum (U1 + SKA-15)', () => {
  for (const id of ALL_APP_SKILL_IDS) {
    it(`${id}: heading + rules are ONE paragraph — the buildSkillFence guaranteed minimum`, () => {
      const res = parseSkillManifestFromDir(join(REPO_ROOT, 'app-skills', id))
      expect(res.ok, `parse ${id}: ${res.errors.join('; ')}`).toBe(true)
      const paras = (res.body ?? '').split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      // paragraph[0] — the ONLY paragraph the builder guarantees — must carry the heading, the
      // "always apply" intro, AND the actual rule bullets (≥ 3 of them), not just a promise of rules.
      expect(paras[0].startsWith('#')).toBe(true)
      expect(paras[0]).toMatch(/lead and always apply/i)
      expect(paras[0].split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThanOrEqual(3)
    })

    it(`${id}: the REAL body trimmed at a rules-only budget still ships the rule bullets`, () => {
      const res = parseSkillManifestFromDir(join(REPO_ROOT, 'app-skills', id))
      expect(res.ok).toBe(true)
      const body = res.body ?? ''
      const title = res.manifest!.title
      const paras = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
      expect(paras.length).toBeGreaterThan(1) // sanity: there IS something to trim away
      // A budget sized to EXACTLY the minimum fence (framing + guard + paragraphs[0]): build the
      // one-paragraph fence unbounded, measure it, then trim the FULL body to that budget.
      const minimumFence = buildSkillFence({ title, body: paras[0] })
      const budget = approxPromptTokens(minimumFence.text!)
      const trimmed = buildSkillFence({ title, body }, budget)
      // The audit acceptance (SKA-15): a budget-squeezed turn must never ship the intro without the
      // rules. The kept text carries the "always apply" lead AND the bullets.
      expect(trimmed.omitted).toBe(false)
      expect(trimmed.trimmed).toBe(true) // the later paragraphs were dropped — this IS the minimum
      expect(trimmed.text!).toMatch(/lead and always apply/i)
      expect(trimmed.text!.split('\n').filter((l) => l.startsWith('- ')).length).toBeGreaterThanOrEqual(3)
    })
  }
})

// SKILL.md ⇔ docs/skills-overview.md parity — the overview's keep-in-sync rule, with teeth.
// docs/skills-overview.md documents every bundled skill (audience: users + coding agents) and
// carries the rule "review this file whenever a skill is added, removed, or changed". A doc rule
// without a gate drifts, so this pins it both ways: every directory under app-skills/ (enumerated
// from DISK, so an added skill fails until the overview is reviewed) must appear in the overview
// with its exact id AND current version (a version bump forces a review touch), and the overview
// must not list a skill id that no longer ships (a removed skill fails until its row is dropped).
describe('SKILL.md ⇔ docs/skills-overview.md parity (skills overview keep-in-sync rule)', () => {
  const OVERVIEW = readFileSync(join(REPO_ROOT, 'docs', 'skills-overview.md'), 'utf8')
  const shippedIds = readdirSync(join(REPO_ROOT, 'app-skills'), { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()

  it('sanity: the disk enumeration sees the bundled skill set', () => {
    expect(shippedIds).toEqual([...ALL_APP_SKILL_IDS].sort())
  })

  for (const id of shippedIds) {
    it(`${id}: the overview lists the skill with its current id and version`, () => {
      const res = parseSkillManifestFromDir(join(REPO_ROOT, 'app-skills', id))
      expect(res.ok, `parse ${id}: ${res.errors.join('; ')}`).toBe(true)
      expect(OVERVIEW).toContain(`\`${id}\` · v${res.manifest!.version}`)
    })
  }

  it('the overview lists no skill id that no longer ships', () => {
    const listed = [...OVERVIEW.matchAll(/`([a-z0-9-]+)` · v/g)].map((m) => m[1]).sort()
    expect(listed).toEqual(shippedIds)
  })
})

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
    // invoice-hardening-2026-07-04 P2: a MISMATCHED invoice prints its totals under the UNVERIFIED
    // heading (never "exactly as printed") — the SKILL.md "before presenting a total" bullet is
    // satisfied by the unreconciled block preceding that unverified totals block.
    const totals = answer.indexOf(tr('skills.invoiceAnalysis.totalsHeadingUnverified'))
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
    expect(answer).toContain(tr('skills.invoiceAnalysis.net', { value: '100.00 EUR' }))
    // The static lead of the gross line (derived from i18n, wording-robust) must not appear at all.
    const grossLead = tr('skills.invoiceAnalysis.gross', { value: 'AMT' }).split('AMT')[0]
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
