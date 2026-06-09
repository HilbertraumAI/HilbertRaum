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

1. Start a model on the **Models** screen (mock runtime is fine).
2. Open **Documents** → **Import files**, pick one or more files above.
3. Watch each file move through `queued → extracting → chunking → embedding → indexed`.
   (Embeddings are a pass-through until Phase 5; documents reach `indexed` without vectors.)
