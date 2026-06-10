import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, statSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase, type Db } from '../../src/main/services/db'
import { encodeVector } from '../../src/main/services/embeddings'
import { createE5Embedder } from '../../src/main/services/embeddings/e5'
import { createLlamaReranker } from '../../src/main/services/reranker'
import { createLlamaRuntime } from '../../src/main/services/runtime/llama'
import { resolveLlamaServerPath } from '../../src/main/services/runtime/sidecar'
import {
  retrieve,
  generateGroundedAnswer,
  ragSettingsFrom,
  type RagRetrievalSettings
} from '../../src/main/services/rag'
import { createConversation, appendMessage } from '../../src/main/services/chat'
import { DEFAULT_SETTINGS } from '../../src/shared/types'

// MANUAL end-to-end RAG quality check (Phase 21, retrieval-plan §3 — the "does hybrid +
// rerank actually IMPROVE answers?" question the mechanics smokes don't answer) — NOT CI.
//
//   PAID_RAG_QUALITY=<root with runtime/llama.cpp/<os>/llama-server + models/{embeddings,chat,reranker}/*.gguf>
//   npx vitest run tests/manual/rag-quality.test.ts
//
// Uses ALL THREE real backends (E5 embedder + bge reranker + Qwen3 chat) on a small but
// realistic multi-document corpus, embedded through the exact production path. It:
//   1. compares retrieve() ordering reranker-OFF vs reranker-ON (does rerank reorder, and
//      toward the genuinely-relevant chunk?),
//   2. exercises the keyword-exact (hybrid FTS5) path with an identifier embeddings miss,
//   3. produces a real grounded, cited answer from the 4B — the end-to-end proof.
// Nothing is asserted about WHICH ordering is "better" (data-dependent); the evidence is
// the console output. Hard asserts cover only that the pipeline runs and grounds an answer.

const ROOT = process.env.PAID_RAG_QUALITY?.trim() ?? ''
const enabled = ROOT.length > 0 && existsSync(ROOT)
const PATIENT_MS = 240_000

function firstModel(root: string, sub: string): string | null {
  const dir = join(root, 'models', sub)
  if (!existsSync(dir)) return null
  const ggufs = readdirSync(dir)
    .filter((f) => f.endsWith('.gguf'))
    .map((f) => ({ path: join(dir, f), size: statSync(join(dir, f)).size }))
    .sort((a, b) => a.size - b.size)
  return ggufs.length ? ggufs[0].path : null
}

interface Doc {
  title: string
  chunks: string[]
}

// A small corpus of distinct documents, each split into a few chunk-sized passages. The
// liability-cap query has ONE true home (the MSA's liability clause) among several
// plausible distractors (other contract clauses, an invoice "amount", a policy doc).
const CORPUS: Doc[] = [
  {
    title: 'Acme Master Services Agreement.pdf',
    chunks: [
      'Payment terms: Acme shall invoice the Client monthly. Undisputed invoices are due net thirty days from the invoice date; late amounts accrue interest at one percent per month.',
      "Limitation of liability: except for breaches of confidentiality, each party's total aggregate liability under this Agreement shall not exceed one million United States dollars.",
      'Termination: either party may terminate this Agreement for convenience upon sixty days written notice, or immediately for an uncured material breach.',
      'Governing law: this Agreement is governed by the laws of the State of Delaware, without regard to its conflict-of-laws principles.'
    ]
  },
  {
    title: 'Globex Invoice INV-2024-001.pdf',
    chunks: [
      'Invoice number INV-2024-001 was issued on 12 March 2024 by Globex Corporation to the Client for consulting services rendered in February.',
      'The total amount due on this invoice is 940 euro, payable within 30 days by bank transfer to the account listed in the footer.'
    ]
  },
  {
    title: 'Employee Handbook.docx',
    chunks: [
      'Vacation policy: full-time employees accrue twenty paid vacation days per year, accruing monthly and carrying over up to five days into the next year.',
      'Remote work: employees may work remotely up to three days per week with manager approval; core collaboration hours are 10:00 to 15:00 local time.',
      'Expense reimbursement: submit receipts within thirty days; travel and client-meal expenses are reimbursed at actual cost with manager approval.'
    ]
  },
  {
    title: 'Security Whitepaper.pdf',
    chunks: [
      'All customer data is encrypted at rest with AES-256 and in transit with TLS 1.3; encryption keys are rotated annually and stored in a hardware security module.',
      'Data residency: customer data is stored exclusively in the customer-selected region and is never replicated outside it without explicit written consent.'
    ]
  }
]

const SETTINGS: RagRetrievalSettings = ragSettingsFrom(DEFAULT_SETTINGS)

async function seedCorpus(
  db: Db,
  embedder: { id: string; embed: (t: string[]) => Promise<Float32Array[]> }
): Promise<void> {
  const now = new Date().toISOString()
  for (const doc of CORPUS) {
    const docId = randomUUID()
    db.prepare(
      `INSERT INTO documents (id, title, status, created_at, updated_at) VALUES (?, ?, 'indexed', ?, ?)`
    ).run(docId, doc.title, now, now)
    const vectors = await embedder.embed(doc.chunks)
    for (let i = 0; i < doc.chunks.length; i++) {
      const chunkId = randomUUID()
      db.prepare(
        `INSERT INTO chunks (id, document_id, chunk_index, text, source_label, page_number, section_label, token_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(chunkId, docId, i, doc.chunks[i], doc.title, i + 1, null, doc.chunks[i].split(/\s+/).length, now)
      db.prepare(
        `INSERT INTO embeddings (chunk_id, embedding_model_id, vector_blob, dimensions, created_at) VALUES (?, ?, ?, ?, ?)`
      ).run(chunkId, embedder.id, encodeVector(vectors[i]), vectors[i].length, now)
    }
  }
}

describe.skipIf(!enabled)('RAG quality (manual, real E5 + reranker + Qwen3)', () => {
  const binPath = enabled ? resolveLlamaServerPath(ROOT, process.platform, {}) : null
  const e5Path = enabled ? firstModel(ROOT, 'embeddings') : null
  const rerankPath = enabled ? firstModel(ROOT, 'reranker') : null
  const chatPath = enabled ? firstModel(ROOT, 'chat') : null

  it('hybrid + rerank reorder toward relevance and ground a cited answer', { timeout: 900_000 }, async () => {
    expect(binPath).toBeTruthy()
    expect(e5Path).toBeTruthy()
    expect(rerankPath).toBeTruthy()
    expect(chatPath).toBeTruthy()

    const db = openDatabase(join(mkdtempSync(join(tmpdir(), 'paid-ragq-')), 'q.sqlite'))
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

    const fmtHits = (label: string, chunks: { sourceTitle: string; text: string; score: number }[]): void => {
      // eslint-disable-next-line no-console
      console.log(`\n--- ${label} (top ${Math.min(5, chunks.length)}) ---`)
      chunks.slice(0, 5).forEach((c, i) => {
        // eslint-disable-next-line no-console
        console.log(
          `  ${i + 1}. [${c.score.toFixed(4)}] ${c.sourceTitle} :: ${c.text.slice(0, 70)}…`
        )
      })
    }

    try {
      await seedCorpus(db, embedder)

      // (1) Semantic query with plausible distractors — compare OFF vs ON.
      const q1 = 'What is the cap on liability in our agreement with Acme?'
      const off = await retrieve(db, embedder, q1, SETTINGS, null, null)
      const on = await retrieve(db, embedder, q1, SETTINGS, null, reranker)
      // eslint-disable-next-line no-console
      console.log(`\n========== Q1: "${q1}" ==========`)
      fmtHits('reranker OFF (hybrid fused order)', off.chunks)
      fmtHits('reranker ON', on.chunks)
      const topOff = off.chunks[0]
      const topOn = on.chunks[0]
      // eslint-disable-next-line no-console
      console.log(
        `\nTop-1 OFF: ${topOff?.sourceTitle} | Top-1 ON: ${topOn?.sourceTitle} | reordered: ${
          off.chunks.map((c) => c.chunkId).join(',') !== on.chunks.map((c) => c.chunkId).join(',')
        }`
      )
      const onHasLiability = on.chunks.some((c) => /liability/i.test(c.text))
      // eslint-disable-next-line no-console
      console.log(`reranked set contains the liability clause: ${onHasLiability}`)

      // (2) Keyword-exact identifier the embedder tends to miss → hybrid FTS5 must surface it.
      const q2 = 'INV-2024-001'
      const kw = await retrieve(db, embedder, q2, SETTINGS, null, reranker)
      // eslint-disable-next-line no-console
      console.log(`\n========== Q2 (keyword-exact): "${q2}" ==========`)
      fmtHits('hybrid result', kw.chunks)
      const found = kw.chunks.some((c) => c.text.includes('INV-2024-001'))
      // eslint-disable-next-line no-console
      console.log(`hybrid surfaced the exact invoice chunk: ${found}`)
      expect(found).toBe(true)

      // (3) End-to-end grounded, cited answer from the real chat model (rerank engaged).
      const runtime = createLlamaRuntime(
        { modelId: 'qwen3-chat', modelPath: chatPath!, contextTokens: 4096 },
        { binPath: binPath!, healthTimeoutMs: PATIENT_MS }
      )
      await runtime.start()
      try {
        const conv = createConversation(db, { title: 'rag-quality' })
        appendMessage(db, { conversationId: conv.id, role: 'user', content: q1 })
        const answer = await generateGroundedAnswer(db, runtime, embedder, conv.id, q1, SETTINGS, {
          reranker,
          runtimeOptions: { maxTokens: 256 }
        })
        // eslint-disable-next-line no-console
        console.log(`\n========== Grounded answer (Q1) ==========\n${answer.content}`)
        // eslint-disable-next-line no-console
        console.log(
          '\nCitations:',
          (answer.citations ?? []).map((c) => `${c.label}=${c.sourceTitle}`).join(' | ')
        )
        expect(answer.content.length).toBeGreaterThan(0)
        expect((answer.citations ?? []).length).toBeGreaterThan(0)
      } finally {
        await runtime.stop()
      }
    } finally {
      await reranker.stop()
      await embedder.stop()
      db.close()
    }
  })
})
