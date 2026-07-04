import type { Db } from '../../db'
import type {
  Citation,
  CoverageInfo,
  DocumentChunkRead,
  RetrievalScope,
  SkillToolAudit
} from '../../../../shared/types'
import type { MessageKey, MessageParams } from '../../../../shared/i18n'

// The per-skill analysis-handler seam (full-doc-skills plan §3.1, Phase 2). This is the bridge a
// chat turn will (in Phase 3) call instead of top-k RAG, so a `kind:tool` skill's exhaustive,
// deterministic whole-document tools answer a plain question — the relevance path is bypassed only
// when a registered handler `applies()`. Phase 2 builds the seam + the bank handler in isolation and
// does NOT wire it into chat (registerRagIpc/router/rag are untouched), so the relevance path stays
// byte-identical (R5) trivially.
//
// The handler reuses the existing app-orchestrated run seam (`run.ts`): it auto-runs the READ-ONLY
// tools (D46) for their persistence + `skill_runs` lifecycle + ids/counts audit, then synthesises a
// grounded answer from the STRUCTURED tool output (D47), never by prompt-stuffing chunks. The export
// tier is excluded by construction (never auto-fires; export stays confirm-gated). The §14 capability
// ceiling is unchanged — the only content reach is the run seam's `readDocumentChunks` over the
// frozen single-doc scope; this seam adds no new DB/FS/net handle.

/** The cheap pre-flight input (plan §3.1): "can this skill answer THIS question over THIS scope?". */
export interface SkillAnalysisInput {
  question: string
  /** The chat path's resolved retrieval scope (the SAME `RetrievalScope` registerRagIpc builds). */
  scope: RetrievalScope
  db: Db
}

/** Everything a handler needs to run the whole-document tools and localize the answer. */
export interface SkillAnalysisContext {
  db: Db
  question: string
  scope: RetrievalScope
  /** The requesting skill's `install_id` ("<source>:<id>") — for the run rows + ids/counts audit. */
  skillInstallId: string
  /** The conversation the run belongs to, if any (carried onto the `skill_runs` rows). */
  conversationId?: string | null
  /** ids/counts-only audit sink (the app's recorder adapter; a capturing fn in tests). */
  audit: SkillToolAudit
  /** Cooperative cancellation, threaded into every tool run. */
  signal?: AbortSignal
  /** Clock seam for deterministic tests. */
  now?: () => string
  /** Localized copy builder (EN/DE) — the answer is deterministic, model-free copy. */
  tr: (key: MessageKey, params?: MessageParams) => string
  /**
   * The verbatim content reach the run seam needs: a document's ordered, newline-preserving parser
   * segments (the IPC injects `extractDocumentPreview`). Absent ⇒ the run seam's legacy chunk-table
   * reader (the unit tests that seed `chunks` directly). The optional `layout` flag (plan §3.1/D58)
   * asks for geometry-aware row/column reconstruction — set ONLY by the bank-statement handler.
   */
  readDocumentSegments?: (documentId: string, opts?: { layout?: boolean }) => Promise<DocumentChunkRead[]>
}

/** The grounded result a handler returns (plan §3.1): synthesised answer + real citations + coverage. */
export interface SkillAnalysisResult {
  /** Synthesised from the structured tool output (D47) — deterministic, localized Markdown. */
  answer: string
  /** Real source chunks behind the figures (M2-safe) — never the synthesised total. A `routing`
   *  handler returns `[]`: it makes no document-grounded claim, so the renderer shows no coverage
   *  badge (the meter renders only when an answer carries citations — Transcript.tsx). */
  citations: Citation[]
  /** The honest breadth (D48) — `mode:'extract'`, `fullyChunked` gating the "whole document" wording.
   *  Omitted by a `routing` handler (it reads no content, so it makes NO breadth claim). */
  coverage?: CoverageInfo
  /**
   * W2 document-plausibility gate (audit §4.5): set to `true` when the extractor found NOTHING on a
   * document that does NOT match this skill's manifest doc signals (filename/MIME) — the single doc in
   * scope is not, in fact, a statement/invoice. The chat path then ABANDONS the honest-but-useless
   * empty template ("I read the whole statement but couldn't find any transactions") and answers the
   * user's actual question via the ordinary grounded (relevance) path instead. `answer`/`citations` are
   * ignored when this is set. A zero-row extraction on a doc that DOES look like this skill's type
   * leaves this false and keeps the honest empty answer.
   */
  fallThrough?: boolean
  /**
   * W3 THIRD answer mode (audit §3.1/§8.1): set to `'grounded-data'` when the question is neither a
   * format ask nor a summary/reconcile/list shape but still passed `applies()` — instead of the fixed
   * template, the chat path STREAMS a model answer that narrates `dataBlock` (the serialized, verified
   * extract) under the strict quote-figures-verbatim rules, then appends `postscript` (the deterministic
   * totals echo) beneath it. `answer` is empty and ignored when this is set; `citations`/`coverage` are
   * used verbatim (source of truth = the extractor). The LLM never computes a figure — it reads the data.
   */
  mode?: 'grounded-data'
  /** The serialized VERIFIED object (e.g. `buildInvoiceJson` + reconciliation results + a provenance
   *  note) the model narrates. Present iff `mode === 'grounded-data'`. */
  dataBlock?: string
  /** The deterministic figure echo appended VERBATIM under the model answer (net/tax/gross as parsed) so a
   *  model misquote is visibly contradicted (§8.1). Empty ⇒ nothing to echo. Only used with grounded-data. */
  postscript?: string
}

export interface SkillAnalysisHandler {
  /**
   * The handler's posture (default `'exhaustive'`):
   *   - `'exhaustive'` — reads the WHOLE document via read-only tools and synthesises a grounded,
   *     deterministic (model-free) answer (bank-statement, invoice). The chat path enforces the
   *     fully-chunked precondition (a legacy/partly-chunked doc is REFUSED, no partial answer) and
   *     then calls `run()`.
   *   - `'grounded-whole-doc'` — an INSTRUCTION skill (minutes, contract brief, …) whose deliverable
   *     is the MODEL's answer over the WHOLE document, formatted to the SKILL.md body. The chat path
   *     enforces the same fully-chunked precondition, then streams a model answer over the whole
   *     document via `generateGroundedAnswer({ wholeDocument })` — NOT `run()` (which these handlers
   *     omit). `applies()` does the intent + single-in-scope-doc gating.
   *   - `'grounded-whole-doc-compare'` — the 2-document sibling (what-changed): a compare-shaped
   *     request over EXACTLY TWO in-scope, fully-chunked documents streams a model answer over BOTH
   *     documents read whole (budget split across the two) with the SKILL.md format applied, via
   *     `generateGroundedAnswer({ wholeDocumentCompare })`. Also omits `run()`; `applies()` gates the
   *     intent + the exactly-two-in-scope-docs precondition.
   *   - `'routing'` — reads NO content. It returns a short answer pointing the user at the skill's
   *     own run affordance (an ACTION skill whose tool WRITES a file and must stay user-initiated,
   *     e.g. document-redaction). The fully-chunked refusal does NOT apply (nothing is read), and
   *     it returns no citations/coverage so no breadth badge is shown.
   */
  mode?: 'exhaustive' | 'grounded-whole-doc' | 'grounded-whole-doc-compare' | 'routing'
  /**
   * U2 (audit §3.5): a `grounded-whole-doc` handler (share-safe review) whose model verdict is a
   * PRIVACY gate sets this so the chat path runs the deterministic whole-document PII detectors and
   * injects their COUNTS summary into the grounded prompt, and — when the model is shown only a
   * truncated prefix — forbids the "Likely low risk" verdict. Additive/optional; every other handler
   * omits it (byte-unchanged). Deterministic; no new model call.
   */
  injectPiiScan?: boolean
  /**
   * Can this skill ENGAGE its engine over THIS scope? (cheap, pre-flight). For a TOOL skill this is a
   * vocabulary-shaped bank/invoice question over a single in-scope doc; for a whole-doc/compare INSTRUCTION
   * skill it is A3's inversion — ANY non-small-talk question over a single (resp. exactly-two) in-scope doc,
   * with no per-skill keyword required.
   */
  applies(input: SkillAnalysisInput): boolean
  /**
   * The W2 COUNT-MISMATCH ROUTING predicate (audit §2.1; A4/SKA-8 §3.2): does this question match the
   * skill's OWN routing VOCABULARY (`routeMatch`), IGNORING how many documents are in scope? Consulted by
   * the chat path ONLY when `applies()` is false (so the turn failed on the document count): a
   * vocabulary-shaped question then narrows to the skill's best-matching document (with an honest scope
   * notice) or emits a deterministic "pick one / select two" routing answer, instead of falling through.
   *
   * A4 (SKA-8) DECOUPLED this from `applies()`. Post-A3 the whole-doc handlers set `intends = !isSmallTalk`,
   * which made the W2 pre-pass intercept EVERY non-chatter question at multi-doc scope — the relevance and
   * coverage-extract engines became unreachable ("pick one document" for "who is Angela Merkel?"). Now
   * `intends()` stays VOCABULARY-shaped for every handler, so a general/off-topic question at the wrong doc
   * count falls through to the ordinary engines; only a vocabulary-shaped one narrows/routes. `applies()`
   * keeps A3's broader single-doc inversion for whole-doc skills, so the identity `applies() ⟺ intends()
   * AND count` NO LONGER holds for them (it still does for the vocabulary-gated tool skills).
   *
   * Optional/additive: a handler that omits it opts OUT of the W2 doc-count routing (e.g. the redaction
   * routing handler, whose `applies()` already accepts any count ≥ 1). Never a NEW model call.
   */
  intends?(input: SkillAnalysisInput): boolean
  /**
   * A4 (SKA-7 STRUCTURAL, audit §3.2/§8.2): the SINGLE-DOC INVERSION gate for a TOOL (exhaustive) skill —
   * the composition that finishes A3's inversion for bank/invoice. True when this ONE in-scope document
   * plausibly belongs to the skill's class (it matches the skill's manifest doc signals OR a persisted
   * extraction already exists for it). When true AND `applies()` is false (a phrasing miss) AND the doc is
   * fully chunked AND the question is not small talk, the chat path runs the handler ANYWAY — so an on-topic
   * money question that misses the ~45-term vocabulary is answered from the VERIFIED extract (grounded-data
   * narrates; post-W6 it honestly declines an off-data question) instead of silently degrading to raw top-k
   * chunks + model arithmetic (the pre-W3 incident class, on the two highest-stakes skills). A doc matching
   * NEITHER signal keeps the phrasing gate (the W2 plausibility posture, inverted). Passed the requesting
   * skill's `install_id` so it can read the manifest doc signals.
   *
   * Optional/additive: ONLY the bank/invoice exhaustive handlers define it. The whole-doc/compare handlers
   * omit it — their inversion already lives in `applies()` (`!isSmallTalk`), which is unconditional for a
   * whole read (no plausibility gate needed: reading a document and answering is always safe). Never a NEW
   * model call and NO new capability (SEC-1): it changes only WHICH questions reach an already-app-owned
   * handler, never what that handler can do.
   */
  classMatches?(input: SkillAnalysisInput, skillInstallId: string): boolean
  /**
   * Run the whole-document read-only tools and synthesise the grounded answer + real coverage, OR
   * (for a `routing` handler) return the action-routing answer with no citations/coverage. OMITTED
   * by a `grounded-whole-doc` handler — the chat path streams the model answer directly and never
   * calls this.
   */
  run?(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult>
}
