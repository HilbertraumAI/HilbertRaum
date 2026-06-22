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
   * reader (the unit tests that seed `chunks` directly).
   */
  readDocumentSegments?: (documentId: string) => Promise<DocumentChunkRead[]>
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
   *   - `'routing'` — reads NO content. It returns a short answer pointing the user at the skill's
   *     own run affordance (an ACTION skill whose tool WRITES a file and must stay user-initiated,
   *     e.g. document-redaction). The fully-chunked refusal does NOT apply (nothing is read), and
   *     it returns no citations/coverage so no breadth badge is shown.
   */
  mode?: 'exhaustive' | 'grounded-whole-doc' | 'routing'
  /** Can this skill answer THIS question over THIS scope? (cheap, pre-flight). */
  applies(input: SkillAnalysisInput): boolean
  /**
   * Run the whole-document read-only tools and synthesise the grounded answer + real coverage, OR
   * (for a `routing` handler) return the action-routing answer with no citations/coverage. OMITTED
   * by a `grounded-whole-doc` handler — the chat path streams the model answer directly and never
   * calls this.
   */
  run?(ctx: SkillAnalysisContext): Promise<SkillAnalysisResult>
}
