---
id: what-changed
title: What Changed?
description: Use when the user wants to compare two versions of a document, contract, policy, or offer and see the material changes that matter — not just a raw diff.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Was hat sich geändert?
    description: Verwenden, wenn zwei Versionen eines Dokuments, Vertrags, einer Richtlinie oder eines Angebots verglichen werden sollen – die wesentlichen Änderungen, nicht nur ein roher Diff.
kind: instruction
analysis: compare              # A3/§8.2: the model compares BOTH whole versions (not top-k passages). With this
                               #   skill active over EXACTLY TWO fully-chunked docs the compare engine is the
                               #   DEFAULT — keywords only opt out for chatter; at ≠2 docs the chat path routes
                               #   ("select exactly two"). An ENGINE choice, not a tool capability (SEC-1
                               #   unchanged) — honored for a skill of any source.
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Bilingual compare phrases; the bare imperatives (`compare these`, `vergleiche`) are
  # route-only. `änderung`/`änderungen` are word-matched (each form in its own right, not a substring).
  # Edit the vocabulary, not this list.
  keywords: [what changed, what has changed, compare versions, compare documents, version difference,
             differences between, changed between, redline, revision, updated terms, compare contract,
             was hat sich geändert, änderung, änderungen, unterschiede, versionen vergleichen,
             dokumente vergleichen, alte version, neue version, gegenüberstellung,
             vertragsänderung, aktualisierte bedingungen]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  # Version-marker patterns only. The bare single words (final/new/old/version/alt/neu) were dropped:
  # combined with the broad mimeTypes they cleared the mime+filename suggest bar on very common,
  # unrelated filenames (final.pdf, report-new.pdf) — low precision for a compare offer.
  filenamePatterns: ["*redline*", "*-v1*", "*-v2*", "*-v3*", "*_v1*", "*_v2*", "*draft*", "*entwurf*"]
---

# What Changed?
Honesty rules — these lead and always apply, even if the rest of this skill is shortened to fit the
context:
- **The app handles document scope for you — do not police it.** You cannot see how many documents
  are in scope, so never tell the user to "select two documents" or to "narrow to exactly two": the
  app already checks this and, when the count isn't exactly two, replies with that guidance itself
  before you are ever called. Assume you have been given exactly the two documents (or versions) to
  compare, labelled **A** and **B**, and get straight to comparing them.
- **A and B are import-order labels only** — the app does not know which is the older or newer
  version. Never call one the "old" and the other the "new" version unless the documents' own
  contents say so.
- **When the app gives you a deterministic word-level diff** (an "Exact changes"/redline block or a
  list of exact changes), treat it as **complete and exact** — it already found every changed word,
  including a single deleted or altered word. Base your answer only on it. If instead you are given
  only document passages (no diff), compare carefully and use cautious wording for anything the
  passages do not fully cover.
- **Never dismiss a change as unimportant or the content as "placeholder"** just because it looks
  repetitive or low-value — report it plainly (e.g. "one word removed on page 2") and let the reader
  judge.
- Cite the source for each change. Keep every amount, date, and wording exactly as printed, and
  answer in the user's language.

Use this skill when the user wants to compare two versions of a document, contract, policy, offer,
report, or set of terms. Highlight the **material** changes in business language — grounded in the
exact changes, not a vague impression.

Produce the answer in this order; omit a section only if there is genuinely nothing for it.

## 1. Executive summary
3–6 bullets on the most important changes.

## 2. Material changes
Use the app's **A** / **B** labels (import order only — never "old"/"new"; see the honesty rules above).
| Area | Document A | Document B | Why it matters | Source |
Prioritize: price / fees / payment; scope / deliverables; dates / term / renewal / deadlines;
obligations / responsibilities; rights / permissions; cancellation / termination; liability /
indemnity / warranties; confidentiality / privacy / data protection; ownership / IP / licensing;
governing law / dispute process.

## 3. Added text (present in Document B, not in Document A)
Important clauses or obligations that appear in B but not A.

## 4. Removed text (present in Document A, not in Document B)
Important clauses or protections that appear in A but not B.

## 5. Wording changes that may matter
Only where the meaning may have shifted, e.g. "may" → "must", "reasonable efforts" → "best efforts",
changed amounts, changed notice periods.

## 6. Questions to review
A checklist for the user.

(The honesty rules that govern this comparison — sourcing, A/B labels, exact wording — are stated at
the top of this skill.)
