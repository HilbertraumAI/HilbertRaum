# Chat & history — design-polish screenshots (AFTER)

Captured 2026-06-13 from the **built** app after the Chat-UI polish pass (branch
`chat-ui-polish`). Same mocked conversations as the BEFORE set
([`../chat-screenshots/`](../chat-screenshots/README.md)) so the two folders are a direct
before/after comparison. Mock runtime, UI forced to English; viewport 1380×880 unless noted.

> Mockups for design feedback only — not real model output (the rich answers were seeded into
> the workspace DB to exercise the real renderer).

## What changed (summary)

- **Compact nav rail** (~80px, icon + short label, tooltips) — the conversation is now the
  centre of gravity, not the chrome. Active state is a soft neutral fill, not heavy blue.
- **Quieter privacy signal** — the duplicate lower-left "Local · Offline" badge was removed;
  one signal remains in the chat header.
- **Calmer history rows** — soft selected *fill* (the blue selection outline that read like
  keyboard focus is gone; the accent ring is now focus-only); structured rows with a quiet
  "📄 Documents" metadata line replacing the loud filled `DOC` badge.
- **Softer messages** — user turns are a neutral tinted surface (no strong blue border /
  "focused input" look); assistant turns are borderless and read as text, not nested cards;
  uppercase `USER`/`ASSISTANT` chips became quiet **You** / **HilbertRaum** labels.
- **Integrated composer** — the Send/Ask button now lives inside one bordered composer shell
  that takes the focus ring.
- **Truthful scope copy** — "Using all 0 documents" is gone; with no documents the footer
  reads "📄 No documents yet · Add documents".
- **Search mode** — a contextual "Results for '…'" header + clearer 2-line snippets.

## Light theme

| Shot | What it shows |
|---|---|
| `01-light-chat-conversation.png` | Multi-turn chat: rail, history, soft user bubbles, borderless assistant turns, integrated composer. |
| `02-light-history-grouped.png` | Date-grouped history (Today / Yesterday / Last 7 days / Earlier), quiet "📄 Documents" meta on doc-Q&A rows. |
| `03-light-document-qa-sources-expanded.png` | Document Q&A with `[S1]`/`[S2]` citations and the expanded Sources cards; note the truthful "No documents yet · Add documents" footer. |
| `04-light-markdown-table-answer.png` | GFM table answer. |
| `05-light-history-search.png` | Search mode: "Results for 'liability'" header + highlighted 2-line snippets. |
| `06-light-message-actions-hover.png` | Per-message action row (Copy / Save) on hover. |
| `12-light-history-collapsed.png` | History collapsed via the « handle; the » reopen handle sits in the chat header. |
| `13-light-responsive-1024.png` | 1024px — history auto-collapses (≤1150px), transcript spans the width, no overflow. |
| `14-light-responsive-1600.png` | 1600px — history visible, transcript still the centred canvas. |

## Dark theme

| Shot | What it shows |
|---|---|
| `07-dark-chat-conversation.png` | Dark equivalent of `01`. |
| `08-dark-history-grouped.png` | Dark equivalent of `02`. |
| `09-dark-document-qa-sources-expanded.png` | Dark equivalent of `03`. |
| `10-dark-markdown-table-answer.png` | Dark equivalent of `04`. |
| `11-dark-history-search.png` | Dark equivalent of `05`. |

## Intentional non-changes

- **History was already collapsible** — this pass refined the collapsed handle, header
  toggle, and added responsive auto-collapse; it did not reimplement collapse.
- **No backend / data-contract changes.** All edits are renderer + i18n string catalogs.

## Regenerate

Playwright `_electron` walk: `%TEMP%\paid-eyeball\walk-design-chat-after.mjs` (mirrors the
BEFORE walk; seeds via a second `node:sqlite` connection to the workspace DB).
