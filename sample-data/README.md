# Sample data

Small, non-sensitive documents used for development, demos, and tests of the document/RAG pipeline.
Keep these tiny and license-clean. Real user documents must never be committed.

- `documents/` — sample files to import from the **Documents** screen:
  - `sample-policy.txt` — plain text.
  - `sample-notes.md` — Markdown with headings (ingested one segment per section).
  - `sample-table.csv` — CSV (rows linearised into `header: value` lines).

Supported import formats (Phase 4 parsers): **TXT, Markdown, PDF, DOCX, CSV**. PDF and DOCX
are not committed as binary fixtures — the parser tests synthesise minimal valid PDF/DOCX
files in code (`apps/desktop/tests/helpers/fixtures.ts`) so coverage stays fully offline.

## Try it

1. Open **Documents** → **Import files**, pick one or more files above (no model needs to be
   running to import).
2. Watch each file move through `queued → extracting → chunking → embedding → indexed`.
   (Vectors are written by the active embedder — the deterministic mock when no real embedding
   model is installed, the real E5 when it is.)
3. To ask questions about them, start a chat model on the **Models** screen first (with no
   weights present, **Start mock runtime** works in developer mode).
