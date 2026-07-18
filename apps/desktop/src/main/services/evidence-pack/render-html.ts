import { t, tCount, type MessageKey, type UiLanguage } from '../../../shared/i18n'
import { CITE_CODE_SPLIT_RE, CITE_MARKER_RE } from '../../../shared/citation-markers'
import type { ReviewDecision } from '../../../shared/types'
import type { EvidencePackModel, EvidencePackSource } from './pack-model'

// Evidence-pack HTML renderer (EP-1 plan §8.2, pure): ONE fixed local template turning an
// `EvidencePackModel` into a SELF-CONTAINED document — zero scripts, zero remote
// references, embedded styles only, system font stack only. Deterministic: same model ⇒
// byte-identical output (no Date.now, no randomness, no locale-dependent formatting — the
// only varying bytes come from the model's injected packId/generatedAt, which the golden
// tests normalize).
//
// PRINT CONTRACT (plan §4 D-1 — Phase 6 feeds THIS SAME HTML to `webContents.printToPDF`
// on a hidden window; keep these properties or Phase 6 breaks):
//  - `@page { size: A4; margin: … }` drives the page geometry (Phase 6 passes
//    `preferCSSPageSize: true`).
//  - Semantic heading hierarchy h1 (pack title) → h2 (the eight section heads) → h3
//    (subsections) IS the PDF bookmark tree (`generateDocumentOutline: true`).
//  - `break-inside: avoid` on evidence cards (.pack-item/.pack-source), warning blocks
//    (.warning) and table rows is the page-break control.
//  - System font stack ONLY — `@font-face` in printed content breaks printToPDF header/
//    footer templates, and custom fonts are a remote-ref risk anyway. No `url(...)`, no
//    `@import` anywhere in the stylesheet.
//  - Warning blocks are grayscale-readable (border + ⚠ glyph + text — spec §17.1: never
//    color-only).
//
// Localization: EN or DE from the model's language option, resolved AT GENERATION through
// the shared catalogs (`packExport.*` + reused review/chat keys) — the persisted pack is a
// snapshot and is never re-localized later (plan §8.2). Inline `[S{n}]` machine markers in
// the frozen answer/item text localize exactly like the chat display (shared regexes from
// `shared/citation-markers.ts`; DE renders `[Q{n}]`, code spans/fences stay literal).
//
// Injection stance (spec §29.4): EVERY string that can carry stored content — answer,
// question, titles, snippets, notes, labels, skill/model names — passes through
// `escapeHtml` exactly once, AFTER i18n interpolation. Anchors/ids are index-derived
// (`src-1`, `item-3`), never content-derived, so hostile keys/titles cannot break out of
// an attribute.

/**
 * Escape a string for HTML text AND attribute contexts — the `xmlEscape` shape
 * (docx-rewrite.ts) widened to quotes, because this renderer interpolates into both
 * element bodies and quoted attributes. The five characters cover every breakout class:
 * `&` (entity smuggling), `<`/`>` (tag injection), `"`/`'` (attribute escape).
 */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

/**
 * Deterministic, locale-independent timestamp for pack display: `YYYY-MM-DD HH:MM UTC`
 * from the ISO string's UTC parts. `toLocaleString` would vary with the ICU build/host —
 * a golden-tested export cannot depend on either. Only EXPLICITLY-ZONED input is formatted
 * (every real persisted stamp is `toISOString()` = Z-suffixed): a zone-less string
 * (hand-edited/corrupt snapshot) would parse host-local — TZ-dependent — and stamping UTC
 * onto it would invent a zone that was never recorded, so it renders VERBATIM instead
 * (the formatWhen precedent: never invent a date). Unparseable input also renders verbatim.
 */
export function formatPackTimestamp(iso: string): string {
  if (!/(?:[zZ]|[+-]\d{2}:?\d{2})$/.test(iso)) return iso
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`
}

/** Rewrite inline `[S{n}]` PROSE markers to the pack language's display marker (DE `[Q{n}]`),
 *  skipping code spans/fences — the displayMap `localizeCitationMarkers` semantics via the
 *  same shared regexes. Runs on RAW text (before escaping). */
function localizeMarkers(lang: UiLanguage, raw: string): string {
  if (!raw.includes('[S')) return raw
  const parts = raw.split(CITE_CODE_SPLIT_RE)
  for (let i = 0; i < parts.length; i += 2) {
    parts[i] = parts[i]!.replace(CITE_MARKER_RE, (_m, n: string) => `[${t(lang, 'chat.sources.marker', { n })}]`)
  }
  return parts.join('')
}

/** Localize a stored `S{n}` machine label for display (`formatCitationLabel` semantics). */
function localizeLabel(lang: UiLanguage, label: string): string {
  const m = /^S(\d+)$/.exec(label)
  return m ? t(lang, 'chat.sources.marker', { n: m[1]! }) : label
}

const DECISION_KEY: Record<ReviewDecision, MessageKey> = {
  supported: 'review.decision.supported',
  partly_supported: 'review.decision.partly_supported',
  not_supported: 'review.decision.not_supported',
  follow_up: 'review.decision.follow_up',
  not_reviewed: 'review.decision.not_reviewed',
  not_applicable: 'review.decision.not_applicable'
}

const RELATION_KEY: Record<'supports' | 'qualifies' | 'contradicts' | 'context', MessageKey> = {
  supports: 'review.relation.supports',
  qualifies: 'review.relation.qualifies',
  contradicts: 'review.relation.contradicts',
  context: 'review.relation.context'
}

const KIND_KEY: Record<EvidencePackSource['kind'], MessageKey> = {
  direct_excerpt: 'packExport.evidence.kindDirect',
  whole_document_provenance: 'packExport.evidence.kindProvenance',
  structured_record: 'packExport.evidence.kindStructured'
}

// The embedded stylesheet — see the PRINT CONTRACT in the module header before changing.
const PACK_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body {
  margin: 0 auto; padding: 34px 42px 60px; max-width: 820px;
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 11pt; line-height: 1.5; color: #1a1a1a; background: #ffffff;
}
.mono { font-family: ui-monospace, "Cascadia Mono", Consolas, Menlo, monospace; font-size: 0.9em; word-break: break-all; }
h1 { font-size: 1.65em; line-height: 1.25; margin: 0.15em 0 0.45em; }
h2 { font-size: 1.25em; margin: 1.7em 0 0.5em; padding-top: 0.85em; border-top: 1px solid #bbbbbb; break-after: avoid; }
h3 { font-size: 1.02em; margin: 1em 0 0.3em; break-after: avoid; }
p { margin: 0.4em 0; }
.kicker { margin: 0; text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.78em; color: #444444; }
.hint { color: #444444; font-size: 0.92em; }
dl.meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 16px; margin: 0.6em 0; }
dl.meta dt { font-weight: 600; }
dl.meta dd { margin: 0; }
.pack-text { white-space: pre-wrap; overflow-wrap: anywhere; background: #f7f7f7; border: 1px solid #dddddd; border-radius: 4px; padding: 10px 12px; }
.warning { border: 1px solid #555555; border-left: 6px solid #555555; background: #f2f2f2; padding: 8px 12px; margin: 0.8em 0; break-inside: avoid; }
.warn-icon { font-weight: 700; margin-right: 6px; }
ol.pack-items, ol.pack-sources { list-style: none; padding: 0; margin: 0.6em 0; }
.pack-item, .pack-source { border: 1px solid #cccccc; border-radius: 4px; padding: 10px 12px; margin: 0 0 10px; break-inside: avoid; }
.pack-item-no { font-weight: 600; color: #444444; font-size: 0.85em; }
.pack-links { margin: 0.3em 0 0; padding-left: 1.2em; }
blockquote.excerpt { margin: 0.4em 0 0; padding: 6px 10px; border-left: 3px solid #888888; background: #f7f7f7; white-space: pre-wrap; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; margin: 0.6em 0; }
th, td { border: 1px solid #999999; padding: 5px 8px; text-align: left; vertical-align: top; }
th { background: #efefef; }
tr { break-inside: avoid; }
a { color: #1a1a1a; }
footer.pack-foot { margin-top: 2.5em; border-top: 1px solid #bbbbbb; padding-top: 0.6em; font-size: 0.85em; color: #444444; }
@page { size: A4; margin: 18mm 16mm; }
@media print {
  body { max-width: none; padding: 0; font-size: 10.5pt; }
  a { text-decoration: none; }
}
`.trim()

/**
 * Render the fixed pack template (plan §8.2). Pure and deterministic; every content string
 * is escaped exactly once (see the module-header injection stance).
 */
export function renderEvidencePackHtml(model: EvidencePackModel): string {
  const lang = model.language
  const esc = escapeHtml
  /** A fully-localized, fully-escaped catalog line (params interpolate BEFORE the escape,
   *  so content passed as a param is covered by the same single pass). */
  const s = (key: MessageKey, params?: Record<string, string | number>): string =>
    esc(t(lang, key, params))
  const n = (base: Parameters<typeof tCount>[1], count: number): string =>
    esc(tCount(lang, base, count))
  const unavailable = s('review.summary.unavailable')
  const when = (iso: string | null): string => (iso ? esc(formatPackTimestamp(iso)) : unavailable)
  const statusLabel = s(model.status === 'ready' ? 'review.status.ready' : 'review.status.draft')
  // P6 honesty: the ONE model-format-dependent line in the whole template. A PDF must
  // never self-describe as "Self-contained HTML" on the cover/integrity sections a
  // verifier reads next to the hash note — it states it is a print of this same template.
  const formatLine = s(
    model.format === 'pdf' ? 'packExport.meta.formatValuePdf' : 'packExport.meta.formatValue',
    { version: model.schemaVersion }
  )
  const out: string[] = []
  const push = (line: string): void => {
    out.push(line)
  }
  const warning = (text: string): void => {
    push(`<div class="warning"><span class="warn-icon" aria-hidden="true">⚠</span>${text}</div>`)
  }

  push('<!DOCTYPE html>')
  push(`<html lang="${lang}">`)
  push('<head>')
  push('<meta charset="utf-8">')
  push('<meta name="viewport" content="width=device-width, initial-scale=1">')
  push(`<title>${esc(model.title)} — ${s('packExport.docTitle')}</title>`)
  push(`<style>${PACK_CSS}</style>`)
  push('</head>')
  push('<body>')

  // ---- 1. Cover (§16.1.1) ----------------------------------------------------------
  push('<header>')
  push(`<p class="kicker">${s('packExport.docTitle')}</p>`)
  push(`<h1>${esc(model.title)}</h1>`)
  push('<dl class="meta">')
  push(`<dt>${s('packExport.meta.packId')}</dt><dd class="mono">${esc(model.packId)}</dd>`)
  push(`<dt>${s('packExport.meta.generatedAt')}</dt><dd>${when(model.generatedAt)}</dd>`)
  push(`<dt>${s('packExport.meta.status')}</dt><dd>${statusLabel}</dd>`)
  push(`<dt>${s('packExport.meta.format')}</dt><dd>${formatLine}</dd>`)
  push('</dl>')
  push(`<p class="hint">${s('packExport.privacy')}</p>`)
  // P4 (spec §21.3): an outdated review exports with a PROMINENT snapshot warning — on the
  // cover, before anything else, with the acknowledge stamp when one exists (§28.6).
  if (model.outdated) {
    warning(s('packExport.coverage.outdated'))
    if (model.freshness?.acknowledgedAt) {
      push(
        `<p class="hint">${s('packExport.coverage.acknowledged', { date: formatPackTimestamp(model.freshness.acknowledgedAt) })}</p>`
      )
    }
  }
  warning(`${s('packExport.disclaimer')} ${s('packExport.support')}`)
  push('</header>')
  push('<main>')

  // ---- 2. Question and answer (§16.1.2) --------------------------------------------
  push('<section id="qa">')
  push(`<h2>${s('packExport.section.qa')}</h2>`)
  push(`<h3>${s('packExport.qa.question')}</h3>`)
  if (model.question) {
    push(`<div class="pack-text">${esc(model.question)}</div>`)
  } else {
    push(`<p class="hint">${s('packExport.qa.noQuestion')}</p>`)
  }
  push(`<h3>${s('packExport.qa.answer')}</h3>`)
  push(`<p class="hint">${s('packExport.qa.verbatim')}</p>`)
  push(`<div class="pack-text">${esc(localizeMarkers(lang, model.answer))}</div>`)
  push('</section>')

  // ---- 3. Review summary (§16.1.3) -------------------------------------------------
  push('<section id="summary">')
  push(`<h2>${s('packExport.section.summary')}</h2>`)
  push('<dl class="meta">')
  push(
    `<dt>${s('packExport.summary.reviewer')}</dt><dd>${model.summary.reviewerLabel ? esc(model.summary.reviewerLabel) : unavailable}</dd>`
  )
  push(`<dt>${s('packExport.summary.created')}</dt><dd>${when(model.summary.createdAt)}</dd>`)
  push(`<dt>${s('packExport.summary.updated')}</dt><dd>${when(model.summary.updatedAt)}</dd>`)
  if (model.summary.completedAt) {
    push(`<dt>${s('packExport.summary.completed')}</dt><dd>${when(model.summary.completedAt)}</dd>`)
  }
  if (model.summary.lastExportedAt) {
    push(
      `<dt>${s('packExport.summary.lastExported')}</dt><dd>${when(model.summary.lastExportedAt)}</dd>`
    )
  }
  push('</dl>')
  push(`<h3>${s('packExport.summary.decisions')}</h3>`)
  push('<ul>')
  for (const { decision, count } of model.summary.decisionCounts) {
    push(`<li>${s(DECISION_KEY[decision])}: ${count}</li>`)
  }
  push('</ul>')
  push(
    `<p>${s('packExport.summary.progress', { decided: model.summary.gate.decidedTotal, required: model.summary.gate.requiredTotal })}</p>`
  )
  if (model.summary.followUps > 0) {
    warning(s('packExport.summary.followUps', { count: model.summary.followUps }))
  }
  push(`<h3>${s('packExport.summary.generalNote')}</h3>`)
  if (!model.options.includeReviewerNotes) {
    push(`<p class="hint">${s('packExport.excluded.notes')}</p>`)
  } else if (model.summary.generalNote) {
    push(`<div class="pack-text">${esc(model.summary.generalNote)}</div>`)
  } else {
    push(`<p class="hint">${s('packExport.summary.noGeneralNote')}</p>`)
  }
  push('</section>')

  // ---- 4. Item-by-item review (§16.1.4) --------------------------------------------
  push('<section id="items">')
  push(`<h2>${s('packExport.section.items')}</h2>`)
  push('<ol class="pack-items">')
  for (const item of model.items) {
    // FIX-7: number by the CARRIED ordinal (creation position), not the render index —
    // with unreviewed items excluded, "Item 3" in the pack must still be item 3 of the
    // review workspace (the excluded-count notice below accounts for the holes).
    const itemNo = item.ordinal + 1
    push(`<li class="pack-item" id="item-${itemNo}">`)
    const kindTag = item.heading
      ? ` · ${s('packExport.item.heading')}`
      : item.kind === 'selection'
        ? ` · ${s('packExport.item.selection')}`
        : ''
    push(`<p class="pack-item-no">${s('packExport.item.number', { n: itemNo })}${kindTag}</p>`)
    push(`<div class="pack-text">${esc(localizeMarkers(lang, item.text))}</div>`)
    push(`<p><strong>${s('packExport.item.decision')}:</strong> ${s(DECISION_KEY[item.decision])}</p>`)
    if (model.options.includeReviewerNotes && item.note) {
      push(`<p><strong>${s('packExport.item.note')}:</strong> ${esc(item.note)}</p>`)
    }
    if (item.links.length > 0) {
      push(`<p><strong>${s('packExport.item.evidence')}:</strong></p>`)
      push('<ul class="pack-links">')
      for (const link of item.links) {
        const marker = link.machineLabel ? `[${esc(localizeLabel(lang, link.machineLabel))}] ` : ''
        const label = link.sourceIndex
          ? `<a href="#src-${link.sourceIndex}">${marker}${esc(link.label)}</a>`
          : `${marker}${esc(link.label)}`
        const origin = s(link.origin === 'answer_marker' ? 'review.link.cited' : 'review.link.reviewer')
        const relation = link.relation ? ` · ${s(RELATION_KEY[link.relation])}` : ''
        push(`<li>${label} · ${origin}${relation}</li>`)
      }
      push('</ul>')
    } else if (!item.heading) {
      push(`<p class="hint">${s('packExport.item.noEvidence')}</p>`)
    }
    push('</li>')
  }
  push('</ol>')
  if (model.excludedItemCount > 0) {
    push(`<p class="hint">${n('packExport.items.unreviewedExcluded', model.excludedItemCount)}</p>`)
  }
  push('</section>')

  // ---- 5. Evidence register (§16.1.5) ----------------------------------------------
  push('<section id="evidence">')
  push(`<h2>${s('packExport.section.evidence')}</h2>`)
  if (!model.options.includeSourceExcerpts) {
    push(`<p class="hint">${s('packExport.excluded.excerpts')}</p>`)
  }
  if (model.evidence.length === 0) {
    push(`<p class="hint">${s('packExport.evidence.none')}</p>`)
  }
  push('<ol class="pack-sources">')
  for (const src of model.evidence) {
    push(`<li class="pack-source" id="src-${src.index}">`)
    const marker = src.machineLabel ? `[${esc(localizeLabel(lang, src.machineLabel))}] ` : ''
    push(`<h3>${marker}${esc(src.documentTitle)}</h3>`)
    push(`<p class="hint">${s(KIND_KEY[src.kind])}</p>`)
    const where: string[] = []
    if (src.pageNumber != null) where.push(s('packExport.evidence.page', { n: src.pageNumber }))
    if (src.sectionLabel) where.push(`${s('packExport.evidence.sectionLabel')}: ${esc(src.sectionLabel)}`)
    if (where.length > 0) push(`<p>${where.join(' · ')}</p>`)
    if (src.identity === 'unresolved') {
      warning(s('packExport.evidence.identityUnresolved'))
    } else if (src.availabilityAtCreation === 'missing') {
      warning(s('packExport.evidence.missingAtCreation'))
    }
    // P4 per-card at-export states (spec §15.4/§15.5): change and NEW deletion warn on the
    // card itself; creation-time missing kept its own warning above.
    if (src.currentState === 'changed') {
      warning(s('packExport.evidence.changedSince'))
    } else if (src.currentState === 'missing' && src.availabilityAtCreation !== 'missing') {
      warning(s('packExport.evidence.missingNow'))
    }
    if (model.options.includeSourceExcerpts) {
      if (src.snippet) {
        push(`<p class="hint">${s('packExport.evidence.excerpt')}:</p>`)
        push(`<blockquote class="excerpt">${esc(src.snippet)}</blockquote>`)
      } else {
        push(`<p class="hint">${s('packExport.evidence.noExcerpt')}</p>`)
      }
    }
    if (src.relations.length > 0) {
      push(
        `<p>${s('packExport.evidence.relations')}: ${src.relations.map((r) => s(RELATION_KEY[r])).join(', ')}</p>`
      )
    }
    push('</li>')
  }
  push('</ol>')
  push('</section>')

  // ---- 6. Coverage and limitations (§16.1.6) ---------------------------------------
  push('<section id="coverage">')
  push(`<h2>${s('packExport.section.coverage')}</h2>`)
  const modeKey: MessageKey =
    model.honesty.paneMode === 'relevance'
      ? 'packExport.coverage.modeRelevance'
      : model.honesty.paneMode === 'structured'
        ? 'packExport.coverage.modeStructured'
        : 'packExport.coverage.modeWholeDoc'
  push(`<p>${s(modeKey)}</p>`)
  if (model.honesty.chunksCovered != null && model.honesty.chunksTotal != null) {
    push(
      `<p>${s('packExport.coverage.inputStatement', { covered: model.honesty.chunksCovered, total: model.honesty.chunksTotal })}</p>`
    )
  } else {
    push(`<p class="hint">${s('packExport.coverage.inputUnknown')}</p>`)
  }
  if (model.honesty.answerTruncated === true) {
    // Reused review copy — the identical §15.2 statement the summary view shows.
    warning(s('review.summary.truncated'))
  } else {
    push(`<p class="hint">${s('packExport.coverage.noTruncationRecord')}</p>`)
  }
  if (model.honesty.unresolvedSources > 0) {
    warning(n('review.summary.sourcesUnresolved', model.honesty.unresolvedSources))
  }
  if (model.honesty.missingSources > 0) {
    warning(n('review.summary.sourcesMissing', model.honesty.missingSources))
  }
  // P4 (spec §28.6/§28.7): with an injected at-export verdict the pack RECORDS the
  // re-check and every mismatch; without one it keeps the honest P3 "not re-verified"
  // note. Warnings are drift-shaped: answer/coverage drift, changed sources, NEW
  // deletions (creation-time missing already warned above).
  const fresh = model.freshness
  if (fresh) {
    if (fresh.answerChanged) warning(s('packExport.coverage.answerChangedNow'))
    if (fresh.coverageChanged) warning(s('packExport.coverage.coverageChangedNow'))
    if (fresh.sourcesChanged > 0) {
      warning(n('packExport.coverage.sourcesChangedNow', fresh.sourcesChanged))
    }
    if (fresh.sourcesMissingNow > 0) {
      warning(n('packExport.coverage.sourcesMissingNow', fresh.sourcesMissingNow))
    }
    if (fresh.outdated && fresh.acknowledgedAt) {
      push(
        `<p>${s('packExport.coverage.acknowledged', { date: formatPackTimestamp(fresh.acknowledgedAt) })}</p>`
      )
    }
    push(`<p class="hint">${s('packExport.coverage.freshnessChecked')}</p>`)
  } else {
    push(`<p class="hint">${s('packExport.coverage.freshnessNote')}</p>`)
  }
  push('</section>')

  // ---- 7. Source register (§16.1.7) ------------------------------------------------
  push('<section id="sources">')
  push(`<h2>${s('packExport.section.sources')}</h2>`)
  if (model.evidence.length === 0) {
    push(`<p class="hint">${s('packExport.evidence.none')}</p>`)
  } else {
    // P4 (spec §16.1.7): with an injected verdict the availability column reports the AT
    // EXPORT state (available / changed-since-review / missing / cannot-verify); without
    // one it stays the honest at-creation record (the P3 shape + the not-re-verified note).
    const atExport = model.freshness != null
    push('<table>')
    push(
      `<thead><tr><th>${s('packExport.sources.colTitle')}</th><th>${s('packExport.sources.colType')}</th><th>${s('packExport.sources.colSha')}</th><th>${s(atExport ? 'packExport.sources.colAvailabilityExport' : 'packExport.sources.colAvailability')}</th></tr></thead>`
    )
    push('<tbody>')
    for (const src of model.evidence) {
      const availability = atExport
        ? src.currentState === 'unchanged'
          ? s('packExport.sources.availabilityAvailable')
          : src.currentState === 'changed'
            ? s('packExport.sources.availabilityChanged')
            : src.currentState === 'missing'
              ? s('packExport.sources.availabilityMissing')
              : s('packExport.sources.availabilityUnknown')
        : src.identity === 'unresolved'
          ? s('packExport.sources.availabilityUnknown')
          : src.availabilityAtCreation === 'missing'
            ? s('packExport.sources.availabilityMissing')
            : src.availabilityAtCreation === 'available'
              ? s('packExport.sources.availabilityAvailable')
              : unavailable
      const sha = !model.options.includeDocumentHashes
        ? s('packExport.sources.hashExcluded')
        : src.documentSha256
          ? `<span class="mono">${esc(src.documentSha256)}</span>`
          : unavailable
      push(
        `<tr><td><a href="#src-${src.index}">${esc(src.documentTitle)}</a></td><td>${src.mimeType ? esc(src.mimeType) : unavailable}</td><td>${sha}</td><td>${availability}</td></tr>`
      )
    }
    push('</tbody>')
    push('</table>')
  }
  push(`<p class="hint">${s('packExport.sources.pathNote')}</p>`)
  push('</section>')

  // ---- 8. Generation details (§16.1.8) ---------------------------------------------
  push('<section id="generation">')
  push(`<h2>${s('packExport.section.generation')}</h2>`)
  const gen = model.generation
  push('<dl class="meta">')
  push(
    `<dt>${s('packExport.generation.model')}</dt><dd>${gen?.modelDisplayName ? esc(gen.modelDisplayName) : unavailable}</dd>`
  )
  push(
    `<dt>${s('packExport.generation.modelId')}</dt><dd>${gen?.modelId ? `<span class="mono">${esc(gen.modelId)}</span>` : unavailable}</dd>`
  )
  if (gen?.skillDisplayName || gen?.skillId) {
    push(
      `<dt>${s('packExport.generation.skill')}</dt><dd>${esc(gen.skillDisplayName ?? gen.skillId ?? '')}</dd>`
    )
  }
  push(`<dt>${s('packExport.generation.generatedAt')}</dt><dd>${gen?.generatedAt ? when(gen.generatedAt) : unavailable}</dd>`)
  push(`<dt>${s('packExport.generation.appVersion')}</dt><dd>${gen?.appVersion ? esc(gen.appVersion) : unavailable}</dd>`)
  push(`<dt>${s('packExport.generation.exportedAt')}</dt><dd>${when(model.generatedAt)}</dd>`)
  push('</dl>')
  if (model.options.includeTechnicalDetails) {
    push(`<h3>${s('packExport.generation.technical')}</h3>`)
    push('<dl class="meta">')
    push(
      `<dt>${s('packExport.generation.techMode')}</dt><dd>${model.honesty.answerModeRaw ? `<span class="mono">${esc(model.honesty.answerModeRaw)}</span>` : unavailable}</dd>`
    )
    push(
      `<dt>${s('packExport.generation.techCoverage')}</dt><dd>${
        model.honesty.chunksCovered != null && model.honesty.chunksTotal != null
          ? `${model.honesty.chunksCovered} / ${model.honesty.chunksTotal}`
          : unavailable
      }</dd>`
    )
    const chunkIds = model.evidence
      .map((srcEntry) => srcEntry.key)
      .filter((k) => k.length > 0)
    push(
      `<dt>${s('packExport.generation.techSourceKeys')}</dt><dd>${chunkIds.length > 0 ? `<span class="mono">${esc(chunkIds.join(', '))}</span>` : unavailable}</dd>`
    )
    push('</dl>')
  }
  push('</section>')

  // ---- 9. Integrity details (§16.1.9) ----------------------------------------------
  push('<section id="integrity">')
  push(`<h2>${s('packExport.section.integrity')}</h2>`)
  push('<dl class="meta">')
  push(`<dt>${s('packExport.meta.packId')}</dt><dd class="mono">${esc(model.packId)}</dd>`)
  push(`<dt>${s('packExport.meta.format')}</dt><dd>${formatLine}</dd>`)
  push('</dl>')
  push(`<p class="hint">${s('packExport.integrity.hashNote')}</p>`)
  push(`<h3>${s('packExport.integrity.options')}</h3>`)
  push('<ul>')
  const optionRows: Array<{ key: MessageKey; on: boolean }> = [
    { key: 'review.export.optNotes', on: model.options.includeReviewerNotes },
    { key: 'review.export.optExcerpts', on: model.options.includeSourceExcerpts },
    { key: 'review.export.optHashes', on: model.options.includeDocumentHashes },
    { key: 'review.export.optUnreviewed', on: model.options.includeUnreviewedItems },
    { key: 'review.export.optTechnical', on: model.options.includeTechnicalDetails }
  ]
  for (const row of optionRows) {
    push(
      `<li>${s(row.key)}: ${s(row.on ? 'packExport.integrity.optIncluded' : 'packExport.integrity.optExcluded')}</li>`
    )
  }
  push('</ul>')
  push('</section>')

  push('</main>')
  push(
    `<footer class="pack-foot">${s('packExport.docTitle')} · <span class="mono">${esc(model.packId)}</span> · ${s('packExport.privacy')}</footer>`
  )
  push('</body>')
  push('</html>')
  return out.join('\n') + '\n'
}
