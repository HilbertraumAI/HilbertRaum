# Chat & history — design-review screenshots

Captured 2026-06-13 from the **built** app (Electron, mock runtime, UI forced to English)
for a design discussion of the chat area and conversation history. The conversations are
mocked: realistic office/privacy-domain Q&A seeded directly into the workspace DB (markdown
answers, document-Q&A citations, multi-turn, a date-grouped history spanning
Today / Yesterday / Last 7 days / Earlier). Viewport 1380×880.

> These are mockups for design feedback only — not real model output. The mock runtime echoes
> a fixed reply, so the rich answers were inserted into the DB to exercise the real renderer
> (Markdown via react-markdown, the `▸ Sources (N)` disclosure, the date-grouping logic).

## Light theme

| Shot | What it shows |
|---|---|
| `01-light-chat-conversation.png` | A multi-turn plain chat. Markdown answer (bold, bullets, inline code), full window incl. sidebar + composer (Answer detail: Balanced). |
| `02-light-history-grouped.png` | Same view — focus on the conversation list grouped by recency (Today / Yesterday / Last 7 days / Earlier), `DOC` badges on document-Q&A threads. |
| `03-light-document-qa-sources-expanded.png` | Document Q&A ("Ask my documents" mode) with `[S1]`/`[S2]` inline citations and the **Sources (2)** disclosure expanded into per-source cards (title · page · cited snippet). |
| `04-light-markdown-table-answer.png` | A GFM **table** answer (board-meeting summary) — tests table rendering + collapsed Sources. |
| `05-light-history-search.png` | The conversation-search state: the list swaps to full-text results with the matched term highlighted. |
| `06-light-message-actions-hover.png` | The per-message action row on hover (Copy / Save). |

## Dark theme

| Shot | What it shows |
|---|---|
| `07-dark-chat-conversation.png` | Dark equivalent of `01`. |
| `08-dark-history-grouped.png` | Dark equivalent of `02`. |
| `09-dark-document-qa-sources-expanded.png` | Dark equivalent of `03`. |
| `10-dark-markdown-table-answer.png` | Dark equivalent of `04`. |
| `11-dark-history-search.png` | Dark equivalent of `05`. |

## How these were generated

Playwright `_electron` walk against the built bundle, per the project's eyeball recipe:
`%TEMP%\paid-eyeball\walk-design-chat.mjs`. The seed step opens a second `node:sqlite`
connection to `<root>/workspace/hilbertraum.sqlite` (WAL) and inserts conversations/messages
with backdated `updated_at` to populate the history groups. To regenerate, re-run that script.
