---
id: document-redaction
title: Document Redaction
description: Use when the user wants to redact, anonymize, or remove personal data from a document.
version: 1.1.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Dokument schwärzen
    description: Verwenden, wenn personenbezogene Daten in einem Dokument geschwärzt, anonymisiert oder entfernt werden sollen.
kind: tool                     # Tier-2 (S11d): the app-orchestrated tool below is effective
compatibility:
  minAppVersion: 0.1.29
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # The app-owned tools this skill may run (declared ∩ registry ∩ grant);
  - redact_document            #   it reads the selected document and asks before saving the copy.
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  autoFire: true               # U4/§2.4 D6 opt-in: eligible for auto-fire (still gated by the user opt-in
                               #   D4 default-OFF, app-only, §6.5 compatibility, and the score ≥ 3 bar
                               #   (auto-fire bar; the suggestion offer bar is score ≥ 2 with a mandatory
                               #   keyword hit) — a
                               #   keyword corroborated by ≥1 EXPLICITLY-scoped doc signal, U4/§4.4). The
                               #   eval corpus holds the auto-fire gate at 0-wrong (architecture.md §18).
                               #   (Comment refreshed from the stale S13a-era wording — SKA-45, U7.)
  # W5: GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by a
  # parity test. The action verbs (redact/anonymize/schwärzen…) both OFFER and ROUTE. The bare PII-content
  # topics (personenbezogene daten #608, sensitive data / sensible daten #604) are route-only: the
  # informational dry-run still answers them once the skill is active, but as offer keywords they
  # suggested and auto-fired this skill on GDPR, privacy-notice and contract questions. U4/§4.4 dropped
  # the pure legal words datenschutz/dsgvo/gdpr for the same reason. The removal phrases are listed per
  # form, but not the infinitive "… daten löschen", which deletion-duty questions use. Edit the
  # vocabulary, not this list.
  keywords: [redact, redaction, anonymize, anonymise, anonymized, anonymised,
             remove personal data, remove all personal data, mask personal data,
             anonymisieren, anonymisierung, anonymisiere, pseudonymisieren,
             schwärzen, schwärzung, schwärze, geschwärzt,
             personenbezogene daten entfernen, personenbezogenen daten entfernen,
             entferne alle personenbezogenen daten, entferne die personenbezogenen daten,
             entferne personenbezogene daten, lösche alle personenbezogenen daten,
             lösche die personenbezogenen daten, lösche personenbezogene daten,
             remove sensitive data, remove the sensitive data, remove all sensitive data,
             mask sensitive data, sensible daten entfernen, sensiblen daten entfernen]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: []         # redaction is intent-driven, not filename-driven — leave empty
---

# Document Redaction
Safety rules — these lead and always apply, even if the rest of this skill is shortened to fit:
- **Do the routing, not the work.** When the user asks to redact, anonymize, or remove personal data
  from the document they have selected, tell them — briefly, in their own language — to click the
  **Redact personal data** / **Personenbezogene Daten schwärzen** button just above the message box
  (its label follows the app language) and choose where to save the copy. Do not
  refuse, do not walk them through a manual procedure, and never run the tool yourself; it runs only
  when the user starts it and **always asks before saving**.
- **Never state whether the document does or does not contain personal data** — you have seen only
  part of it, so any such claim would be guesswork.
- **It is an AI-assisted best-effort first pass, not a guarantee.** A deterministic rule-based floor
  always masks the clearly-shaped data (e-mail addresses, phone numbers, IBANs, payment-card numbers,
  dates, links); on top of that, when a model is running, it **locates** names, addresses, and
  organisation names for the app to mask (when the user steers the scope with their own instruction,
  other located items are masked as `[REDACTED]`) — the model only points at spans, it never rewrites the
  document, so it cannot invent text. It **still misses** things (unusual formats, data in images or
  scans, anything the model doesn't spot), so **never** describe the result as "fully anonymized" or
  imply it meets any legal or compliance standard. If no model is running, only the rule-based floor
  applies and the result says so.
- After it runs, remind the user to **review the saved copy themselves** before sharing it, report
  only the counts the tool gives (e.g. "3 phone numbers hidden"), and never repeat detected personal
  data back to them. Answer in the user's language.

The tool runs entirely on this device. It reads the **whole** document, masks the clearly-shaped
personal data with fixed rules — e-mail addresses, phone numbers, IBANs, payment-card numbers, dates,
and web links — and, when a model is running, also masks the names, addresses, and organisation names
the model locates. It runs only when the user starts it, always asking before the copy is written
where the user chooses. A Word document (`.docx`) is saved as a `.docx` copy with its formatting
preserved; any other format (PDF, plain text, Markdown) is saved as a plain-text copy.
