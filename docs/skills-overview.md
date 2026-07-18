# Skills overview — the bundled skills at a glance

A quick reference of every skill that ships with HilbertRaum: what each one is for and what it can
actually do. It is written for two audiences — **users** deciding which skill fits their task, and
**coding agents / contributors** who need a map of the skill surface without reading every
`SKILL.md`.

> **⚠ Keep this file in sync.** Whenever a bundled skill is **added, removed, or changed** (any
> `SKILL.md` edit — a capability, tool, or version bump), review and adjust this overview in the
> same change. This is enforced: `apps/desktop/tests/integration/skills-skillmd-parity.test.ts`
> pins every bundled skill's **id and version** against this file, so a skill change that skips the
> review fails the suite.

Sources of truth, in order of authority:

- [`app-skills/<id>/SKILL.md`](../app-skills/) — each skill's manifest + instruction body (the
  actual behavior).
- [`docs/user-guide.md`](user-guide.md) §9 — how to pick, run, import, and manage skills in the app.
- [`docs/architecture.md`](architecture.md) — the skills design records (loader, suggestion
  heuristic, tool orchestration, security posture).

## How skills work (common ground rules)

- A skill is a **local task pack**: plain files on the drive that shape one answer at a particular
  job. Skills never call a model or the network on their own; `network` is **denied** for all of
  them, and each reads **only the documents the user selected**.
- Two kinds ship today. **Tool skills** may run small, approved, app-owned local tools on a chosen
  document — read-only tools can run automatically while the skill is active; anything that
  **writes or exports a file always asks the user to confirm first**. **Instruction skills** only
  shape the model's answer (structure, honesty rules, citations) and run no tools.
- Every bundled skill leads with **honesty/safety rules** that survive prompt trimming: quote
  printed figures exactly, cite sources, never invent what the document doesn't state, no legal or
  compliance advice, answer in the user's language (all titles/descriptions are localized EN/DE).
- The app can **suggest** a fitting skill from the question and documents in scope; suggestions are
  offers only, and auto-activation is a separate user opt-in (default off).
- Users can **import their own skills** (`.skill.zip` or a `SKILL.md` folder); built-in skills can
  be toggled on/off but not deleted.

## Tool skills

| Skill (EN / DE) | id · version | What it can do |
|---|---|---|
| **Bank Statement Analysis** / Kontoauszug-Analyse | `bank-statement` · v1.0.1 | Extract the transaction table from a statement (PDF/CSV/pasted), check that the printed opening/closing balances reconcile with the transactions, categorize transactions, summarize cashflow (in / out / net, per-category totals), and export the transactions to CSV. Flags unreconciled rows before any total and never invents a figure the statement doesn't print. |
| **Invoice Analysis** / Rechnungsanalyse | `invoice` · v1.1.0 | Extract an invoice's header, line items, and totals; check that the printed totals add up (line items → net, net + tax → gross, stated tax rate); export the line items to CSV or the whole invoice to JSON/XML. Unparsed fields stay blank on purpose — nothing is computed into existence. |
| **Document Redaction** / Dokument schwärzen | `document-redaction` · v1.1.0 | Create a redacted **copy** of a chosen document: a deterministic rule floor always masks clearly-shaped data (e-mails, phone numbers, IBANs, payment-card numbers, dates, links); with a model running it also masks the names, addresses, and organisation names the model locates (the model only points at spans — it never rewrites text). `.docx` in → `.docx` out with formatting preserved; other formats save as `.txt`. User-started, always confirms before saving. **Best-effort, not a compliance guarantee.** |
| **Document Edit** / Dokument bearbeiten | `document-edit` · v1.1.0 | Apply targeted **find-and-replace** edits to a chosen document without rewriting it: a running model locates the exact substrings, the app verifies and splices them — everything else stays byte-identical, and text not found verbatim is reported as skipped. `.docx` formatting preserved; always confirms before saving. Requires a running model; never auto-activated. |

## Instruction skills (the "Professional Documents" set)

| Skill (EN / DE) | id · version | What it can do |
|---|---|---|
| **Meeting Minutes** / Besprechungsprotokoll | `meeting-protocol` · v1.1.1 | Turn a meeting transcript, rough notes, or an agenda into structured minutes over the **whole** document: summary, context, topics, a decisions table, action items with owners/deadlines (only when explicitly stated), open questions, risks, a polished formal version, and formal motions/votes when the source uses motion language. Never infers decisions, attendees, or deadlines. |
| **Contract Brief** / Vertragsübersicht | `contract-brief` · v1.0.0 | A plain-language brief of a **whole** contract: parties and roles, key dates and term, obligations, payment terms, termination/renewal, risk clauses actually present (liability, indemnity, IP, …), unusual or unclear points, and a checklist of questions to ask before signing. **Not legal advice** — it never says "safe to sign". |
| **Deadline & Obligation Finder** / Fristen & Pflichten | `deadline-obligation-finder` · v1.1.0 | Scan a **whole** document for deadlines, notice periods, renewal and payment dates, and obligations — what to do, by when, who must act, and the consequence if missed — plus missing/unclear owners and suggested next actions. Keeps relative triggers ("within 30 days after delivery") instead of computing dates without an explicit anchor. Not a complete compliance calendar. |
| **What Changed?** / Was hat sich geändert? | `what-changed` · v1.1.0 | Compare **exactly two** document versions and report the material changes in business language: an executive summary, a change table prioritized by impact (price, scope, dates, obligations, liability, …), added and removed text, and meaning-shifting wording ("may" → "must"). Grounded in the app's deterministic word-level redline when available; never guesses which version is "old" or "new". |
| **Share-Safe Review** / Sicher teilen prüfen | `share-safe-review` · v1.1.0 | Review a **whole** document before sharing it: a clear verdict, a table of visible sensitive information (identifiers, bank details, medical/HR/financial content, secrets, …) informed by an offline pattern pre-scan, a hidden-metadata warning, a pointer to the Document Redaction skill, and a share checklist. **Advisory only** — it never claims a document is anonymized, compliant, or safe to publish. |

## What skills cannot do (deliberate limits)

- No network access, ever, and no documents beyond the user's selection.
- Tool skills never write or export without an explicit per-run confirmation; the model never runs
  a tool itself — the app orchestrates.
- Redaction and share-safe review are **best-effort assistance**, not anonymization or compliance
  guarantees; contract and deadline skills give **no legal, tax, or compliance advice**.
- Skills are task knowledge, not code: an imported skill gets the same sandbox (declared
  permissions are capped by the app, unknown tools are simply not run).
