import { createHash, randomUUID } from 'node:crypto'
import type { Db } from '../db'
import { approxTokenCount, truncateToApproxTokens } from '../ingestion/chunker'
import {
  summaryBudgetWords,
  SUMMARY_OUTPUT_TOKENS,
  SUMMARY_TEMPERATURE,
  SUMMARY_SYSTEM_PROMPT,
  SUMMARY_TOKENS_PER_WORD,
  singlePassPrompt
} from '../doctasks/summary'
import type { ModelSlotArbiter } from './model-slot-arbiter'

// The ingest-time hierarchical summary tree builder (whole-document-analysis plan §4.1).
// Pack a document's chunks (in chunk_index order) into groups; summarize each group into
// one fresh level-1 node; recurse over node summaries until a single root remains. The
// whole-document summary is then a cheap read of the root (plan §4.5 Tier 1).
//
// Phase 1 invariants this file upholds:
//   - YIELDING (H3/H9/H10): one node per transaction, and at each node boundary the build
//     checks the model-slot arbiter — if chat asked for the slot it parks on
//     `arbiter.reacquire()` (it does NOT return; a returning DocTask is marked done and
//     never resumes) until chat releases, then continues from the next node in-session.
//   - PER-NODE TRANSACTION with ROLLBACK (H11): the node row + its edges write in one
//     `BEGIN…COMMIT`; a thrown insert ROLLBACKs so the shared connection is never left
//     mid-transaction (it is shared with chat and the concurrent import loop).
//   - CONTENT CACHE vs NODE IDENTITY (C3): the summary text comes from `summary_cache`
//     keyed by (content_hash, model_id); the node is ALWAYS a fresh row per structural
//     position, so identical/boilerplate groups get distinct nodes sharing one cached
//     summary — the tree shape + leaf coverage stay correct. A warm cache makes a
//     rebuild/resume cost 0 chat calls for unchanged groups.
//   - NODE VECTORS ARE NULL (L6): no embedding at build time — node vectors are produced
//     lazily by their only consumer, symmetric compare (rag-design §14.6). The build itself
//     writes zero node embeds.
//   - RESUME = DISCARD + REBUILD: a build always tears down any partial tree first and
//     rebuilds from the warm cache, so it never half-wires parent pointers and a
//     model-switch can't yield a mixed-model tree (the cache is model-keyed — M12).

/**
 * Thrown if a node-reduction level fails to shrink (see the termination note in buildTree's
 * loop). Unreachable while `minPerGroup=2` guarantees structural progress; it is a backstop
 * that turns a would-be infinite loop into a clean task failure. run() maps any non-friendly
 * error to the generic failure copy; the raw string goes to the local log only.
 */
export const TREE_BUILD_NO_PROGRESS = 'Tree build made no progress at a reduction level'

/** A child fed into a group: a chunk (level 1) or a lower node (level >= 2). */
interface BuildChild {
  id: string
  text: string
  isChunk: boolean
}

/** What `tree_meta_json` records for a ready tree (plan §3.2). */
export interface TreeMeta {
  rootId: string
  levels: number
  leafChunkCount: number
  builtAt: string
  modelId: string
  embeddingModelId: string | null
}

export interface TreeBuildDeps {
  db: Db
  /** The pinned chat model id for this build (M12 — cache + tree_meta are keyed by it). */
  modelId: string
  contextTokens: number
  signal: AbortSignal
  arbiter: ModelSlotArbiter
  jobId: string
  /** One model call (the manager's `generate` over the locked chatStream contract). */
  generate: (
    systemPrompt: string,
    prompt: string,
    maxTokens: number,
    temperature: number,
    signal: AbortSignal
  ) => Promise<string>
  /** Reports planned/committed node counts for the DocTask progress display. */
  onProgress?: (stepsDone: number, stepsTotal: number) => void
}

/** sha256 over the ORDERED child texts (position matters — document order is deterministic). */
function contentHashOf(texts: string[]): string {
  return createHash('sha256').update(texts.join('\n\n')).digest('hex')
}

/**
 * Greedy budget packing of `children` (in order) into groups whose combined approx token
 * count fits `budgetWords`, tracking child ids so the tree edges can be written. No child is
 * ever split or dropped — a child larger than the budget sits alone in its own group.
 *
 * `minPerGroup` is the structural-progress lever (HIGH_BUG vuln-scan-2026-06-21). The old
 * code assumed "a node summary <= SUMMARY_OUTPUT_TOKENS, far below a group budget" so each
 * level always shrank; that invariant is FALSE at small budgets (a ~512-token summary
 * exceeds a 200-word floor budget), which let the upper levels never reduce → infinite loop.
 * At the node-reduction levels the caller passes `minPerGroup=2`: a group is flushed only
 * once it holds >= `minPerGroup` children, so every group except the final remainder holds
 * at least two and the level's node count STRICTLY shrinks regardless of summary size. The
 * budget still governs once the minimum is met, so a roomy budget packs many per group
 * exactly as before — `minPerGroup` only bites when a single summary already blows the
 * budget (the pathological small-context case that used to hang).
 */
function groupByBudget(
  children: BuildChild[],
  budgetWords: number,
  minPerGroup = 1
): BuildChild[][] {
  const budget = Math.max(1, Math.floor(budgetWords))
  const minGroup = Math.max(1, Math.floor(minPerGroup))
  const groups: BuildChild[][] = []
  let current: BuildChild[] = []
  let currentTokens = 0
  for (const child of children) {
    const tokens = approxTokenCount(child.text)
    if (current.length >= minGroup && currentTokens + tokens > budget) {
      groups.push(current)
      current = []
      currentTokens = 0
    }
    current.push(child)
    currentTokens += tokens
  }
  if (current.length > 0) groups.push(current)
  return groups
}

/** Estimate the total node count for the progress denominator (cosmetic; refined as we go). */
function estimateNodeCount(level1Groups: number, branching: number): number {
  let total = 0
  let n = level1Groups
  const b = Math.max(2, branching)
  while (n >= 1) {
    total += n
    if (n <= 1) break
    n = Math.ceil(n / b)
  }
  return total
}

function nowIso(): string {
  return new Date().toISOString()
}

/**
 * Build (or rebuild) the summary tree for one document. Throws on abort (the parked
 * `reacquire` rejecting, or the signal aborting) so the caller's run() lands it in
 * `cancelled`/`failed`; on abort/error the document is left `tree_status='building'`
 * (resumable — reconcileStuckTrees flips it to 'pending' on next startup). On success the
 * document is `tree_status='ready'` with `tree_meta_json` set. Returns the root meta.
 */
export async function buildTree(documentId: string, deps: TreeBuildDeps): Promise<TreeMeta> {
  const { db, modelId, contextTokens, signal, arbiter, jobId, generate } = deps

  const chunkRows = db
    .prepare('SELECT id, text FROM chunks WHERE document_id = ? ORDER BY chunk_index')
    .all(documentId) as unknown as Array<{ id: string; text: string }>
  const leaves: BuildChild[] = chunkRows
    .filter((r) => r.text.trim().length > 0)
    .map((r) => ({ id: r.id, text: r.text, isChunk: true }))
  if (leaves.length === 0) {
    throw new Error(`Tree build: document ${documentId} has no chunks`)
  }

  const budgetWords = summaryBudgetWords(contextTokens)

  // Discard any partial tree from a prior (crashed/cancelled) attempt and mark building.
  // The summary_cache survives (no FK), so the rebuild reuses every cached group.
  db.exec('BEGIN')
  try {
    db.prepare('DELETE FROM tree_nodes WHERE document_id = ?').run(documentId)
    db.prepare('UPDATE documents SET tree_status = ?, updated_at = ? WHERE id = ?').run(
      'building',
      nowIso(),
      documentId
    )
    db.exec('COMMIT')
  } catch (err) {
    try {
      db.exec('ROLLBACK')
    } catch {
      /* connection may already be clean */
    }
    throw err
  }

  // Progress denominator: level-1 group count is exact; upper levels are estimated by the
  // average branching (group budget / average summary size).
  const avgSummaryWords = Math.max(1, Math.floor(SUMMARY_OUTPUT_TOKENS / SUMMARY_TOKENS_PER_WORD))
  const branching = Math.max(2, Math.floor(budgetWords / avgSummaryWords))
  const level1Count = groupByBudget(leaves, budgetWords).length
  const stepsTotal = estimateNodeCount(level1Count, branching)
  let stepsDone = 0
  deps.onProgress?.(stepsDone, stepsTotal)

  const insertNode = db.prepare(
    `INSERT INTO tree_nodes
       (id, document_id, scope_key, level, ordinal, parent_id, is_root, summary_text,
        embedding_blob, dimensions, embedding_model_id, content_hash, model_id, created_at)
     VALUES (?, ?, NULL, ?, ?, NULL, ?, ?, NULL, NULL, NULL, ?, ?, ?)`
  )
  const insertEdge = db.prepare(
    `INSERT INTO tree_edges (parent_id, child_id, child_is_chunk, ordinal) VALUES (?, ?, ?, ?)`
  )
  const setChildParent = db.prepare('UPDATE tree_nodes SET parent_id = ? WHERE id = ?')
  const cacheGet = db.prepare(
    'SELECT summary_text FROM summary_cache WHERE content_hash = ? AND model_id = ?'
  )
  const cachePut = db.prepare(
    `INSERT INTO summary_cache (content_hash, model_id, summary_text, embedding_blob,
        embedding_model_id, dimensions, created_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, ?)
     ON CONFLICT(content_hash, model_id) DO NOTHING`
  )

  /** Summarize one group's text via the content cache (0 chat calls on a hit). */
  const summarizeGroup = async (children: BuildChild[]): Promise<{ text: string; hash: string }> => {
    const childTexts = children.map((c) => c.text)
    const hash = contentHashOf(childTexts)
    const cached = cacheGet.get(hash, modelId) as unknown as { summary_text: string } | undefined
    if (cached) return { text: cached.summary_text, hash }
    // Summarize the joined group text as a single pass (one group -> one node).
    const joined = childTexts.join('\n\n')
    const summary = await generate(
      SUMMARY_SYSTEM_PROMPT,
      singlePassPrompt('this section', joined),
      SUMMARY_OUTPUT_TOKENS,
      SUMMARY_TEMPERATURE,
      signal
    )
    if (summary.length > 0) {
      cachePut.run(hash, modelId, summary, nowIso())
      return { text: summary, hash }
    }
    // Empty generation (e.g. a reasoning model that emitted only a <think> block for a
    // terse section): do NOT cache it — caching keys on (content_hash, model_id) and is read
    // first on every build/resume, so a one-time empty result would PERMANENTLY poison this
    // group (and, at the root, the whole-document summary). Fall back to a leading excerpt of
    // the source so the node is still usable, and leave the cache cold so a rebuild retries.
    return { text: truncateToApproxTokens(joined, SUMMARY_OUTPUT_TOKENS), hash }
  }

  /** Write one node + its ordered edges atomically (H11: ROLLBACK on any throw). */
  const commitNode = (node: {
    id: string
    level: number
    ordinal: number
    isRoot: boolean
    summaryText: string
    contentHash: string
    children: BuildChild[]
  }): void => {
    db.exec('BEGIN')
    try {
      insertNode.run(
        node.id,
        documentId,
        node.level,
        node.ordinal,
        node.isRoot ? 1 : 0,
        node.summaryText,
        node.contentHash,
        modelId,
        nowIso()
      )
      for (let i = 0; i < node.children.length; i++) {
        const child = node.children[i]
        insertEdge.run(node.id, child.id, child.isChunk ? 1 : 0, i)
        // Backfill the child node's parent pointer (chunks have no such column). Keeps the
        // parent_id CASCADE chain intact and gives Phase 4 an upward walk.
        if (!child.isChunk) setChildParent.run(node.id, child.id)
      }
      db.exec('COMMIT')
    } catch (err) {
      try {
        db.exec('ROLLBACK')
      } catch {
        /* keep the original error */
      }
      throw err
    }
  }

  /** Park at a node boundary if chat asked for the slot; rejects (throws) on abort. */
  const maybeYield = async (): Promise<void> => {
    if (signal.aborted) throw new DOMException('Tree build cancelled', 'AbortError')
    if (arbiter.shouldYield()) {
      db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowIso(), documentId)
      try {
        await arbiter.reacquire(jobId) // resolves when chat releases the slot
      } catch {
        // The only rejection is the arbiter tearing the slot down (cancel/lock/quit/switch).
        // Normalize it to an AbortError so run() classifies the build as `cancelled` even if
        // the task controller wasn't also aborted (robust to any abort caller).
        throw new DOMException('Tree build cancelled', 'AbortError')
      }
      if (signal.aborted) throw new DOMException('Tree build cancelled', 'AbortError')
    }
  }

  // Build level by level until one root remains.
  //
  // TERMINATION (HIGH_BUG vuln-scan-2026-06-21). Level 1 (chunks → summaries) may be 1:1 — a
  // chunk can exceed a small budget and sit alone — but it runs EXACTLY ONCE. Every higher
  // level reduces nodes against other nodes with `minPerGroup=2`, so each group holds >= 2
  // children (bar a final remainder) and the node count STRICTLY shrinks, independent of
  // model output size. The build therefore halts in <= leaves.length levels. The guard and
  // level cap below are belt-and-suspenders against a future regression of that invariant:
  // a non-shrinking node level would otherwise loop forever, issue unbounded generate()
  // calls, and — because the doc-task queue is single-slot — permanently block it.
  let currentChildren = leaves
  let level = 1
  let rootId: string | null = null
  const maxLevels = leaves.length + 1
  for (;;) {
    const minPerGroup = level === 1 ? 1 : 2
    const groups = groupByBudget(currentChildren, budgetWords, minPerGroup)
    if ((level > 1 && groups.length >= currentChildren.length) || level > maxLevels) {
      throw new Error(TREE_BUILD_NO_PROGRESS)
    }
    const isRootLevel = groups.length === 1
    const nextChildren: BuildChild[] = []
    for (let ordinal = 0; ordinal < groups.length; ordinal++) {
      if (signal.aborted) throw new DOMException('Tree build cancelled', 'AbortError')
      const group = groups[ordinal]
      const { text, hash } = await summarizeGroup(group)
      const nodeId = randomUUID()
      commitNode({
        id: nodeId,
        level,
        ordinal,
        isRoot: isRootLevel,
        summaryText: text,
        contentHash: hash,
        children: group
      })
      nextChildren.push({ id: nodeId, text, isChunk: false })
      stepsDone += 1
      // Clamp the denominator up to the numerator (the upper-level count is an estimate).
      deps.onProgress?.(stepsDone, Math.max(stepsDone, stepsTotal))
      // The root is the last node; no point yielding the slot just to finalize next.
      if (isRootLevel) break
      // Node boundary == commit boundary == yield boundary.
      await maybeYield()
    }
    if (isRootLevel) {
      rootId = nextChildren[0].id
      break
    }
    currentChildren = nextChildren
    level += 1
  }

  const meta: TreeMeta = {
    rootId: rootId!,
    levels: level,
    leafChunkCount: leaves.length,
    builtAt: nowIso(),
    modelId,
    embeddingModelId: null
  }
  // Finalize: a single atomic UPDATE (all nodes are already durably committed). A reader
  // never sees `ready` with a half-written tree_meta.
  db.prepare('UPDATE documents SET tree_status = ?, tree_meta_json = ?, updated_at = ? WHERE id = ?').run(
    'ready',
    JSON.stringify(meta),
    nowIso(),
    documentId
  )
  return meta
}
