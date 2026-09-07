import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { ZimService } from '../../src/main/services/zim'
import { searchPackTotal } from '../../src/main/services/zim/client'
import { readZimHeader, servingNameFor } from '../../src/main/services/zim/identity'
import { kiwixServeBinaryName, kiwixToolsDir } from '../../src/main/services/zim/tools'
import { zimSmokeEnv } from '../helpers/zim-smoke-env'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer } from 'node:net'
import { makeQueryExpander, type QueryExpander } from '../../src/main/services/zim/expand'
import type { ChatMessage, ModelRuntime, RuntimeChatOptions } from '../../src/main/services/runtime'

// REAL kiwix-tools + REAL ZIM end-to-end (manual smoke, the HILBERTRAUM_* convention):
// registration via real kiwix-manage, the real kiwix-serve sidecar over a generated
// library.xml, the retrieval arm producing candidates, and the viewer article read.
//
// Run with:
//   HILBERTRAUM_ZIM_SMOKE=1
//   HILBERTRAUM_ZIM_TOOLS_DIR=<dir containing kiwix-serve(.exe) + kiwix-manage(.exe), the whole
//                              unzipped bundle — ICU DLLs included>
//   HILBERTRAUM_ZIM_FILE=<path to a small .zim, e.g. wikipedia_de_climate-change_nopic>
//   HILBERTRAUM_ZIM_QUERY=<a word the pack's index will hit, e.g. Treibhausgas>
//   HILBERTRAUM_ZIM_EXPECT_ARTICLE=<optional — an entry key known to exist in that archive>
//   HILBERTRAUM_ZIM_MODEL=<optional — a chat GGUF; with HILBERTRAUM_ZIM_LLAMA_SERVER=<llama-server
//                          binary> the smoke starts it (CPU only, -ngl 0, unless
//                          HILBERTRAUM_ZIM_MODEL_NGL says otherwise) and replays the quality
//                          fixture THROUGH the #340 L3-b expansion (D-Z20), asserting the list
//                          group too — the measurement of that lever on real tools + a real model>
//
// FAIL-CLOSED (#301 P5, finding L8, plan §9.19 (d)): CI never sets HILBERTRAUM_ZIM_SMOKE, so
// `zimSmokeEnv` reports `{ requested: false }` and the suite below is a genuine skip — no test
// even exists. Once requested, a missing/invalid tools dir, either binary absent, a
// non-existent/non-ZIM file or an unset query FAILS the run instead of silently skipping it —
// the OLD `enabled = !!toolsDir && !!zimFile && existsSync(...)` flag could not express
// "requested but invalid" at all.

const gate = zimSmokeEnv(process.env)

/** The list group's hit@5 the #340 L3-b expansion reached on the real climate pack with a real
 *  chat model at the ruling (D-Z20) — the smoke asserts it whenever a model is configured. */
const LIST_GROUP_MIN_HITS = 4

let svc: ZimService | null = null
let llama: ChildProcess | null = null

afterAll(async () => {
  await svc?.stop()
  llama?.kill()
})

/** A free loopback port for the smoke's own llama-server. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/**
 * The optional real model behind the #340 L3-b expansion (D-Z20): a llama-server started by the
 * smoke over the GGUF the operator named, and a minimal `ModelRuntime` over its OpenAI endpoint
 * (non-streaming; the same request body `runtime/llama.ts` sends — thinking switch, temperature,
 * max_tokens, the grammar-constrained `response_format`). Null when the operator set no model.
 */
async function startExpansionModel(): Promise<ModelRuntime | null> {
  const model = process.env.HILBERTRAUM_ZIM_MODEL ?? ''
  const exe = process.env.HILBERTRAUM_ZIM_LLAMA_SERVER ?? ''
  if (model === '' || exe === '') return null
  expect(existsSync(model), 'HILBERTRAUM_ZIM_MODEL must be a file').toBe(true)
  expect(existsSync(exe), 'HILBERTRAUM_ZIM_LLAMA_SERVER must be a file').toBe(true)
  const port = await freePort()
  const ngl = process.env.HILBERTRAUM_ZIM_MODEL_NGL ?? '0'
  llama = spawn(
    exe,
    ['-m', model, '--host', '127.0.0.1', '--port', String(port), '-c', '4096', '-ngl', ngl, '--jinja', '--reasoning-format', 'deepseek', '-np', '1'],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  )
  const deadline = Date.now() + 180_000
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/health`)
      if (r.status === 200) break
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error('llama-server did not become healthy within 180 s')
    await new Promise((r) => setTimeout(r, 500))
  }
  const modelId = basename(model)
  return {
    modelId,
    async start() {},
    async stop() {},
    async health() {
      return { healthy: true, message: 'smoke llama-server', port }
    },
    async *chatStream(messages: ChatMessage[], options?: RuntimeChatOptions) {
      const body = JSON.stringify({
        model: modelId,
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        stream: false,
        cache_prompt: true, // the app runtime sets it too: the system prefix is prefilled once per session
        chat_template_kwargs: { enable_thinking: options?.mode === 'deep' },
        ...(options?.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
        ...(options?.temperature != null ? { temperature: options.temperature } : {}),
        ...(options?.responseSchema
          ? { response_format: { type: 'json_schema', json_schema: { name: options.responseSchemaName ?? 'response', schema: options.responseSchema, strict: true } } }
          : {})
      })
      const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: options?.signal
      })
      if (!res.ok) throw new Error(`llama-server ${res.status}`)
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> }
      const content = json.choices?.[0]?.message?.content ?? ''
      if (content) yield content
      options?.onFinish?.('stop')
    }
  }
}

describe.runIf(gate.requested)('ZIM knowledge packs against real kiwix-tools', () => {
  it('the requested smoke has valid inputs', () => {
    // Re-asserted (fail-closed): a requested-but-invalid smoke must fail HERE, not skip.
    expect((gate as { problems: string[] }).problems).toEqual([])
  })

  it(
    'registers, serves, retrieves and reads an article — fully offline',
    async () => {
      // Re-assert before touching the disk (§9.19 (d)2) — the first `it` above is the primary
      // fail-closed gate, but a suite run in isolation (`-t` filter) must not skip this check.
      const { toolsDir, zimFile, query, expectArticle } = gate as {
        toolsDir: string
        zimFile: string
        query: string
        expectArticle: string | null
        problems: string[]
      }
      expect((gate as { problems: string[] }).problems).toEqual([])

      // Lay out a throwaway drive root with the binaries where resolution expects them.
      const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-real-'))
      const binDir = kiwixToolsDir(root)
      // The WHOLE tools dir, not just the two exes: the Windows kiwix-tools build ships its
      // ICU DLLs alongside the binaries (a lone exe dies with STATUS_DLL_NOT_FOUND) — the
      // manual-install instruction is therefore "unzip everything into runtime/kiwix-tools/<os>/".
      cpSync(toolsDir, binDir, { recursive: true })
      expect(existsSync(join(binDir, kiwixServeBinaryName()))).toBe(true)
      mkdirSync(join(root, 'zim'), { recursive: true })
      const db: Db = openDatabase(join(root, 'test.sqlite'))
      svc = new ZimService({ rootPath: root, isDev: true })
      expect(svc.toolsInstalled()).toBe(true)

      // Register the real archive (kiwix-manage reads the header).
      const pack = await svc.registerPack(db, zimFile)
      expect(pack.id).toMatch(/^[0-9a-f-]{36}$/i)
      expect(pack.articleCount).toBeGreaterThan(0)
      expect(pack.available).toBe(true)
      // Known identity: kiwix-manage's `id` and our own header reader must agree (#301 P5).
      expect(pack.id).toBe(readZimHeader(zimFile).uuid)

      // The current serving map (route contract — #301 P3b finding L4, P5's `withServer`
      // consumes the same `ServedLibrary`): the pack is served under EXACTLY libkiwix's own
      // slug rule for the path we registered it under, never the filename stem.
      const library = await svc.ensureServer(db)
      expect(library).not.toBeNull()
      expect(library!.names.get(pack.id)).toBe(servingNameFor(zimFile, process.platform))

      // The arm: real sidecar start + Xapian search + article fetch + chunking — through the
      // #340 L3-b expansion when the operator named a model (D-Z20), plain otherwise.
      const expansionRuntime = await startExpansionModel()
      const expand: QueryExpander | null = makeQueryExpander(expansionRuntime)
      // eslint-disable-next-line no-console
      console.info(`[zim-real] query expansion: ${expand ? `ON (${expansionRuntime!.modelId})` : 'off (no HILBERTRAUM_ZIM_MODEL)'}`)
      const arm = svc.makeArm(db, [pack.id], { expand })
      expect(arm).not.toBeNull()
      const t0 = performance.now()
      const { candidates } = await arm!(query)
      const ms = performance.now() - t0
      expect(candidates.length).toBeGreaterThan(0)
      const first = candidates[0]!
      expect(first.sourceKind).toBe('archive')
      expect(first.packId).toBe(pack.id)
      expect(first.text.length).toBeGreaterThan(50)
      expect(first.text).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i) // no markup survives
      expect(first.text.toLowerCase()).toContain(query.toLowerCase())
      // eslint-disable-next-line no-console
      console.info(
        `[zim-real] ${basename(zimFile)}: ${candidates.length} candidates in ${ms.toFixed(0)} ms ` +
          `(first: "${first.sourceTitle}" › ${first.sectionLabel ?? '—'})`
      )

      // #353 review fix 6: the ladder's whole premise — that a REAL kiwix-serve 3.8.1 emits
      // `<opensearch:totalResults>` for `format=xml` and honours `pageLength=1` — was proven only
      // against this repo's own fixture servers until now. Ask the real sidecar directly.
      const totalStart = performance.now()
      const knownTotal = await searchPackTotal(library!.port, pack.id, query)
      const knownMs = performance.now() - totalStart
      const inventedWord = 'qzxvwtrkp'
      const inventedStart = performance.now()
      const inventedTotal = await searchPackTotal(library!.port, pack.id, inventedWord)
      const inventedMs = performance.now() - inventedStart
      // eslint-disable-next-line no-console
      console.info(
        `[zim-real] searchPackTotal: "${query}" → ${String(knownTotal)} (${knownMs.toFixed(0)} ms); ` +
          `"${inventedWord}" → ${String(inventedTotal)} (${inventedMs.toFixed(0)} ms)`
      )
      expect(knownTotal).not.toBeNull()
      expect(knownTotal!).toBeGreaterThan(0)
      expect(inventedTotal).toBe(0)

      // #340 L3 (D-Z18): the retrieval-quality fixture, replayed only when the registered archive
      // IS the fixture's pack (the expected titles are that pack's). Every answerable question
      // must reach one of its expected articles among the top five the arm searched — the
      // measured 9/9 of the rewrite (the raw question managed 6/9). Another archive is not a
      // measurement of this fixture, and says so.
      const fixture = JSON.parse(
        readFileSync(join(__dirname, '..', 'fixtures', 'zim', 'quality-questions-de.json'), 'utf8')
      ) as {
        packUuid: string
        questions: Array<{
          question: string
          expectedTitles: string[]
          rawHit: boolean
          answerable: boolean
          group?: string
          /** #340 L3-b: logged through the arm, never asserted — the lever is not built. */
          measuredOnly?: boolean
        }>
      }
      if (pack.id === fixture.packUuid) {
        const misses: string[] = []
        const asserted = fixture.questions.filter((x) => x.answerable && !x.measuredOnly)
        for (const q of asserted) {
          const { candidates: found } = await arm!(q.question)
          const titles = [...new Set(found.map((c) => c.sourceTitle))].slice(0, 5)
          if (!q.expectedTitles.some((t) => titles.includes(t))) misses.push(`${q.question} → ${titles.join(' | ')}`)
        }
        // eslint-disable-next-line no-console
        console.info(`[zim-real] quality fixture: ${asserted.length - misses.length}/${asserted.length} answerable questions hit@5`)
        expect(misses).toEqual([])
        // #340 L3-b: the list / superlative shape, measured through the app's arm as it ships
        // and LOGGED only (the concept-expansion lever is an open owner question, not code).
        const measured = fixture.questions.filter((x) => x.answerable && x.measuredOnly)
        let hits = 0
        for (const q of measured) {
          // With a model: the expansion the arm will use, logged once more here for the record
          // (one extra call per question — a smoke, not the app path).
          let note = ''
          if (expand) {
            const e0 = performance.now()
            const ex = await expand(q.question)
            note = ` [expansion ${(performance.now() - e0).toFixed(0)} ms: ${ex ? `concepts=${ex.concepts.join(' ')}; listTitle=${ex.listTitle ?? '—'}` : 'null'}]`
          }
          const { candidates: found } = await arm!(q.question)
          const titles = [...new Set(found.map((c) => c.sourceTitle))].slice(0, 5)
          const hit = q.expectedTitles.some((t) => titles.includes(t))
          if (hit) hits++
          // eslint-disable-next-line no-console
          console.info(`[zim-real] ${q.group ?? 'measured'} ${hit ? 'HIT ' : 'miss'} ${q.question} → ${titles.join(' | ')}${note}`)
        }
        if (measured.length > 0) {
          // eslint-disable-next-line no-console
          console.info(`[zim-real] ${measured[0]!.group ?? 'measured'} questions through the arm: ${hits}/${measured.length} hit@5${expand ? ' (with the L3-b expansion — asserted)' : ' (no model — logged, not asserted)'}`)
          // D-Z20: with a real model the list group must reach the figure measured at the
          // ruling (2026-09-07); without one the plain arm's 2/6 is the honest, logged state.
          if (expand) expect(hits).toBeGreaterThanOrEqual(LIST_GROUP_MIN_HITS)
        }
      } else {
        // eslint-disable-next-line no-console
        console.info('[zim-real] quality fixture: the registered archive is not the fixture pack — not measured')
      }

      // The viewer read — routed from the CURRENT serving map, never a filename-stem guess
      // (#301 P3b finding L4).
      const article = await svc.getArticle(db, pack.id, first.articlePath!)
      expect(article).not.toBeNull()
      expect(article!.title).toBe(first.sourceTitle)
      expect(article!.sections.length).toBeGreaterThan(0)
      expect(article!.partial).toBe(false)

      // Optional: a known entry key, when the operator supplied one.
      if (expectArticle !== null) {
        const known = await svc.getArticle(db, pack.id, expectArticle)
        expect(known).not.toBeNull()
        expect(known!.title.length).toBeGreaterThan(0)
      }

      // Disable → the pack is no longer searched, and the ask still gets its outcome (#301 P4,
      // review M6: `makeArm` returns an arm for every non-empty selection so a disabled pack
      // reports "not searched: disabled" instead of silently vanishing). Re-aligned at P7 —
      // the real-tool run found the pre-P4 `toBeNull()` expectation still here (T19).
      svc.setPackEnabled(db, pack.id, false)
      const disabledArm = svc.makeArm(db, [pack.id])
      expect(disabledArm).not.toBeNull()
      const after = await disabledArm!(query)
      expect(after.candidates).toEqual([])
      expect(after.outcomes.map((o) => [o.packId, o.status, o.reason])).toEqual([[pack.id, 'skipped', 'disabled']])
    },
    // A model-backed replay spends several seconds per question on a CPU (D-Z20).
    process.env.HILBERTRAUM_ZIM_MODEL ? 600_000 : 120_000
  )
})
