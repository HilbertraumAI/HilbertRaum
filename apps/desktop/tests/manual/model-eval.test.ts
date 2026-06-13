import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync, statSync, mkdtempSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { hostname, tmpdir } from 'node:os'
import { openDatabase, type Db } from '../../src/main/services/db'
import { encodeVector } from '../../src/main/services/embeddings'
import { createE5Embedder } from '../../src/main/services/embeddings/e5'
import { createLlamaReranker } from '../../src/main/services/reranker'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import { generateGroundedAnswer, ragSettingsFrom, type RagRetrievalSettings } from '../../src/main/services/rag'
import { createConversation, appendMessage } from '../../src/main/services/chat'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import {
  scoreItem,
  aggregate,
  toCsvRow,
  QA_CSV_HEADER,
  type EvalItem,
  type CorpusChunk,
  type ItemScore
} from '../eval/score'

// MANUAL Phase-29 quality benchmark (model-benchmarks.md §2 / D19) — NOT CI.
//
// Runs the hand-authored German/English grounded-QA set (eval/rag_de_en.jsonl, ~15%
// unanswerable) through the app's REAL RAG path — the SAME embedder + reranker + grounding
// template + chat runtime users get — for EVERY chat model on the drive, scoring each answer
// with the deterministic, judge-free scorer (tests/eval/score.ts). No cloud judge, no
// telemetry; Wi-Fi off (the eval data is committed, the weights are already on the drive).
//
//   HILBERTRAUM_MODEL_EVAL=<root with runtime/llama.cpp/<os>/llama-server + models/{embeddings,chat,reranker}/*.gguf>
//   HILBERTRAUM_EVAL_MODEL=<one chat .gguf filename>   # optional: score a single model
//   HILBERTRAUM_EVAL_MACHINE=<label>                   # optional: CSV machine column (default hostname)
//   HILBERTRAUM_EVAL_BACKEND=cpu|vulkan                # optional: CSV backend column (default cpu)
//   HILBERTRAUM_EVAL_DIR=<dir>                         # optional: override the eval/ data dir
//   npx vitest run tests/manual/model-eval.test.ts
//
// Retrieval is IDENTICAL across chat models (one E5 embedding of the corpus, one reranker),
// so every cross-model delta in EM / citation-correctness / abstention is the chat model
// following the grounded prompt — exactly the §5.4 comparison. Greedy decoding (temperature
// 0) for reproducibility. Per-model QA columns + a per-item audit dump are written to
// eval/results/ (the speed/RSS columns from §5.1/§5.2 are joined in per the protocol doc).

const ROOT = process.env.HILBERTRAUM_MODEL_EVAL?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const PATIENT_MS = 300_000

const EVAL_DIR = process.env.HILBERTRAUM_EVAL_DIR?.trim() || resolve(__dirname, '../../../../eval')
const CORPUS_PATH = join(EVAL_DIR, 'corpus_de_en.jsonl')
const ITEMS_PATH = join(EVAL_DIR, 'rag_de_en.jsonl')
const RESULTS_DIR = join(EVAL_DIR, 'results')

const MACHINE = process.env.HILBERTRAUM_EVAL_MACHINE?.trim() || hostname()
const BACKEND = process.env.HILBERTRAUM_EVAL_BACKEND?.trim() || 'cpu'

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as T)
}

/** Group corpus chunks into documents (by title), ordered by `index`, and embed+seed them. */
async function seedCorpus(
  db: Db,
  embedder: { id: string; embed: (t: string[]) => Promise<Float32Array[]> },
  corpus: CorpusChunk[]
): Promise<void> {
  const now = new Date().toISOString()
  const byDoc = new Map<string, CorpusChunk[]>()
  for (const c of corpus) {
    const list = byDoc.get(c.doc) ?? []
    list.push(c)
    byDoc.set(c.doc, list)
  }
  for (const [title, chunks] of byDoc) {
    chunks.sort((a, b) => a.index - b.index)
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run(docId, title, now, now)
    const vectors = await embedder.embed(chunks.map((c) => c.text))
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = randomUUID()
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, docId, chunks[i].index, chunks[i].text, title, i + 1, null, chunks[i].text.split(/\s+/).length, now)
      db.prepare(
        `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
    }
  }
}

function firstModel(root: string, sub: string): string | null {
  const dir = join(root, 'models', sub)
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

/** Every chat GGUF on the drive (the whole catalog), or just HILBERTRAUM_EVAL_MODEL when set. */
function chatModels(root: string): Array<{ id: string; path: string }> {
  const dir = join(root, 'models', 'chat')
  if (!existsSync(dir)) return []
  const only = process.env.HILBERTRAUM_EVAL_MODEL?.trim()
  return readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .filter((f) => !only || f === only)
    .map((f) => ({ id: f.replace(/\.gguf$/, ''), path: join(dir, f) }))
}

describe.skipIf(!enabled)('Phase-29 model quality benchmark (manual, real RAG path)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const e5Path = enabled ? firstModel(ROOT, 'embeddings') : null
  const rerankPath = enabled ? firstModel(ROOT, 'reranker') : null

  it(
    'scores every catalog chat model on the grounded-QA set and writes eval/results CSVs',
    { timeout: 24 * 60 * 60 * 1000 },
    async () => {
      expect(binPath, 'llama-server binary not found on the drive').toBeTruthy()
      expect(e5Path, 'no embeddings GGUF on the drive').toBeTruthy()
      expect(rerankPath, 'no reranker GGUF on the drive').toBeTruthy()
      expect(existsSync(CORPUS_PATH), `corpus missing: ${CORPUS_PATH}`).toBe(true)
      expect(existsSync(ITEMS_PATH), `eval items missing: ${ITEMS_PATH}`).toBe(true)

      const corpus = readJsonl<CorpusChunk>(CORPUS_PATH)
      const items = readJsonl<EvalItem>(ITEMS_PATH)
      const models = chatModels(ROOT)
      expect(models.length, 'no chat GGUFs found on the drive').toBeGreaterThan(0)
      // Every answerable item's gold_doc must exist in the corpus (authoring sanity).
      const docTitles = new Set(corpus.map((c) => c.doc))
      for (const it of items) {
        if (!it.unanswerable && it.gold_doc) {
          expect(docTitles.has(it.gold_doc), `gold_doc not in corpus: ${it.gold_doc} (${it.id})`).toBe(true)
        }
      }

      const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'hilbertraum-eval-')), 'eval.sqlite'))
      const embedder = createE5Embedder({
        id: 'multilingual-e5-small-q8',
        binPath: binPath!,
        modelPath: e5Path!,
        healthTimeoutMs: PATIENT_MS
      })
      const reranker = createLlamaReranker({
        id: 'bge-reranker-v2-m3-f16',
        binPath: binPath!,
        modelPath: rerankPath!,
        healthTimeoutMs: PATIENT_MS
      })

      mkdirSync(RESULTS_DIR, { recursive: true })
      const csvRows: string[] = [QA_CSV_HEADER.join(',')]
      const auditLines: string[] = []

      try {
        await seedCorpus(db, embedder, corpus)

        for (const model of models) {
          // eslint-disable-next-line no-console
          console.log(`\n=== ${model.id} (${items.length} items) ===`)
          const runtime = createLlamaRuntime(
            { modelId: model.id, modelPath: model.path, contextTokens: 8192 },
            { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
          )
          await runtime.start()
          const scores: ItemScore[] = []
          try {
            for (const item of items) {
              const conv = createConversation(db, { title: item.id })
              appendMessage(db, { conversationId: conv.id, role: 'user', content: item.question })
              const msg = await generateGroundedAnswer(
                db,
                runtime,
                embedder,
                conv.id,
                item.question,
                SETTINGS,
                { reranker, runtimeOptions: { maxTokens: 384, temperature: 0 } }
              )
              const citations = (msg.citations ?? []).map((c) => ({ label: c.label, sourceTitle: c.sourceTitle }))
              const citedTexts = (msg.citations ?? []).map((c) => c.snippet ?? '')
              const s = scoreItem(item, { answer: msg.content, citations, citedTexts })
              scores.push(s)
              auditLines.push(
                JSON.stringify({
                  model: model.id,
                  ...s,
                  answer: msg.content,
                  citations: citations.map((c) => `${c.label}=${c.sourceTitle}`)
                })
              )
            }
          } finally {
            await runtime.stop()
          }
          const agg = aggregate(model.id, scores)
          csvRows.push(toCsvRow(agg))
          // eslint-disable-next-line no-console
          console.log(
            `  EM ${(agg.emRate * 100).toFixed(0)}% (de ${(agg.emRateDe * 100).toFixed(0)} / en ${(
              agg.emRateEn * 100
            ).toFixed(0)}) | cite-correct ${(agg.citationCorrectRate * 100).toFixed(0)}% | abstain(unans) ${(
              agg.abstainRate * 100
            ).toFixed(0)}% | halluc ${(agg.hallucinationRate * 100).toFixed(0)}%`
          )
        }
      } finally {
        await reranker.stop()
        await embedder.stop()
        db.close()
      }

      const stem = `${MACHINE}-${BACKEND}`.replace(/[^A-Za-z0-9._-]+/g, '_')
      const csvPath = join(RESULTS_DIR, `${stem}-quality.csv`)
      const auditPath = join(RESULTS_DIR, `${stem}-items.jsonl`)
      writeFileSync(csvPath, csvRows.join('\n') + '\n', 'utf8')
      writeFileSync(auditPath, auditLines.join('\n') + '\n', 'utf8')
      // eslint-disable-next-line no-console
      console.log(`\nWrote ${csvPath}\nWrote ${auditPath}`)
      expect(csvRows.length).toBe(models.length + 1)
    }
  )
})
