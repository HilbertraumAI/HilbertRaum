// The DocTaskManager world for the doc-task suites (doctasks*, whole-doc-*): a temp root + fresh DB + document
// store, documents imported through the REAL ingestion pipeline (the handlers re-extract the stored copy, so the
// row-only seeders in `doc-fixtures.ts` do not fit), a manager on harmless default deps, a scripted chat runtime,
// a scripted translation sidecar, and the terminal-state poll. Pure: no electron import. Every temp root comes
// from `tempRoot` (the swept prefix).
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect } from 'vitest'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  processDocument,
  type IngestionDeps
} from '../../src/main/services/ingestion'
import { DocTaskManager, type DocTaskDeps } from '../../src/main/services/doctasks'
import { recordEvent } from '../../src/main/services/audit'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'
import {
  TRANSLATION_STOP_TOKEN,
  type CompletionFinal,
  type TranslateOptions,
  type Translator
} from '../../src/main/services/translation'
import type { AuditEventType } from '../../src/shared/types'
import { tempRoot } from './db-fixtures'
import { until } from './hang-budget'

export interface DocTaskWorld {
  /** The temp root: source files are written here. */
  root: string
  db: Db
  /** `<root>/workspace/documents` — the stored copies. */
  storeDir: string
}

/** A fresh world under `tempRoot(label)`; the DB handle is closed by the #460 sweep. */
export function docTaskWorld(label: string): DocTaskWorld {
  const root = tempRoot(label)
  return { root, db: openDatabase(join(root, 'test.sqlite')), storeDir: documentsDir(join(root, 'workspace')) }
}

/** `n` distinct whitespace words `${prefix}0 … ${prefix}n-1` (distinct ⇒ distinct chunk and group hashes). */
export function wordsText(n: number, prefix = 'word'): string {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ')
}

export interface ImportOptions {
  /** The source file name under the root (default `doc.txt`). */
  name?: string
  /** Ingestion deps for the import (default none: no embedder, no cipher). */
  deps?: IngestionDeps
}

/** Import a .txt of literal `text` through the real pipeline; fails unless it ends `indexed`. Returns the id. */
export async function importText(w: DocTaskWorld, text: string, o: ImportOptions = {}): Promise<string> {
  const p = join(w.root, o.name ?? 'doc.txt')
  writeFileSync(p, text, 'utf8')
  const info = createQueuedDocument(w.db, p)
  const done = await processDocument(w.db, w.storeDir, info.id, o.deps ?? {})
  expect(done.status).toBe('indexed')
  return info.id
}

/** `importText` of `wordsText(n, prefix)`. */
export function importWords(
  w: DocTaskWorld,
  n: number,
  o: ImportOptions & { prefix?: string } = {}
): Promise<string> {
  return importText(w, wordsText(n, o.prefix), o)
}

/** Audit events written to the world's DB, as `index.ts` wires them. */
export function dbAudit(db: Db): NonNullable<DocTaskDeps['audit']> {
  return (type, message, metadata) => recordEvent(db, type as AuditEventType, message, metadata)
}

/**
 * A DocTaskManager over the world with harmless defaults — no runtime, no translator, no chat streaming, a 4,096
 * window, no ingestion deps, a no-op document-work lease, no audit — each replaced by `overrides`.
 */
export function docTaskManager(w: DocTaskWorld, overrides: Partial<DocTaskDeps> = {}): DocTaskManager {
  return new DocTaskManager({
    getDb: () => w.db,
    getRuntime: () => null,
    getTranslator: () => null,
    isChatStreaming: () => false,
    getContextTokens: () => 4096,
    getStoreDir: () => w.storeDir,
    getIngestionDeps: () => ({}),
    beginDocumentWork: () => () => {},
    ...overrides
  })
}

export type DocTaskStatusOf = ReturnType<DocTaskManager['getDocTask']>

/**
 * Poll until the task is done, failed or cancelled; a hang fails by name (with the last state) after
 * `hangBudgetMs(localMs)`. Real time throughout (hang-budget's `until`), so it also works under fake timers.
 */
export async function waitTerminal(m: DocTaskManager, jobId: string, localMs = 10_000): Promise<DocTaskStatusOf> {
  let s = m.getDocTask(jobId)
  const terminal = (): boolean => {
    s = m.getDocTask(jobId)
    return s.state === 'done' || s.state === 'failed' || s.state === 'cancelled'
  }
  await until(terminal, `task ${jobId} finishing`, localMs).catch(() => {
    throw new Error(`task ${jobId} never finished: ${s.state}`)
  })
  return s
}

export interface DocRuntimeCall {
  messages: ChatMessage[]
  options?: RuntimeChatOptions
}

export interface DocRuntimeOptions {
  /** The reply per call (`index` counts from 0); throwing fails that call. Default: a fixed summary line. */
  reply?: (call: DocRuntimeCall, index: number) => string
  /** Delay (ms) before each token, cut short by an abort — lets a cancel land mid-stream. */
  tokenDelayMs?: number
  /** Awaited before each call streams (a gate for queue tests). */
  gate?: () => Promise<void>
  /** `'words'` (default) streams word by word; `'whole'` yields the reply once. */
  tokens?: 'words' | 'whole'
  /** Default `'scripted-model'` (what provenance and attribution rows then carry). */
  modelId?: string
}

export interface DocRuntime extends ModelRuntime {
  calls: DocRuntimeCall[]
  /** Calls streaming right now, and the most ever streaming at once. */
  concurrent: number
  maxConcurrent: number
}

export const DEFAULT_DOC_REPLY = 'A concise summary of the document with its key points.'

/** The user turn of a call (`''` when there is none). */
export function userPromptOf(call: DocRuntimeCall): string {
  return call.messages.find((m) => m.role === 'user')?.content ?? ''
}

/** A token delay cut short by an abort. One task signal spans every token of every call, so each delay removes
 *  its abort listener again. */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const onAbort = (): void => {
      clearTimeout(t)
      resolve()
    }
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** A scripted chat runtime that records every call, counts concurrency and stops at an abort. */
export function docTaskRuntime(o: DocRuntimeOptions = {}): DocRuntime {
  const rt: DocRuntime = {
    modelId: o.modelId ?? 'scripted-model',
    calls: [],
    concurrent: 0,
    maxConcurrent: 0,
    start: async () => {},
    stop: async () => {},
    health: async () => ({ healthy: true, message: 'ok', port: null }),
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const call: DocRuntimeCall = { messages, options }
      const index = rt.calls.length
      rt.calls.push(call)
      rt.concurrent += 1
      rt.maxConcurrent = Math.max(rt.maxConcurrent, rt.concurrent)
      try {
        if (o.gate) await o.gate()
        const text = o.reply ? o.reply(call, index) : DEFAULT_DOC_REPLY
        const tokens = o.tokens === 'whole' ? [text] : (text.match(/\S+\s*/g) ?? [text])
        for (const token of tokens) {
          if (options?.signal?.aborted) return
          if (o.tokenDelayMs) await delay(o.tokenDelayMs, options?.signal)
          if (options?.signal?.aborted) return
          yield token
        }
      } finally {
        rt.concurrent -= 1
      }
    }
  }
  return rt
}

export interface ScriptedTranslatorOptions {
  /** Reply per call; throwing fails that call. Default: a perfect echo translator. */
  reply?: (call: TranslateOptions, index: number) => string
  /** The sidecar's launched context window (`contextWindow()`). Default 4096 (the manifest). */
  contextTokens?: number
  /** Delay (ms) before each streamed token — lets cancel land mid-window. */
  tokenDelayMs?: number
  /**
   * The final frame each (non-throwing) call reports via `onFinal` (TA-5 M6 — now load-bearing).
   * Default: a CLEAN stop (`stopping_word: <end_of_turn>`). Return `{}` to model a LIMIT stop
   * (truncation) — a non-empty window that the handler must treat as a failed attempt.
   */
  final?: (call: TranslateOptions, index: number) => CompletionFinal
}

export interface ScriptedTranslator extends Translator {
  calls: TranslateOptions[]
}

/**
 * A scripted Translator (the TG-3 sidecar seam). The default reply is a "perfect
 * translator": it returns the window text verbatim, so the stitched output is
 * byte-comparable to the source — exactly what the D36 regression needs.
 */
export function scriptedTranslator(opts: ScriptedTranslatorOptions = {}): ScriptedTranslator {
  const translator: ScriptedTranslator = {
    modelId: 'scripted-translator',
    calls: [],
    contextWindow: () => opts.contextTokens ?? 4096,
    stop: async () => {},
    async translate(call: TranslateOptions): Promise<string> {
      const index = translator.calls.length
      translator.calls.push(call)
      const text = opts.reply ? opts.reply(call, index) : call.text
      if (opts.tokenDelayMs) {
        for (const token of text.match(/\S+\s*/g) ?? [text]) {
          // The real runtime rejects on abort; a clean return exercises the handler's
          // aborted-normalization the same way the old mock chat runtime did.
          if (call.signal?.aborted) return ''
          await delay(opts.tokenDelayMs, call.signal)
          call.onToken?.(token)
        }
      }
      // A normal resolve ALWAYS carries a terminal frame (the runtime throws IncompleteStreamError
      // otherwise) — model it so `isCleanStop(final)` can tell a clean stop from a limit stop (M6).
      call.onFinal?.(opts.final ? opts.final(call, index) : { stoppingWord: TRANSLATION_STOP_TOKEN })
      return text
    }
  }
  return translator
}
