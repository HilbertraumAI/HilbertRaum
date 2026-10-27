# ZIM test fixtures

Provenance for every file in this directory (PR #294 → issue #301, Phase 1 / finding H1, T02-b).

- **article.html** — hand-written Parsoid/mwoffliner-shaped article ("Kontaktverfahren"), German
  Wikipedia shape, with test-authored German text (no copied Wikipedia prose), written for
  `zim-html.test.ts`'s core contract (head noise, mw-ref sups,
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

- **zimit-code-table-page.html** — synthetic fixture written for HilbertRaum on 2026-10-13
  (issue #627); models the shape a zimit/warc2zim capture of a code-tutorial site was measured
  to have: every code block in a `<td class="code">` cell beside a `<td class="docs">` cell of
  a classless `<table>`, highlighted one `<span class="line">` per line, and the page ending in
  a `<p class="footer">`. No third-party text; license: GPL-3.0-or-later.

- **dewiki-table-math-leak.html** — synthetic fixture written for HilbertRaum on 2026-09-19
  (issue #490); models a German-Wikipedia mwoffliner article whose MathML `<math>` element
  (presentation MathML plus a raw TeX `<annotation>`) lands inside a kept data-table cell.
  Short generic domain terms only, no copyrighted prose; license: GPL-3.0-or-later.
- **dewiki-table-style-leak.html** — synthetic fixture written for HilbertRaum on 2026-09-19
  (issue #485); models a TemplateStyles `<style>` block that MediaWiki emits inline, right before
  a footnote marker, inside a kept data-table cell. Short generic domain terms and functional CSS
  declarations only, no copyrighted prose; license: GPL-3.0-or-later.
- **quality-questions-de.json** — the German retrieval-quality question set for the manual
  smoke (`tests/manual/zim-real.test.ts`), measured 2026-09-06 against the real
  `wikipedia_de_climate-change_nopic_2026-07` pack (header UUID `d30cd05e-b9ae-b7c2-52d7-c2b308e56554`,
  D-Z18); its own `$comment` records the measurement and how each field is read. It holds
  question wording and article titles, not article text.

All seven synthetic files are attributed in their own first-line HTML comment (producer modelled,
no third-party content, license) and are written entirely for this repository from public
knowledge of each producer's output shape — no copied Wikipedia, MDN, Stack Exchange or other
third-party prose.
