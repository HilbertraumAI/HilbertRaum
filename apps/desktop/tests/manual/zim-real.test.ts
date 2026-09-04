import { cpSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { openDatabase, type Db } from '../../src/main/services/db'
import { ZimService } from '../../src/main/services/zim'
import { kiwixServeBinaryName, kiwixToolsDir } from '../../src/main/services/zim/tools'

// REAL kiwix-tools + REAL ZIM end-to-end (manual smoke, the HILBERTRAUM_* convention):
// registration via real kiwix-manage, the real kiwix-serve sidecar over a generated
// library.xml, the retrieval arm producing candidates, and the viewer article read.
//
// Run with:
//   HILBERTRAUM_ZIM_TOOLS=<dir containing kiwix-serve(.exe) + kiwix-manage(.exe)>
//   HILBERTRAUM_ZIM_TEST_FILE=<path to a small .zim, e.g. wikipedia_de_climate-change_nopic>
//   HILBERTRAUM_ZIM_TEST_QUERY=<a word the pack's index will hit, e.g. Treibhausgas>
//
// CI never sets these — the suite skips. Offline by construction (loopback only).

const toolsDir = process.env.HILBERTRAUM_ZIM_TOOLS
const zimFile = process.env.HILBERTRAUM_ZIM_TEST_FILE
const query = process.env.HILBERTRAUM_ZIM_TEST_QUERY ?? 'Treibhausgas'
const enabled = !!toolsDir && !!zimFile && existsSync(toolsDir) && existsSync(zimFile)

let svc: ZimService | null = null

afterAll(async () => {
  await svc?.stop()
})

describe.runIf(enabled)('ZIM knowledge packs against real kiwix-tools', () => {
  it('registers, serves, retrieves and reads an article — fully offline', async () => {
    // Lay out a throwaway drive root with the binaries where resolution expects them.
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-zim-real-'))
    const binDir = kiwixToolsDir(root)
    // The WHOLE tools dir, not just the two exes: the Windows kiwix-tools build ships its
    // ICU DLLs alongside the binaries (a lone exe dies with STATUS_DLL_NOT_FOUND) — the
    // manual-install instruction is therefore "unzip everything into runtime/kiwix-tools/<os>/".
    cpSync(toolsDir!, binDir, { recursive: true })
    expect(existsSync(join(binDir, kiwixServeBinaryName()))).toBe(true)
    mkdirSync(join(root, 'zim'), { recursive: true })
    const db: Db = openDatabase(join(root, 'test.sqlite'))
    svc = new ZimService({ rootPath: root, isDev: true })
    expect(svc.toolsInstalled()).toBe(true)

    // Register the real archive (kiwix-manage reads the header).
    const pack = await svc.registerPack(db, zimFile!)
    expect(pack.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(pack.articleCount).toBeGreaterThan(0)
    expect(pack.available).toBe(true)

    // The arm: real sidecar start + Xapian search + article fetch + chunking.
    const arm = svc.makeArm(db, [pack.id])
    expect(arm).not.toBeNull()
    const t0 = performance.now()
    const candidates = await arm!(query)
    const ms = performance.now() - t0
    expect(candidates.length).toBeGreaterThan(0)
    const first = candidates[0]!
    expect(first.sourceKind).toBe('archive')
    expect(first.packId).toBe(pack.id)
    expect(first.text.length).toBeGreaterThan(50)
    expect(first.text).not.toMatch(/<[a-z][a-z0-9-]*[\s>]/i) // no markup survives
    // eslint-disable-next-line no-console
    console.info(
      `[zim-real] ${basename(zimFile!)}: ${candidates.length} candidates in ${ms.toFixed(0)} ms ` +
        `(first: "${first.sourceTitle}" › ${first.sectionLabel ?? '—'})`
    )

    // The viewer read (filename-stem URL-id rule).
    const article = await svc.getArticle(db, pack.id, first.articlePath!)
    expect(article).not.toBeNull()
    expect(article!.title.length).toBeGreaterThan(0)
    expect(article!.sections.length).toBeGreaterThan(0)

    // Disable → the arm goes away; the sidecar is invalidated without error.
    svc.setPackEnabled(db, pack.id, false)
    expect(svc.makeArm(db, [pack.id])).toBeNull()
  }, 120_000)
})

describe.runIf(!enabled)('ZIM real smoke (skipped)', () => {
  it('needs HILBERTRAUM_ZIM_TOOLS + HILBERTRAUM_ZIM_TEST_FILE', () => {
    expect(true).toBe(true)
  })
})
