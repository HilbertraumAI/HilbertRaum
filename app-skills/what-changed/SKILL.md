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
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # Bilingual, multi-word/domain terms only (matching is case-insensitive question.includes); German
  # umlaut/ending forms listed separately. Avoids bare ambiguous tokens.
  keywords: [what changed, compare versions, compare documents, version difference,
             differences between, changed between, old and new, redline, revision, updated terms,
             compare contract,
             was hat sich geändert, änderungen, unterschiede, versionen vergleichen,
             dokumente vergleichen, alte version, neue version, gegenüberstellung,
             vertragsänderung, aktualisierte bedingungen]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  # Version-marker patterns only. The bare single words (final/new/old/version/alt/neu) were dropped:
  # combined with the broad mimeTypes they cleared the mime+filename suggest bar on very common,
  # unrelated filenames (final.pdf, report-new.pdf) — low precision for a compare offer.
  filenamePatterns: ["*redline*", "*-v1*", "*-v2*", "*-v3*", "*_v1*", "*_v2*", "*draft*", "*entwurf*"]
---

# What Changed?

Use this skill when the user wants to compare two versions of a document, contract, policy, offer,
report, or set of terms. Highlight the **material** changes in business language — grounded in the
exact changes, not a vague impression.

**Before you start:** if fewer than two documents or versions are in scope, say clearly: "Please
select two documents or two versions to compare." If more than two are in scope, ask the user to
narrow to exactly two.

**When the app gives you a deterministic word-level diff** (an "Exact changes"/redline block or a
list of exact changes), treat it as **complete and exact** — it already found every changed word,
including a single deleted or altered word. Base your answer only on it: turn each change into a
plain-language point, and **never dismiss a change as unimportant or the content as "placeholder"**
just because it looks repetitive or low-value — report it plainly (e.g. "one word removed on page 2")
and let the reader judge. Keep every amount, date, and wording exactly as printed. If instead you are
given only document passages (no diff), compare carefully and use cautious wording for anything the
passages do not fully cover.

Produce the answer in this order; omit a section only if there is genuinely nothing for it.

## 1. Executive summary
3–6 bullets on the most important changes.

## 2. Material changes
The app labels the two documents **A** and **B** by import order only — it does **not** know which
is the older or newer version. Use those labels; never call one the "old" and the other the "new"
version unless the documents' own contents say so.
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

Cite the source for each change. Answer in the user's language, and keep amounts, dates, and wording
exactly as printed.
