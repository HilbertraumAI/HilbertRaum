---
id: deadline-obligation-finder
title: Deadline & Obligation Finder
description: Use when the user wants to find deadlines, notice periods, renewal and payment dates, and the obligations in a document — what to do, by when, and what happens if missed.
version: 1.1.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Fristen & Pflichten
    description: Verwenden, wenn Fristen, Kündigungsfristen, Verlängerungs- und Zahlungstermine sowie Pflichten in einem Dokument gefunden werden sollen – was bis wann zu tun ist und was bei Versäumnis passiert.
kind: instruction
analysis: whole-doc            # A3/§8.2: the finder scans the WHOLE document for deadlines/obligations (not
                               #   top-k passages). With this skill active over a single fully-chunked doc the
                               #   whole-doc engine is the DEFAULT — keywords only opt out for chatter and send a
                               #   NEEDLE lookup (e.g. "when is the renewal date?") to top-k when the read would
                               #   truncate. An ENGINE choice, not a tool capability (SEC-1 unchanged).
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. Bilingual deadline/obligation nouns (singular + plural listed for word-boundary matching);
  # the imperative phrases (`what do i have to do`, `bis wann`) are route-only. Edit the vocabulary.
  keywords: [deadline, deadlines, due date, due dates, notice period, renewal date,
             cancellation deadline, obligation, obligations, payment date, payment dates,
             frist, fristen, fälligkeit, fälligkeiten, stichtag, kündigungsfrist, zahlungsfrist,
             pflicht, pflichten, verpflichtung, verpflichtungen, wiedervorlage]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: ["*deadline*", "*frist*", "*vertrag*", "*contract*", "*agreement*", "*notice*", "*renewal*", "*kündigung*"]
---

# Deadlines & Obligations
Safety and honesty rules — these lead and always apply, even if the rest of this skill is shortened
to fit the context:
- This is **not** a complete compliance calendar. Say "I found these deadlines and obligations in the
  available material." If the user asks for "all deadlines", be especially cautious and mention any
  coverage limitation that is visible (e.g. only some passages were retrieved).
- Do not give legal, tax, or compliance advice. Cite the source for each item.
- Keep dates and wording exactly as printed, and answer in the user's language.

Use this skill when the user asks "what do I need to do, by when, and what happens if I miss it?"
in the selected document. Extract deadlines, notice periods, renewal and payment dates,
and obligations. Work only from the selected material. The app handles document scope — with
several documents in scope it narrows to the matching one or asks the user to pick; do not police
this yourself.

Produce the answer in this order; omit a section only if there is genuinely nothing for it.

## 1. Important deadlines
| Date / trigger | What happens | Who must act | Consequence | Source |
- Preserve the original wording.
- For a relative date ("within 30 days after delivery"), keep the trigger and do **not** compute a
  calendar date unless the anchor date is explicit.
- Mark an unclear deadline "Ambiguous".

## 2. Obligations
| Party / person | Obligation | Timing / standard | Consequence | Source |
- Extract only obligations expressed as must / shall / required / agrees to / ist verpflichtet /
  muss / soll. Do not turn background text into an obligation.

## 3. Notice periods and renewals
| Clause / topic | Period | Trigger | Source |

## 4. Missing information / unclear owners
Obligations or deadlines where the responsible person, the date, or the consequence is not clear.

## 5. Suggested next actions
A practical checklist, e.g. "confirm owner", "add to calendar", "ask counterparty".

(The safety and honesty rules that govern this answer are stated at the top of this skill.)
