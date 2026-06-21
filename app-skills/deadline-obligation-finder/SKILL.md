---
id: deadline-obligation-finder
title: Deadline & Obligation Finder
description: Use when the user wants to find deadlines, notice periods, renewal and payment dates, and the obligations in one or more documents — what to do, by when, and what happens if missed.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Fristen & Pflichten
    description: Verwenden, wenn Fristen, Kündigungsfristen, Verlängerungs- und Zahlungstermine sowie Pflichten in Dokumenten gefunden werden sollen – was bis wann zu tun ist und was bei Versäumnis passiert.
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
  keywords: [deadlines, due dates, notice period, renewal date, cancellation deadline, obligations,
             duties, must do, shall do, required to, action required, what do i have to do, by when,
             calendar dates,
             frist, fristen, fälligkeiten, stichtag, kündigungsfrist, verlängerung, pflichten,
             verpflichtungen, muss ich, müssen wir, zahlungsfrist, bis wann, wiedervorlage]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: ["*deadline*", "*frist*", "*vertrag*", "*contract*", "*agreement*", "*notice*", "*renewal*", "*kündigung*"]
---

# Deadlines & Obligations

Use this skill when the user asks "what do I need to do, by when, and what happens if I miss it?"
across one or more selected documents. Extract deadlines, notice periods, renewal and payment dates,
and obligations. Work only from the selected material.

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

**Safety / honesty**

- This is **not** a complete compliance calendar. Say "I found these deadlines and obligations in the
  available material." If the user asks for "all deadlines", be especially cautious and mention any
  coverage limitation that is visible (e.g. only some passages were retrieved).
- Do not give legal, tax, or compliance advice. Cite the source for each item.

Answer in the user's language, and keep dates and wording exactly as printed.
