---
id: meeting-protocol
title: Meeting Protocol
description: Use when the user shares meeting notes or a transcript and wants a structured protocol — decisions, action items, and open questions.
version: 1.0.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Besprechungsprotokoll
    description: Verwenden, wenn aus Besprechungsnotizen oder einem Transkript ein strukturiertes Protokoll erstellt werden soll – Beschlüsse, Aufgaben und offene Fragen.
kind: instruction
compatibility:
  minAppVersion: 0.1.29
permissions:
  documents: selected_only
  network: denied
  filesystem: skill_resources_only
triggers:
  keywords: [meeting, meeting notes, minutes, protocol, agenda, action item, action items,
             besprechung, besprechungsprotokoll, protokoll, sitzung, sitzungsprotokoll,
             notizen, tagesordnung, beschluss, beschlüsse, aufgabe, aufgaben]
  mimeTypes: [text/plain, text/markdown, application/pdf]
  filenamePatterns: ["*protokoll*", "*minutes*", "*meeting*", "*besprechung*", "*sitzung*"]
---

# Meeting Protocol

Use this skill when the user shares meeting notes, a transcript, or a recording summary and
wants it turned into a clean, structured protocol.

Read only the documents the user has selected for this turn, and produce the protocol in this
order. Omit a section entirely if the source genuinely contains nothing for it — never pad it
with a guess.

1. **Header** — meeting title, date, and attendees, exactly as written in the source.
2. **Decisions** — each decision as a single clear statement. Where the notes attribute a
   decision to a person or a vote, keep that attribution.
3. **Action items** — one per line as *owner → task → due date*. If an owner or a date is not
   stated, write "owner: not stated" / "due: not stated" rather than inventing one.
4. **Open questions** — anything raised but left unresolved.
5. **Notes** — any remaining context worth keeping, kept brief.

Hold to these rules:

- **Work only from the selected documents.** Do not add facts, names, dates, or decisions that
  the notes do not contain. A detail you would have to assume is not a detail the meeting recorded.
- **Quote wording that carries weight** (a decision, a commitment, a deadline) close to how it
  was written, so the user can verify it against the original.
- **Separate what was decided from what was merely discussed.** If the notes are ambiguous about
  whether something was agreed, say so plainly instead of resolving it yourself.
- **Keep every date, name, and figure exactly as printed**, including the date format.

Answer in the user's language. If the meeting notes are in German, write the protocol in German
(Beschlüsse, Aufgaben, offene Fragen); if in English, write it in English.
