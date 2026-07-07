---
id: meeting-protocol
title: Meeting Minutes
description: Use when the user shares a meeting transcript, rough notes, or agenda and wants clean, structured minutes — decisions, action items, and open questions.
version: 1.1.1
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Besprechungsprotokoll
    description: Verwenden, wenn aus einem Besprechungstranskript, Notizen oder einer Tagesordnung ein sauberes, strukturiertes Protokoll entstehen soll – Beschlüsse, Aufgaben und offene Fragen.
kind: instruction
analysis: whole-doc            # A3/§8.2: the model answers over the WHOLE transcript (not top-k passages).
                               #   With this skill active over a single fully-chunked doc the whole-doc engine
                               #   is the DEFAULT — keywords only opt out for chatter (small talk) and send a
                               #   NEEDLE lookup to top-k when the read would truncate. An ENGINE choice, not a
                               #   tool capability (SEC-1 unchanged) — honored for a skill of any source.
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  autoFire: true               # U4/§2.4 D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4 default-OFF, app-only, §6.5 compatibility, and the score ≥ 3 bar
                               #   (auto-fire bar; the suggestion offer bar is score ≥ 2 with a mandatory
                               #   keyword hit) — a
                               #   keyword corroborated by ≥1 EXPLICITLY-scoped doc signal, U4/§4.4). Kills
                               #   the "Summarize this meeting" miss (§2.4) once a meeting doc is attached;
                               #   W5's expanded corpus holds the threshold-3 gate at 0-wrong / prec ≥ 0.95.
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. `meeting` is word-matched (so "Summarize this meeting" both offers AND routes); the bare
  # ambiguous `minutes` (⊂ "a few minutes") is route-only. Edit the vocabulary, not this list.
  keywords: [meeting minutes, meeting notes, meeting protocol, meeting transcript, meeting,
             action item, action items, agenda,
             protokoll, besprechungsprotokoll, sitzungsprotokoll, besprechung, sitzung,
             tagesordnung, aktionspunkte, beschluss, beschlüsse, entscheidung, entscheidungen,
             aufgabe, aufgaben, notizen]
  mimeTypes: [text/plain, text/markdown, application/pdf]
  filenamePatterns: ["*meeting*", "*minutes*", "*transcript*", "*protokoll*", "*besprechung*", "*sitzung*"]
---

# Meeting Minutes
Honesty rules — these lead and always apply, even if the rest of this skill is shortened to fit the
context:
- Work **only** from the selected material — never add facts, names, dates, or decisions the source
  does not contain.
- **Separate what was decided from what was merely discussed.** If the notes are ambiguous about
  whether something was agreed, say so plainly instead of resolving it yourself.
- Do not infer attendees from first names unless they are clearly attendees; do not infer deadlines;
  do not infer agreement from silence.
- Keep every date, name, and figure exactly as printed, including the date format, and quote wording
  that carries weight (a decision, a commitment, a deadline) close to the original so the user can
  verify it. Cite the source for document-grounded items.
- Answer in the user's language: German notes → German minutes (Beschlüsse, Aufgaben, offene Fragen);
  English notes → English minutes.

Use this skill when the user shares a meeting transcript, rough notes, an agenda, or an audio
transcript and wants professional meeting minutes.

Produce the minutes in this order. Omit a section only if the source genuinely has nothing for it;
never pad it with a guess.

## 1. Short summary
2–5 factual bullets. No invented decisions.

## 2. Meeting context
Only items present in the source — date/time, attendees, organization/project, meeting purpose.
Write "Not stated" for anything absent.

## 3. Topics discussed
Grouped by topic, concise.

## 4. Decisions made
| Decision | Decided by / owner | Details | Source |
If no decision is explicit, write "No explicit decisions found in the provided material."

## 5. Action items
| Task | Owner | Deadline | Status / dependency | Source |
- Owner must be explicitly stated, else "Not stated"; same for the deadline.
- Do not turn a general idea into an action item unless the source clearly assigns an action.
- "We should maybe…" is an open question or a proposal, not an action item.

## 6. Open questions
Unresolved questions, parking-lot items, missing decisions.

## 7. Risks / follow-ups
Only source-grounded concerns.

## 8. Formal minutes version
A polished version that can be pasted into an email or record.

**Formal motions/votes.** If — and only if — the source uses formal motion language, record for each
motion: the motion text; the mover and seconder if stated; the result (passed / failed / tabled /
referred / postponed / unknown); and the vote tally if stated. A motion is distinct from general
discussion and is normally disposed of as passed, defeated, tabled, referred, or postponed. Never
invent parliamentary detail the source does not contain.

(The honesty rules that govern these minutes are stated at the top of this skill.)
