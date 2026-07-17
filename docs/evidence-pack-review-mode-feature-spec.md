# Evidence Pack / Review Mode — Detailed Feature Specification

**Product:** HilbertRaum  
**Feature ID:** EP-1  
**Status:** Proposal  
**Document type:** Product and implementation specification  
**Primary audience:** Product, design, engineering, security, QA  
**Last updated:** 2026-07-17

---

## 1. Executive summary

Evidence Pack / Review Mode turns a document-grounded HilbertRaum answer into a reviewable, portable work product.

A user can open any answer produced in **Ask my documents**, inspect the relationship between the answer and its source material, record review decisions, add notes, and export a self-contained evidence pack. The pack contains the original question, the answer, its source references, exact source excerpts, coverage and limitation statements, document identity information, generation metadata, and the reviewer’s decisions.

The feature does **not** claim to prove that an answer is true. HilbertRaum can deterministically show which source passages were retrieved or which document sections contributed to an answer, but it cannot safely infer that every statement is factually correct merely because a citation exists. Review Mode therefore distinguishes between:

- **Evidence linkage:** what the system can establish from persisted provenance.
- **Review decisions:** what a human reviewer has checked and recorded.
- **Optional AI suggestions:** non-authoritative assistance that must never be presented as verification.

The feature is especially valuable for lawyers, consultants, accountants, HR professionals, compliance teams, researchers, and other users who need to explain how a local AI output was produced without uploading confidential documents to a cloud service.

---

## 2. Product rationale

### 2.1 Problem

HilbertRaum already provides cited, locally generated answers. However, a professional user often needs more than an answer with expandable source cards:

- They need to verify important statements before relying on them.
- They need a record of which documents and passages were used.
- They need to distinguish a directly cited answer from a whole-document synthesis.
- They need to disclose limitations such as partial document coverage or output truncation.
- They need to hand the result to a colleague, client, auditor, or manager.
- They need to preserve review notes independently of the chat transcript.

Copying an answer into a word processor and manually assembling screenshots or quotations is slow and error-prone. It also discards useful provenance already stored by HilbertRaum.

### 2.2 Opportunity

HilbertRaum already persists many of the building blocks required for an evidence pack:

- The user’s question and generated answer.
- Per-message citations and source snippets.
- Document, page, section, or audio time-range metadata.
- Per-message coverage information.
- Distinct provenance semantics for relevance-based and whole-document answers.
- Output-truncation and input-coverage warnings.
- Active model and skill information.
- Document hashes and stored copies.
- Local audit events and export mechanisms.

Evidence Pack / Review Mode combines these into a coherent professional workflow. It strengthens HilbertRaum’s core proposition—private, understandable document work—without introducing a new model family or cloud dependency.

### 2.3 Strategic value

The feature differentiates HilbertRaum from generic local chat applications in four ways:

1. **Accountability:** outputs can be inspected and documented.
2. **Professional usability:** a chat response becomes a deliverable.
3. **Privacy:** review and export remain fully local.
4. **Honesty:** the product communicates what its provenance does and does not establish.

---

## 3. Goals

### 3.1 Primary goals

1. Let a user review the evidence behind a document-grounded answer without leaving HilbertRaum.
2. Preserve the distinction between direct excerpt citations and whole-document provenance.
3. Make incomplete coverage, stale inputs, missing sources, and truncation visible.
4. Let a reviewer record decisions and notes at answer, statement, and source level.
5. Export a self-contained, human-readable evidence pack.
6. Keep all processing and exported content local.
7. Reuse existing persisted citations and coverage data wherever possible.
8. Work well for non-technical users on 8–16 GB laptops.

### 3.2 Secondary goals

- Provide a stable internal representation that can later support approval workflows, redaction, signed exports, and structured extraction results.
- Allow an evidence pack to be reopened and continued after an application restart.
- Support English and German from the first release.
- Produce deterministic exports from stored review data without calling an AI model.

### 3.3 Success criteria

The feature is successful when users can answer these questions quickly:

- What question was asked?
- What answer did HilbertRaum produce?
- Which sources support or contributed to it?
- Was the answer based on selected excerpts, the complete document, or only part of it?
- Did the model output end normally or hit a limit?
- Which statements did a human review?
- What concerns or follow-up actions remain?
- Can the result be exported and shared without opening the original chat?

---

## 4. Non-goals

Version 1 will not:

- Certify that an answer is legally, medically, financially, or factually correct.
- Calculate a universal “truth score,” “confidence percentage,” or hallucination probability.
- Automatically approve statements.
- Replace professional review.
- Upload evidence packs, documents, or review data to a server.
- Add team collaboration, remote comments, or cloud synchronization.
- Digitally sign exports with a centrally managed HilbertRaum certificate.
- Rewrite source documents.
- Modify the original chat answer.
- Re-run retrieval automatically while opening an existing review.
- Treat whole-document leaf provenance as if every passage had been explicitly cited by the model.
- Export hidden model reasoning or chain-of-thought.

---

## 5. Product principles

### 5.1 Provenance is not proof

A citation establishes a traceable relationship to source material. It does not establish that the model interpreted the passage correctly or that the source itself is correct.

The interface must never convert “has a citation” into “verified.”

### 5.2 Deterministic facts first

Review Mode should lead with information HilbertRaum can establish deterministically:

- The exact answer text.
- Persisted source references.
- Persisted source excerpts.
- Document identity and hash.
- Page, section, or time-range labels.
- Coverage mode and counts.
- Truncation flags.
- The user’s recorded review decisions.

Model assistance, where introduced later, must be visually and semantically secondary.

### 5.3 Honest evidence semantics

The feature must preserve HilbertRaum’s existing distinction between:

- **Relevance answer:** the model received a selected set of labeled excerpts. Source cards represent the excerpts used for grounding.
- **Whole-document answer:** the answer was produced through a full-document or capped analysis path. The listed sections represent provenance or coverage, not necessarily 1:1 inline citations.
- **Structured/tool answer:** the answer may be based on deterministically extracted and validated data. The pack must identify the extraction and validation basis.

### 5.4 Calm, professional presentation

Review Mode should feel like a document review workspace, not a debugging console. Technical details remain available behind disclosure controls.

### 5.5 Human decisions are explicit

A reviewer’s status must result from a deliberate action. Merely opening or reading an item must not mark it reviewed.

### 5.6 Export is a snapshot

An exported pack represents a specific review state at a specific time. It does not update automatically when the source document, answer, or review later changes.

---

## 6. Terminology

### 6.1 Evidence pack

A local, immutable export generated from a saved review. It contains the answer, evidence, metadata, reviewer decisions, limitations, and optional notes.

### 6.2 Review

A persisted workspace object connected to one assistant answer. A review may be incomplete, in progress, or completed.

### 6.3 Review item

A reviewable unit within the answer. Version 1 uses answer blocks or reviewer-created text selections. A later release may suggest statement boundaries with a local model.

### 6.4 Evidence link

A relationship between a review item and one or more persisted citations or provenance sections.

### 6.5 Direct citation

A source excerpt from the relevance-grounded path, corresponding to a labeled excerpt supplied to the model.

### 6.6 Whole-document provenance

A source section showing that content contributed to a whole-document analysis. It must not be described as a direct citation unless the underlying path provides that guarantee.

### 6.7 Review decision

A human-recorded classification. Proposed values:

- **Reviewed — supported**
- **Reviewed — partly supported**
- **Reviewed — not supported**
- **Needs follow-up**
- **Not reviewed**
- **Not applicable**

The wording “supported” refers only to support found in the selected evidence, not universal truth.

### 6.8 Pack status

- **Draft:** review exists but is incomplete.
- **Ready:** reviewer has completed required review steps.
- **Exported:** at least one pack snapshot was generated.
- **Outdated:** the underlying answer or one of its source documents no longer matches the reviewed snapshot.

---

## 7. Target users and use cases

### 7.1 Lawyer reviewing a contract answer

A lawyer asks, “What are the termination rights and notice periods?” HilbertRaum produces a cited answer. The lawyer opens Review Mode, checks each important statement against the cited clause, records one ambiguity, and exports a PDF for the matter file.

### 7.2 Consultant preparing a client briefing

A consultant asks for key risks across a set of reports. They review the claims, mark two as requiring follow-up, add a note explaining a source conflict, and export an HTML pack for internal quality review.

### 7.3 HR professional checking policy guidance

An HR professional asks whether a policy permits a certain absence. They review the cited paragraphs, mark the answer partly supported because an exception is missing, and retain the review locally.

### 7.4 Accountant reviewing extracted figures

An accountant asks about invoice totals. The pack identifies that figures came from deterministic extraction and reconciliation. The reviewer checks the original page, records approval, and exports a pack with the validation summary.

### 7.5 Researcher documenting a synthesis

A researcher creates a whole-document summary. Review Mode clearly states that the answer was derived from the document through whole-document analysis and that the displayed sections are provenance rather than individual inline citations.

---

## 8. Scope and supported source answer types

### 8.1 Version 1 supported

- Assistant messages in **Ask my documents**.
- Relevance-grounded answers with persisted `Citation[]`.
- Whole-document answers with persisted `CoverageInfo` and leaf provenance.
- Structured skill answers with available source and validation metadata.
- Answers with input-coverage or output-truncation warnings.
- Legacy answers where some metadata is absent, provided the limitation is shown.

### 8.2 Version 1 unsupported or limited

- Plain chat answers without document provenance.
- Image-analysis answers unless the image feature exposes equivalent persisted source-region metadata.
- Live text translation results that have not been materialized as documents.
- Answers whose source documents were permanently deleted and whose snippets were not persisted.
- Reviews spanning multiple assistant answers.
- Whole-conversation evidence packs.

A later release may add conversation-level packs after the single-answer data model is proven.

---

## 9. Entry points

### 9.1 Per-message action

Add **Review evidence** to the assistant-message action row for eligible document-grounded answers.

Suggested order:

`Try again · Copy · Save · Review evidence`

The action appears only when:

- The message is an assistant message.
- The conversation is document-grounded, or the message has citations/coverage metadata.
- The answer is persisted and no longer streaming.

### 9.2 Sources disclosure

At the bottom of the expanded source/provenance disclosure, add a quiet action:

> Review answer and sources

### 9.3 Documents-generated work product

For generated reports that represent a saved answer, an optional **Open evidence review** action may be added later. It is not required for Version 1.

### 9.4 Existing review indicator

If a review already exists, the per-message action becomes:

> Continue review

A small, non-alarming status may be shown beside it:

- Draft
- Ready
- Outdated

---

## 10. Primary user journey

### 10.1 Start a review

1. The user opens **Review evidence** on an eligible answer.
2. HilbertRaum creates a draft review from persisted message data.
3. No model call occurs.
4. The review opens in a dedicated focused workspace.
5. The answer is displayed with citation markers and reviewable text blocks.
6. The evidence panel shows sources and the appropriate provenance explanation.
7. A review summary starts with all items marked **Not reviewed**.

### 10.2 Inspect a statement

1. The user selects an answer block or highlights text.
2. Review Mode shows evidence linked through inline citation markers.
3. The user can add or remove evidence links from the answer’s available source set.
4. The source excerpt can be expanded in context.
5. The user records a decision and optional note.
6. The review saves automatically to the encrypted workspace.

### 10.3 Resolve uncited text

For text with no direct citation marker, Review Mode labels it:

> No direct source marker in this text

The user can:

- Link one or more available source excerpts manually.
- Mark it as an interpretation supported by the evidence.
- Mark it not supported.
- Mark it not applicable, for example for headings or transitional language.
- Leave it for follow-up.

The UI must not assume uncited text is false. It only states that no direct marker is present.

### 10.4 Complete the review

The user selects **Review summary** and sees:

- Number of review items.
- Supported, partly supported, not supported, follow-up, and unreviewed counts.
- Coverage and truncation warnings.
- Missing or changed source documents.
- Reviewer name or label, if supplied.
- General notes.

A review can be marked **Ready** only when no required item remains **Not reviewed**. Items marked **Not applicable** do not block completion.

### 10.5 Export the pack

1. The user selects **Create evidence pack**.
2. HilbertRaum shows a compact export dialog.
3. The user chooses PDF or self-contained HTML.
4. Optional sections can be included or excluded.
5. HilbertRaum generates the pack locally from stored data.
6. The user chooses a destination with the native save dialog.
7. The review records the export timestamp and a hash of the generated pack.

---

## 11. Review workspace design

### 11.1 Navigation model

Review Mode should be a dedicated route or full-window workspace, not a permanently visible chat side panel. This keeps everyday chat uncluttered and preserves progressive disclosure.

Suggested layout:

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← Back to chat   Evidence review: Contract termination      Draft · Local   │
├───────────────────────────────────────┬──────────────────────────────────────┤
│ ANSWER                                │ EVIDENCE                             │
│                                       │                                      │
│ [Review item 1]                       │ Source 1 · contract.pdf · page 12    │
│ The agreement may be terminated       │ “Either party may terminate…”        │
│ with 90 days’ notice. [S1]            │                                      │
│                                       │ [Open page] [Link to item]            │
│ Decision: Supported                   │                                      │
│ Note: …                               │ Source 2 · appendix.pdf · page 3      │
│                                       │ …                                    │
│ [Review item 2]                       │                                      │
│ …                                     │                                      │
├───────────────────────────────────────┴──────────────────────────────────────┤
│ 6 of 8 reviewed · 1 follow-up · Partial coverage warning                    │
│                         [Review summary] [Create evidence pack]              │
└──────────────────────────────────────────────────────────────────────────────┘
```

On narrow windows, the evidence pane becomes a drawer opened from the selected review item.

### 11.2 Header

The header contains:

- Back to chat.
- Review title, defaulting to the conversation title or first line of the question.
- Status: Draft, Ready, or Outdated.
- Quiet **Local · Offline** indicator.
- Overflow menu: Rename review, Duplicate review, Delete review, Technical details.

### 11.3 Answer pane

The answer pane displays:

- The original question in a collapsible header.
- The answer exactly as persisted.
- Localized citation labels using the existing display convention.
- Review-item boundaries.
- Decision chips that use text and icons, not color alone.
- Notes associated with each item.

The answer text must remain immutable within Review Mode. A reviewer may add annotations but cannot silently edit what the model originally produced.

### 11.4 Evidence pane

The evidence pane displays the source set already persisted with the answer.

For relevance answers:

> Sources shown here are the excerpts supplied to the model for this answer.

For whole-document answers:

> This answer was derived through whole-document analysis. The sections below show provenance and coverage; they are not individual inline citations.

For structured/tool answers:

> This answer used locally extracted data. Validation results and source passages are shown below.

Each evidence card includes:

- Localized source marker when applicable.
- Document title.
- Page, section, or time range.
- Exact persisted snippet.
- Evidence type: direct excerpt, whole-document provenance, extracted record, or reviewer-added link.
- Source availability state.
- **Open source** action.
- **Link to review item** or **Remove link** action.

### 11.5 Source-in-context view

Selecting **Open source** opens a modal or secondary panel showing:

- The cited page or section where available.
- The cited snippet highlighted.
- Nearby text before and after the snippet, subject to existing preview limits.
- Source document title and hash state.
- A warning if the current source differs from the reviewed snapshot.

Version 1 does not require pixel-perfect PDF highlighting. Page-level opening with text highlighting is sufficient.

### 11.6 Review summary

The summary view contains:

- Overall review status.
- Decision counts.
- Required follow-ups.
- Coverage explanation.
- Source integrity and availability.
- Model and generation metadata.
- Reviewer name/label and review timestamps.
- General review note.
- Export history.

---

## 12. Review-item model

### 12.1 Version 1 item creation

To avoid introducing an unreliable claim classifier, Version 1 uses two item types:

1. **Answer block:** a paragraph, list item, table row, heading, or fenced block derived deterministically from rendered Markdown structure.
2. **Reviewer selection:** a user-selected text range within one answer block.

The user may split a broad paragraph by selecting a statement and choosing **Review separately**.

### 12.2 Default item behavior

- Paragraphs and list items are reviewable by default.
- Headings default to **Not applicable**, but the user may change them.
- Code blocks and tables are kept as coherent units unless the user creates a selection.
- Very short connective fragments should stay with the surrounding paragraph.

### 12.3 Optional later enhancement

A local model may suggest claim boundaries, but:

- Suggestions must be labeled **Suggested**.
- Accepting a suggestion only creates review items.
- The model must not assign review decisions.
- The original answer remains unchanged.
- The feature must work fully without this model call.

---

## 13. Evidence-linking rules

### 13.1 Automatic links for relevance answers

For an answer block containing `[S1]` or its localized display equivalent, link the item to the persisted citation whose machine label is `S1`.

Rules:

- Machine labels remain stable and unlocalized in storage.
- Display labels are localized at render time.
- Multiple markers link to multiple evidence cards.
- Repeated markers link to the same citation once.
- Markers inside literal code are ignored, matching existing display behavior.

### 13.2 Unmarked answer blocks

An unmarked block receives no automatic evidence link. The interface shows:

> No direct source marker

The reviewer can manually link any evidence available to the answer.

### 13.3 Whole-document answers

Whole-document answers must not infer links between individual answer blocks and individual provenance sections. By default, every item displays:

> Derived through whole-document analysis

The reviewer may manually associate sections with an item, but these links are labeled **Reviewer linked**, not **Cited by the answer**.

### 13.4 Structured/tool answers

Where structured data records contain source-page metadata, Review Mode links the corresponding answer item to that page or record.

Where only leading source chunks are available, the pack must state that the source establishes document provenance but may not identify the exact location of each figure.

### 13.5 Missing citation data

Legacy or malformed citation data must degrade safely:

- Preserve the answer.
- Show **Source details unavailable for this answer**.
- Do not reconstruct citations by re-running retrieval.
- Allow the reviewer to add a general note and export with the limitation visible.

---

## 14. Review decisions

### 14.1 Decision definitions

#### Reviewed — supported

The reviewer found that the linked evidence supports the material meaning of the review item.

#### Reviewed — partly supported

Some material elements are supported, but qualifications, scope, figures, or conditions are missing or overstated.

#### Reviewed — not supported

The reviewer did not find support for the item in the linked evidence, or found contradictory evidence.

#### Needs follow-up

The item cannot yet be resolved, for example because another document is required or the wording is ambiguous.

#### Not reviewed

No human decision has been recorded.

#### Not applicable

The item does not require evidential review, such as a heading, transition, or formatting element.

### 14.2 Notes

Each decision may carry a plain-text note. Notes are stored locally and included in exports by default.

### 14.3 Contradictory sources

The reviewer can flag an evidence card as:

- Supports.
- Qualifies.
- Contradicts.
- Context only.

This relation is explicitly reviewer-assigned.

### 14.4 Bulk actions

Version 1 may offer conservative bulk actions:

- Mark selected headings as Not applicable.
- Clear decisions on selected items.
- Mark selected items Needs follow-up.

It must not offer “Mark all supported.”

---

## 15. Coverage and limitation presentation

### 15.1 Coverage block

Every review and export includes an **How the answer was produced** block.

Possible presentations:

#### Relevance-grounded

> HilbertRaum selected the most relevant passages from the chosen document scope and supplied them to the local AI model. The answer was not based on every page of every selected document.

Show:

- Sections/passages considered where available.
- Sections/passages in the persisted source set.
- Scope summary.

#### Whole-document, complete

> HilbertRaum analysed the complete document through a multi-step local process. The listed sections show document provenance rather than individual sentence citations.

#### Whole-document, partial or capped

> HilbertRaum analysed only part of the document or condensed some sections. The answer may omit information from uncovered or condensed content.

#### Structured extraction

> HilbertRaum answered from locally extracted structured data. The pack includes available validation results and source locations.

### 15.2 Output truncation

When `Message.truncated` or equivalent indicates the answer hit an output limit, show prominently but calmly:

> The generated answer reached the model’s output limit and may be incomplete.

### 15.3 Input truncation or partial coverage

When coverage indicates beginning-only, incomplete, stale, or condensed input, show:

> The source analysis did not cover all content at full detail.

The export must preserve the exact available reason.

### 15.4 Missing sources

If a source document has been deleted:

> This source was available when the answer was created but is no longer present in the workspace. The persisted excerpt remains in this review where available.

### 15.5 Changed sources

If the current document hash differs from the snapshot hash:

> The source document has changed since this review was created.

The user can still open the old persisted excerpt. The review becomes **Outdated** until the user explicitly acknowledges the change or creates a new answer and review.

---

## 16. Evidence pack contents

### 16.1 Mandatory sections

Every pack contains:

1. **Cover**
   - Pack title.
   - Export date and time.
   - Review status.
   - Privacy statement: created locally by HilbertRaum.
   - Pack identifier.

2. **Question and answer**
   - Original question.
   - Original answer, unchanged.
   - Localized display citation markers.

3. **Review summary**
   - Reviewer label.
   - Review dates.
   - Decision counts.
   - General notes.
   - Outstanding follow-ups.

4. **Item-by-item review**
   - Review item text.
   - Decision.
   - Reviewer note.
   - Linked evidence references.

5. **Evidence register**
   - Source identifier.
   - Document title.
   - Page, section, or time range.
   - Exact persisted excerpt.
   - Evidence type.
   - Reviewer relation where assigned.

6. **Coverage and limitations**
   - Answer-production mode.
   - Input coverage statement.
   - Output-truncation statement.
   - Missing, changed, or stale source warnings.

7. **Source register**
   - Document title.
   - File type.
   - Stored SHA-256 at review time.
   - Availability at export time.
   - Original path excluded by default.

8. **Generation details**
   - Model display name and ID.
   - Active skill, if any.
   - Generation timestamp.
   - Application version.
   - Review/export timestamp.

9. **Integrity details**
   - Pack ID.
   - Export format/version.
   - SHA-256 of the exported file, recorded in the review after generation.

### 16.2 Optional sections

The export dialog may allow:

- Include reviewer notes.
- Include full source excerpts.
- Include technical model details.
- Include document hashes.
- Include source paths.
- Include activity timeline.
- Include unreviewed items.
- Include an appendix with all whole-document provenance sections.

Privacy-sensitive options such as source paths default to off.

### 16.3 Excluded content

Never include:

- Hidden reasoning or chain-of-thought.
- Password or encryption details.
- Unrelated audit events.
- Unselected conversation history.
- Full source documents unless the user explicitly exports them separately.
- Original laptop paths by default.

---

## 17. Export formats

### 17.1 PDF

PDF is the primary professional format.

Requirements:

- Searchable text.
- Stable page numbers.
- Bookmarks for major sections where supported.
- Repeating pack ID and page number in the footer.
- No remote assets, fonts, or URLs.
- Printable in A4 and readable in grayscale.
- Clear warning blocks that do not rely on color.

### 17.2 Self-contained HTML

HTML supports easier navigation and expandable evidence.

Requirements:

- One local file with embedded styles and data.
- No scripts requiring network access.
- No external fonts or images.
- Printable stylesheet.
- Source excerpt anchors.
- A clear notice that interactive expansion is presentational only.

### 17.3 Markdown

Markdown may be added as a secondary export because it is easy to inspect and version. It is not required for the first production release if PDF and HTML are available.

### 17.4 Machine-readable manifest

Each export should embed or accompany a small JSON manifest. For a single-file PDF, the manifest may also be stored inside the review record rather than attached to the file in Version 1.

The manifest contains identifiers, hashes, timestamps, source register, decision data, and schema version. It must contain no data not already visible in the pack unless clearly disclosed.

---

## 18. Persistence and proposed data model

The following names are proposed and may be adapted to repository conventions.

### 18.1 Tables

#### `evidence_reviews`

```text
id                         TEXT PRIMARY KEY
conversation_id            TEXT NOT NULL
message_id                 TEXT NOT NULL
question_message_id        TEXT NULL
title                      TEXT NOT NULL
status                     TEXT NOT NULL  -- draft | ready | outdated
reviewer_label              TEXT NULL
general_note               TEXT NULL
source_snapshot_json       TEXT NOT NULL
answer_snapshot             TEXT NOT NULL
question_snapshot           TEXT NOT NULL
coverage_snapshot_json     TEXT NULL
generation_snapshot_json   TEXT NULL
created_at                 TEXT NOT NULL
updated_at                 TEXT NOT NULL
completed_at               TEXT NULL
```

Constraints:

- At most one active review per assistant message in Version 1.
- Deleting a conversation should require an explicit policy decision: cascade-delete its reviews or preserve them as detached work products. Recommended Version 1 behavior is to warn and cascade only after confirmation.

#### `evidence_review_items`

```text
id                         TEXT PRIMARY KEY
review_id                  TEXT NOT NULL
ordinal                    INTEGER NOT NULL
kind                       TEXT NOT NULL  -- block | selection
block_key                  TEXT NOT NULL
start_offset               INTEGER NULL
end_offset                 INTEGER NULL
text_snapshot              TEXT NOT NULL
decision                   TEXT NOT NULL
reviewer_note              TEXT NULL
created_at                 TEXT NOT NULL
updated_at                 TEXT NOT NULL
```

#### `evidence_review_links`

```text
id                         TEXT PRIMARY KEY
review_item_id             TEXT NOT NULL
evidence_key               TEXT NOT NULL
link_origin                TEXT NOT NULL  -- answer_marker | reviewer
reviewer_relation          TEXT NULL      -- supports | qualifies | contradicts | context
created_at                 TEXT NOT NULL
```

#### `evidence_exports`

```text
id                         TEXT PRIMARY KEY
review_id                  TEXT NOT NULL
format                     TEXT NOT NULL  -- pdf | html | markdown
schema_version             INTEGER NOT NULL
file_name                  TEXT NOT NULL
file_sha256                TEXT NOT NULL
options_json               TEXT NOT NULL
created_at                 TEXT NOT NULL
```

The destination path should not be persisted unless required. If persisted, store it only with explicit user consent because it may reveal private workstation information.

### 18.2 Source snapshot

The review must snapshot enough source metadata to remain understandable if documents later change or disappear.

Proposed shape:

```ts
interface EvidenceSourceSnapshot {
  key: string;
  machineLabel?: string;
  kind: 'direct_excerpt' | 'whole_document_provenance' | 'structured_record';
  documentId?: string;
  documentTitle: string;
  documentSha256?: string;
  mimeType?: string;
  pageNumber?: number;
  sectionLabel?: string;
  snippet?: string;
  sourceChunkId?: string;
  availabilityAtCreation: 'available' | 'missing';
}
```

### 18.3 Generation snapshot

```ts
interface EvidenceGenerationSnapshot {
  generatedAt?: string;
  modelId?: string;
  modelDisplayName?: string;
  skillId?: string;
  skillDisplayName?: string;
  appVersion: string;
  answerTruncated?: boolean;
  answerMode?: 'relevance' | 'tree' | 'capped' | 'extract' | 'unknown';
}
```

### 18.4 Review status derivation

- `draft`: any required item is Not reviewed, or the user manually reopens a ready review.
- `ready`: no required item is Not reviewed and the user explicitly selects **Mark review ready**.
- `outdated`: a referenced message or source no longer matches its snapshot.

Outdated is an overlay condition and should not erase whether the review had previously been ready.

### 18.5 Encryption

All review tables live inside the existing workspace database and inherit encrypted-at-rest behavior. No separate plaintext review index should be created.

Exported packs are plaintext unless the destination itself is encrypted. The export dialog must state:

> The exported file is not protected by your HilbertRaum workspace password.

Encrypted ZIP export may be evaluated later but is not required for Version 1.

---

## 19. Proposed IPC and service surface

Names are illustrative.

```ts
createEvidenceReview(messageId: string): Promise<EvidenceReview>
getEvidenceReview(reviewId: string): Promise<EvidenceReviewDetail>
getEvidenceReviewForMessage(messageId: string): Promise<EvidenceReviewSummary | null>
updateEvidenceReview(reviewId: string, patch: EvidenceReviewPatch): Promise<EvidenceReview>
updateEvidenceReviewItem(itemId: string, patch: EvidenceReviewItemPatch): Promise<EvidenceReviewItem>
createEvidenceSelection(reviewId: string, input: EvidenceSelectionInput): Promise<EvidenceReviewItem>
deleteEvidenceSelection(itemId: string): Promise<void>
setEvidenceLink(itemId: string, evidenceKey: string, input: EvidenceLinkInput): Promise<void>
removeEvidenceLink(itemId: string, evidenceKey: string): Promise<void>
markEvidenceReviewReady(reviewId: string): Promise<EvidenceReview>
refreshEvidenceReviewState(reviewId: string): Promise<EvidenceReviewFreshness>
exportEvidencePack(reviewId: string, options: EvidenceExportOptions): Promise<EvidenceExportResult>
deleteEvidenceReview(reviewId: string): Promise<void>
```

Security rules:

- Renderer passes identifiers and user-entered review text, never arbitrary source paths.
- Main resolves all message, document, and export data.
- Save destinations are chosen through the main-process native dialog.
- Export HTML is generated through a fixed template with escaped user content.
- No remote URL, image, script, or font is permitted.

---

## 20. Export generation architecture

### 20.1 Deterministic pipeline

```text
load persisted review
→ validate schema
→ refresh source availability/freshness
→ build normalized pack model
→ render fixed local template
→ generate PDF or self-contained HTML
→ write temporary file
→ fsync
→ hash generated file
→ atomically rename to destination
→ record export metadata
```

No model runtime is required.

### 20.2 Failure behavior

- A failed render leaves no completed destination file.
- Temporary files are removed on failure where possible.
- The review remains unchanged except for a local diagnostic event.
- A missing source does not block export; it is represented as a limitation.
- Malformed optional metadata degrades to **Unavailable**, never to invented values.

### 20.3 Atomicity

Use the existing safe-export pattern:

- Write to a temporary sibling file.
- Flush to disk.
- Rename only after completion.
- Do not record an export row before the final file exists and its hash is calculated.

---

## 21. Source freshness and integrity

### 21.1 At review creation

Store:

- Document ID.
- Document title.
- Stored SHA-256 where available.
- Persisted source excerpt.
- Page or section label.

### 21.2 At review open

Compare the snapshot against the current workspace:

- Document still exists.
- Current hash matches.
- Message answer text matches.
- Coverage metadata matches.

Do not re-hash large source files on every render if the existing document row already holds a trusted import hash. Use the stored document hash as the comparison basis.

### 21.3 Outdated behavior

An outdated review remains readable and exportable. Exports contain a prominent snapshot warning.

The user can:

- Keep the historical review.
- Acknowledge the source change.
- Return to chat and ask again.
- Duplicate the review from a new answer.

Version 1 should not automatically remap old review items onto a regenerated answer.

---

## 22. Privacy and security requirements

1. All review data remains local.
2. No telemetry or analytics events are introduced.
3. No network calls occur during review creation, editing, freshness checks, or export.
4. Review data is stored in the encrypted workspace database.
5. Exports clearly disclose that they are outside workspace encryption.
6. Original source paths are excluded by default.
7. User-entered notes are HTML-escaped and Markdown-sanitized as appropriate.
8. The renderer never receives unrestricted filesystem access.
9. PDF/HTML export uses local templates only.
10. Any “Open source” action resolves a known document ID through main-process APIs.
11. Audit events use IDs and coarse action names, not document titles, questions, answers, excerpts, or reviewer notes.
12. Deleting a review securely removes its database records within the limits of SQLite and SSD storage already documented by the product.

Suggested audit events:

- `evidence_review_created`
- `evidence_review_ready`
- `evidence_pack_exported`
- `evidence_review_deleted`

Payloads should contain review/message identifiers and export format only.

---

## 23. Accessibility requirements

- Full keyboard navigation.
- Visible focus states.
- Decision controls implemented as a labeled radio group or equivalent accessible control.
- Evidence pane associated with the selected review item using `aria-controls` and region labels.
- Review progress exposed as text and, where appropriate, `role="progressbar"` or `role="meter"`.
- Status must not rely on color.
- Source excerpts retain readable line height and selectable text.
- The split layout must remain usable at 200% zoom.
- On narrow screens, the evidence drawer must return focus to the invoking control when closed.
- Exported PDFs must preserve logical heading order and selectable text.
- Localized citation marker display must match existing English/German behavior.

---

## 24. Localization and proposed copy

### 24.1 Primary actions

| English | German |
|---|---|
| Review evidence | Nachweise prüfen |
| Continue review | Prüfung fortsetzen |
| Create evidence pack | Nachweispaket erstellen |
| Mark review ready | Prüfung abschließen |
| Open source | Quelle öffnen |
| Link to item | Mit Aussage verknüpfen |

German copy requires native-language product review before shipping.

### 24.2 Decision labels

| English | German draft |
|---|---|
| Reviewed — supported | Geprüft — belegt |
| Reviewed — partly supported | Geprüft — teilweise belegt |
| Reviewed — not supported | Geprüft — nicht belegt |
| Needs follow-up | Weitere Prüfung nötig |
| Not reviewed | Nicht geprüft |
| Not applicable | Nicht anwendbar |

### 24.3 Honesty copy

**Relevance answer**

> The sources shown are the excerpts supplied to the local AI model for this answer.

**Whole-document answer**

> This answer was derived through whole-document analysis. The sections shown are provenance, not individual sentence citations.

**Export warning**

> This exported file is stored outside the encrypted HilbertRaum workspace and is not protected by your workspace password.

**Review disclaimer**

> A citation shows where information came from. It does not by itself prove that the answer is correct.

---

## 25. Error and edge states

### 25.1 Answer has no citations

Show:

> This answer has no persisted source excerpts. You can record a general review, but source-level verification is unavailable.

### 25.2 Source deleted

Keep the persisted snippet and mark the source unavailable.

### 25.3 Source changed

Mark the review outdated and show both the historical snapshot metadata and current document state.

### 25.4 Message deleted or conversation removed

Recommended behavior:

- Prevent silent deletion when a review exists.
- Confirmation explains that associated reviews will also be deleted.
- A future feature may detach reviews into standalone generated documents.

### 25.5 Legacy answer

Show only metadata known to be present. Do not fabricate generation time, model, coverage, or source semantics.

### 25.6 Very large provenance set

- Keep the full persisted set available.
- Render an initial capped list.
- Provide search/filter and incremental reveal.
- Export may include either all provenance or only reviewer-linked sections, controlled by an option.

### 25.7 Export destination unavailable

Return a friendly error and preserve the review. Do not mark the pack exported.

### 25.8 Insufficient disk space

Estimate export size conservatively when full excerpts are selected. Check free space before PDF rendering where practical.

### 25.9 Review conflict across windows

Version 1 may support one active editor per review. A second window opens read-only or receives a newer-version warning. Use `updated_at` or a revision integer for optimistic concurrency.

---

## 26. Performance requirements

- Opening a review must not start the chat, embedding, reranking, translation, vision, or transcription sidecars.
- Review creation should use persisted message and source data.
- A normal review with up to 24 source cards should open within approximately one second on the target laptop, excluding encrypted-workspace unlock time.
- Large provenance lists must be virtualized or incrementally rendered.
- Auto-save should debounce note edits and batch related writes.
- Export generation runs as a cancellable local task.
- PDF rendering should not block the renderer thread.
- Source-context preview uses existing parser limits and must not bypass page, size, or time caps.

---

## 27. Version 1 functional requirements

### FR-1 Eligibility

The system shall show **Review evidence** for persisted assistant answers carrying document provenance or coverage metadata.

### FR-2 Snapshot creation

The system shall create a review snapshot without invoking an AI model.

### FR-3 Answer immutability

The system shall preserve the original question and answer text unchanged within the review.

### FR-4 Evidence semantics

The system shall distinguish direct excerpts from whole-document provenance.

### FR-5 Review items

The system shall create deterministic review items from answer structure and allow reviewer-created text selections.

### FR-6 Decisions

The system shall let a reviewer record one decision and an optional note for each review item.

### FR-7 Evidence links

The system shall automatically link machine citation markers to their persisted citations and allow reviewer-created links.

### FR-8 Coverage

The system shall show available input-coverage and output-truncation information.

### FR-9 Freshness

The system shall detect missing or changed source documents using stored identifiers and hashes.

### FR-10 Completion

The system shall prevent a review being marked ready while required items remain unreviewed.

### FR-11 Persistence

The system shall persist review state in the workspace database.

### FR-12 Export

The system shall export a deterministic PDF or self-contained HTML evidence pack without a model call or network access.

### FR-13 Export privacy

The system shall warn that exported files are outside workspace encryption.

### FR-14 Localization

The system shall support English and German UI and exports.

### FR-15 Accessibility

The review workflow shall be usable by keyboard and screen reader.

---

## 28. Acceptance criteria

### 28.1 Relevance-grounded answer

Given an answer containing `[S1]` and `[S2]` with two persisted citations:

- Review creation produces deterministic answer blocks.
- Blocks containing the markers link to the matching citations.
- The evidence panel says the excerpts were supplied to the model.
- The exported pack contains the exact persisted snippets.
- No model or network call occurs.

### 28.2 Uncited answer text

Given a paragraph with no source marker:

- It displays **No direct source marker**.
- It is not automatically classified as unsupported.
- The reviewer can link an available source and record a decision.

### 28.3 Whole-document answer

Given an answer with `coverage.mode = tree`:

- The UI does not present leaf provenance as direct inline citations.
- Review items display a whole-document derivation notice.
- Reviewer-created section links are labeled as reviewer links.
- The export repeats the provenance limitation.

### 28.4 Partial coverage

Given a capped or truncated source analysis:

- The review status area shows a limitation.
- The exported pack includes the limitation even if the review is marked ready.

### 28.5 Output truncation

Given an answer with the output-truncated flag:

- The answer is reviewable.
- The review and export state that the generated output may be incomplete.

### 28.6 Changed source

Given a source whose current hash differs from the review snapshot:

- The review becomes Outdated.
- Existing decisions remain intact.
- Export is allowed only after a warning is acknowledged.
- The pack records the mismatch.

### 28.7 Deleted source

Given a deleted source with a persisted citation snippet:

- The snippet remains visible.
- The source is marked unavailable.
- Export succeeds with the missing-source warning.

### 28.8 Encryption

Given a locked encrypted workspace:

- Review data is inaccessible until unlock.
- No plaintext review cache is written outside the workspace.

### 28.9 Export failure

Given an interrupted PDF render:

- No completed destination file is left behind.
- No successful export record is written.
- The review remains usable.

### 28.10 Accessibility

A keyboard-only user can:

- Open Review Mode.
- Move among items.
- Open linked evidence.
- Set a decision.
- Add a note.
- Open the summary.
- Export a pack.

---

## 29. Testing strategy

### 29.1 Unit tests

- Markdown block segmentation.
- Citation-marker extraction with code-span/code-block exclusions.
- Machine-label to localized-display mapping.
- Decision-state validation.
- Review completion derivation.
- Source snapshot serialization and tolerant parsing.
- Freshness comparison.
- Pack-model normalization.
- HTML escaping and sanitization.
- Export-option defaults.

### 29.2 Integration tests

- Create review from a relevance answer.
- Create review from a whole-document answer.
- Create review from a structured skill answer.
- Round-trip all review data through SQLite.
- Encrypted workspace lock/unlock behavior.
- Document deletion/change detection.
- PDF and HTML export without network calls.
- Atomic export failure handling.
- Conversation deletion with associated reviews.

### 29.3 Renderer tests

- Entry-point visibility.
- Review layout and narrow-window drawer.
- Decision keyboard interactions.
- Source/provenance wording.
- Missing-source and outdated states.
- Completion gating.
- Export warning.
- English/German parity.
- Screen-reader labels and focus restoration.

### 29.4 Security tests

- Malicious Markdown in answer, source snippet, or reviewer note.
- HTML/script injection in self-contained HTML export.
- Path injection through document titles.
- Renderer attempts to request arbitrary file paths.
- No network calls across review and export paths.
- Audit payload contains no answer, question, source excerpt, or note text.

### 29.5 Snapshot/golden tests

Maintain deterministic golden outputs for:

- Relevance PDF/HTML pack.
- Whole-document provenance pack.
- Partial-coverage pack.
- Missing-source pack.
- German-language pack.

Normalize timestamps and pack IDs in test fixtures.

---

## 30. Rollout plan

### Phase 1 — Review foundation

- Review tables and IPC.
- Create/open/delete review.
- Deterministic answer-block segmentation.
- Existing citation/provenance display.
- Decisions, notes, and auto-save.
- Review summary.
- No export yet.

**Exit gate:** a user can complete and reopen a review without model or network activity.

### Phase 2 — Evidence pack export

- Normalized pack model.
- Self-contained HTML export.
- PDF export.
- Export history and file hash.
- Encryption-boundary warning.

**Exit gate:** deterministic golden packs and atomic export tests pass.

### Phase 3 — Freshness and source context

- Source hash comparison.
- Missing/changed source states.
- Source-in-context preview.
- Outdated review status.

**Exit gate:** historical reviews remain understandable after source change or deletion.

### Phase 4 — Workflow polish

- Reviewer-created text selections.
- Source search/filter for large provenance sets.
- Bulk Not applicable action for headings.
- Refined German copy and accessibility audit.

### Later, evidence-gated enhancements

- Suggested claim segmentation.
- Conversation-level packs.
- Redacted pack export.
- Password-protected export archive.
- Digital signatures using customer-managed keys.
- Review templates by profession or skill.
- Evidence packs for structured extraction tables and image regions.

---

## 31. Risks and mitigations

### Risk 1: Users interpret “supported” as “true”

**Mitigation:** Persistent disclaimer, careful copy, no confidence scores, and explicit definition of support as a reviewer decision about selected evidence.

### Risk 2: Whole-document provenance is misrepresented as direct citation

**Mitigation:** Separate evidence types in storage, UI, and export; prohibit automatic block-to-section links for whole-document answers.

### Risk 3: Reviews become stale after document changes

**Mitigation:** Snapshot source hashes, detect changes, preserve historical snippets, and mark the review Outdated.

### Risk 4: Export leaks private paths or metadata

**Mitigation:** Exclude paths by default, preview included sections, and clearly label privacy-sensitive options.

### Risk 5: PDF generation adds a heavy dependency

**Mitigation:** Implement the normalized pack model and HTML export first. Use an existing packaged rendering capability where possible; avoid a new native binary unless justified.

### Risk 6: Large provenance sets create poor performance

**Mitigation:** Incremental rendering, source filtering, reviewer-linked-only export option, and an appendix toggle.

### Risk 7: Review-item offsets break when rendering changes

**Mitigation:** Snapshot immutable answer text and stable block keys; reviewer selections store offsets against the snapshot, not live message content.

### Risk 8: Feature becomes a compliance claim

**Mitigation:** Position it as evidence organization and human review support, not certification, legal sign-off, or regulatory compliance automation.

---

## 32. Product metrics without telemetry

HilbertRaum has no telemetry, so product success cannot depend on remote analytics.

Use local-only, user-visible measures and structured beta feedback:

- Number of reviews stored locally, shown only in Diagnostics if useful.
- Number of ready versus draft reviews, locally computed.
- Export success/failure counts in local diagnostics without content.
- Usability sessions with target professionals.
- Task completion time in moderated testing.
- Error rate in citation-to-source navigation.
- Percentage of testers who correctly understand the whole-document provenance distinction.
- Qualitative reports on whether exported packs are acceptable for internal work files.

No usage data should leave the device automatically.

---

## 33. Open decisions

1. **PDF implementation:** use Electron print-to-PDF, an existing local library, or ship HTML first?
2. **Conversation deletion:** cascade reviews after warning, or detach them as generated work products?
3. **Reviewer identity:** free-text label only, or reusable local reviewer profiles?
4. **Pack manifest:** embedded, sidecar JSON, or review-record only in Version 1?
5. **Source context:** open extracted text around the citation, or integrate page-image preview immediately?
6. **Structured skill provenance:** is current per-record source metadata sufficient for invoice and bank workflows?
7. **Review title:** derive from conversation, question, or editable default?
8. **Ready status:** require every content block reviewed, or let users define a subset as material?
9. **Export retention:** store only metadata, or optionally retain an encrypted copy inside Generated documents?
10. **Application versioning:** should packs include exact build hash under Technical details?

Recommended initial resolutions:

- Ship self-contained HTML before or alongside PDF.
- Use a free-text reviewer label.
- Require all non-heading answer blocks to be reviewed for Ready.
- Store export metadata but not a duplicate exported file inside the workspace.
- Include app version by default and build hash only in Technical details.

---

## 34. Source alignment with the existing product

This proposal is designed to extend, not replace, existing HilbertRaum contracts:

- `docs/product-vision.md`: private, offline, understandable document work for normal laptop users.
- `docs/rag-design.md`: persisted citations, grounding semantics, coverage modes, whole-document provenance, and honest no-context behavior.
- `docs/design-guidelines.md`: calm presentation, progressive disclosure, inline citations, human language, and quiet accountability.
- `docs/security-model.md`: local-only processing, encrypted workspace, sandboxed renderer, typed IPC, and strict offline posture.
- `docs/architecture.md`: message coverage, generated provenance, export patterns, audit boundaries, and document-task conventions.
- `docs/data-contracts.md`: additive, tolerant, backward-compatible shared types and IPC contracts.
- `docs/known-limitations.md`: output truncation, partial document coverage, audit-log limits, and accepted source/provenance constraints.
- `docs/user-guide.md`: target workflows, document scopes, generated work products, and export behavior.

The implementation should follow the repository’s standing rules:

- Additive nullable schema changes.
- Tolerant parsing of persisted JSON.
- No behavior change for existing chat/source rendering.
- No model call where deterministic processing is sufficient.
- No network activity.
- English/German parity.
- Tests that enforce honesty and offline guarantees.

---

## 35. Definition of done for Version 1

Evidence Pack / Review Mode is complete when:

1. An eligible answer exposes **Review evidence**.
2. A review is created entirely from persisted local data.
3. Direct citations and whole-document provenance remain semantically distinct.
4. The reviewer can record decisions, evidence links, and notes.
5. The review survives restart and encrypted workspace lock/unlock.
6. Missing, changed, partial, legacy, and truncated states are honestly represented.
7. A ready review can be exported as a deterministic self-contained HTML file and PDF.
8. The export includes question, answer, review decisions, evidence register, source register, coverage, limitations, and generation metadata.
9. Exported files are generated atomically and hashed.
10. No model or network call is required for review or export.
11. Accessibility, English/German localization, security, and offline test gates pass.
12. Documentation clearly states that an evidence pack supports human review and is not a correctness certification.

---

## 36. One-sentence product description

> **Evidence Pack / Review Mode helps you check a document-grounded answer, record what you verified, and export a clear local report showing the answer, its sources, its limitations, and your review decisions.**
