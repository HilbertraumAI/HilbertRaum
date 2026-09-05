# ZIM test fixtures

Provenance for every file in this directory (PR #294 → issue #301, Phase 1 / finding H1, T02-b).

- **article.html** — hand-trimmed Parsoid/mwoffliner article ("Kontaktverfahren"), German
  Wikipedia shape, written for `zim-html.test.ts`'s core contract (head noise, mw-ref sups,
  MathML with alttext + fallback image, nested tables, figures with captions, lists, numeric
  and named entities). Pre-existing (P0).
- **no-arm-retrieval-master-bfdb514a.json** — pre-change no-arm retrieval fixture (review L6),
  captured from `master` `bfdb514a` on 2026-09-05; pins the byte-identical no-arm baseline used
  by `zim-arm.test.ts`. Pre-existing (P0).
- **required-checks.json** — the wave's required-check inventory (T01–T20); validated by
  `repo-hygiene.test.ts`. Pre-existing (P0).
- **parsoid-datamw.html** — synthetic fixture written for HilbertRaum on 2026-09-05; models the
  Parsoid/mwoffliner HTML DOM output shape (data-mw JSON payloads, `mw:Extension/math` and
  `mw:Extension/ref` markup, `mw-heading` wrapper divs, TemplateStyles `<style
  data-mw-deduplicate>` blocks). No third-party text; license: GPL-3.0-or-later. Added Phase 1
  (T02-b, finding H1).
- **zimit-page.html** — synthetic fixture written for HilbertRaum on 2026-09-05; models the
  zimit/warc2zim web-archive-replay HTML shape (an inlined wombat.js URL-rewriting shim,
  warc2zim's raw capture of crawled response bodies). No third-party text; license:
  GPL-3.0-or-later. Added Phase 1 (T02-b, finding H1).
- **devdocs-page.html** — synthetic fixture written for HilbertRaum on 2026-09-05; models the
  DevDocs scraper ZIM HTML shape (`_sidebar` navigation, `_page`-wrapped entry content, an
  `_attribution` footer line per entry). No third-party text; license: GPL-3.0-or-later. Added
  Phase 1 (T02-b, finding H1).
- **stackexchange-question.html** — synthetic fixture written for HilbertRaum on 2026-09-05;
  models the Kiwix Stack Exchange "sotoki" ZIM per-question page shape (a question block, an
  accepted-answer block, vote/user-info tables). No third-party text; license:
  GPL-3.0-or-later. Added Phase 1 (T02-b, finding H1).

All four synthetic files are attributed in their own first-line HTML comment (producer modelled,
no third-party content, license) and are written entirely for this repository from public
knowledge of each producer's output shape — no copied Wikipedia, MDN, Stack Exchange or other
third-party prose.
