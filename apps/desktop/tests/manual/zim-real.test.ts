import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { ZimService } from '../../src/main/services/zim'
import { readZimHeader, servingNameFor } from '../../src/main/services/zim/identity'
import { kiwixServeBinaryName, kiwixToolsDir } from '../../src/main/services/zim/tools'
import { zimSmokeEnv } from '../helpers/zim-smoke-env'

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
//
// FAIL-CLOSED (#301 P5, finding L8, plan §9.19 (d)): CI never sets HILBERTRAUM_ZIM_SMOKE, so
// `zimSmokeEnv` reports `{ requested: false }` and the suite below is a genuine skip — no test
// even exists. Once requested, a missing/invalid tools dir, either binary absent, a
// non-existent/non-ZIM file or an unset query FAILS the run instead of silently skipping it —
// the OLD `enabled = !!toolsDir && !!zimFile && existsSync(...)` flag could not express
// "requested but invalid" at all.

const gate = zimSmokeEnv(process.env)

let svc: ZimService | null = null

afterAll(async () => {
  await svc?.stop()
})

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

      // The arm: real sidecar start + Xapian search + article fetch + chunking.
      const arm = svc.makeArm(db, [pack.id])
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
          const { candidates: found } = await arm!(q.question)
          const titles = [...new Set(found.map((c) => c.sourceTitle))].slice(0, 5)
          const hit = q.expectedTitles.some((t) => titles.includes(t))
          if (hit) hits++
          // eslint-disable-next-line no-console
          console.info(`[zim-real] ${q.group ?? 'measured'} ${hit ? 'HIT ' : 'miss'} ${q.question} → ${titles.join(' | ')}`)
        }
        if (measured.length > 0) {
          // eslint-disable-next-line no-console
          console.info(`[zim-real] ${measured[0]!.group ?? 'measured'} questions through the arm: ${hits}/${measured.length} hit@5 (logged, not asserted)`)
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
    120_000
  )
})
