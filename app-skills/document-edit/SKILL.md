---
id: document-edit
title: Document Edit
description: Use when the user wants to make targeted find-and-replace edits to a document without rewriting it.
version: 1.1.0
author: HilbertRaum
language: en
localized:                     # Per-locale DISPLAY overrides for title/description (additive; §16).
  de:                          #   Shown when the app runs in German; the guidance body stays English.
    title: Dokument bearbeiten
    description: Verwenden, wenn gezielte Suchen-und-Ersetzen-Änderungen an einem Dokument vorgenommen werden sollen, ohne es neu zu schreiben.
kind: tool                     # Tier-2: the app-orchestrated tool below is effective.
compatibility:
  minAppVersion: 0.1.40
permissions:                   # DECLARED INTENT only — the app is authoritative (skills plan §6.7)
  documents: selected_only     # none | selected_only  (v1 max is selected_only)
  network: denied              # always denied in v1
  filesystem: skill_resources_only   # reads only this skill's own packaged files
allowedTools:                  # The app-owned tools this skill may run (declared ∩ registry ∩ grant);
  - apply_document_edits       #   it reads the selected document and asks before saving the edited copy.
triggers:                      # OPTIONAL — drives the deterministic suggestion heuristic (§10).
  autoFire: false              # A targeted edit WRITES modified content, so it is never auto-activated on a
                               #   bare "change"/"replace" word — the user activates it (or accepts the offer)
                               #   deliberately. It is still SUGGESTED on the discriminating find-and-replace
                               #   phrases below (the suggestion offer is separate from auto-fire).
  # GENERATED from services/skills/vocabulary.ts (the skill's `suggest|both` terms) and pinned by the
  # SKILL.md ⇔ vocabulary parity test. Edit the vocabulary, not this list.
  keywords: [find and replace, search and replace, replace all, replace every, rename,
             suchen und ersetzen, ersetzen, ersetze, umbenennen]
  mimeTypes: [application/pdf, text/plain, text/markdown]
  filenamePatterns: []         # editing is intent-driven, not filename-driven — leave empty
---

# Document Edit
Safety rules — these lead and always apply, even if the rest of this skill is shortened to fit:
- **Do the routing, not the work.** When the user asks to replace, rename, or make a targeted change to
  the text of the document they have selected, tell them — briefly, in their own language — to click the
  **Apply text edits** / **Textänderungen anwenden** button just above the message box (its label follows
  the app language) and choose where to save the edited copy. Do not rewrite the document yourself in the
  chat, do not walk them through a manual procedure, and never run the tool yourself; it runs only when
  the user starts it and **always asks before saving**.
- **Only the exact changes are applied, only where the text is found.** The tool makes the find-and-replace
  edits the user described — it **never regenerates or rephrases** the document, so it cannot invent or
  reword anything. Every place the requested text is not found verbatim is left unchanged and reported as
  skipped; everything the user did not ask to change stays identical, character for character.
- **A running model is required.** The tool asks the model only to *locate* the exact substrings to change;
  the app then splices them. With no model running it cannot find the text, so it says so and does nothing.
- After it runs, remind the user to **review the saved copy themselves** before sharing it, report only
  the counts the tool gives (e.g. "3 changes applied"). You may name the user's own find/replace terms
  when confirming, but never quote any other document text back. Answer in the user's language.

The tool runs entirely on this device. It reads the **whole** document, asks the running model to locate
the exact find-and-replace edits the user described, verifies each one against the document, and splices
in only the verified changes — leaving every other character untouched. It runs only when the user starts
it, always asking before the edited copy is written where the user chooses. A Word document (`.docx`) is
saved as a `.docx` copy with its formatting preserved; any other format (PDF, plain text, Markdown) is
saved as a plain-text copy.
