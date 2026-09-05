import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { t } from '../../src/shared/i18n'
import { ensureDomMatrixPolyfill } from '../../src/main/services/ingestion/parsers/dommatrix-polyfill'

// EP-1 plan §11 — the REAL-Electron PDF smoke: the actual `printEvidencePackHtmlToPdf`
// (bundled FROM SOURCE, not reimplemented) runs inside the locally installed Electron
// binary, prints the CURRENT EN + DE golden pack HTML (plus, since the ZIM wave, the two
// archive-mixed goldens — PR #294 review M11, check T04-b), and the resulting PDFs are
// verified here with the already-shipped pdfjs-dist — page count, EN/DE text sentinels
// straight from the CURRENT catalog (P5 finalized the DE strings), pack-id + page-number
// footer, the document outline `generateDocumentOutline` builds from the h1→h2→h3 tree,
// the `generateTaggedPDF` mark, the kill-mid-print teardown (app quit after load →
// rejection, no output), and the no-network posture across the whole run at TWO layers
// (every Chromium request url + the app's real offline connect-guard).
//
// GATING (honest, not silent): CI installs no Electron binary at all
// (ELECTRON_SKIP_BINARY_DOWNLOAD=1 in ci.yml — "nothing here launches Electron"), so
// this file SKIPS when the binary is absent, and on Linux when no display is reachable
// (headless boxes cannot open even a hidden BrowserWindow). On the first-class Windows
// dev box a plain `npm test` always exercises it. What CANNOT run here is pinned by the
// mocked-Electron suites (evidence-pack-print-pdf.test.ts + the pipeline/IPC tests);
// what THEY cannot prove — Chromium honoring the D-1 option set — lives here.

const req = createRequire(__filename)

function electronBinaryPath(): string | null {
  try {
    const pkgDir = dirname(req.resolve('electron/package.json'))
    const rel = readFileSync(join(pkgDir, 'path.txt'), 'utf8').trim()
    const bin = join(pkgDir, 'dist', rel)
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

/**
 * Wave DEP-4: say WHY we skipped, out loud.
 *
 * Electron >= 42 removed the postinstall binary download — `path.txt` does not exist after a
 * healthy fresh `npm ci`, and the binary only materializes when something first invokes the
 * electron bin. That silently flipped this file from "always runs on the Windows dev box" (the
 * claim in the block comment above) to "never runs until someone happens to launch Electron",
 * and it did so without a single failing test: the E43 bump dropped 6 tests from the suite and
 * the only visible trace was the skip count moving 50 -> 56.
 *
 * This is the one file that drives REAL Chromium printToPDF, so a silent skip here is a silent
 * hole in exactly the evidence the wave exists to produce. Nothing here downloads ~100 MB behind
 * your back — it just refuses to be quiet about the difference between "intentionally absent"
 * and "not fetched yet".
 */
function announceSkipReason(): void {
  if (process.env.HILBERTRAUM_SKIP_ELECTRON_CHECK || process.env.ELECTRON_SKIP_BINARY_DOWNLOAD) {
    return // CI, deliberately binary-free — the documented, expected case.
  }
  let installed = true
  try {
    req.resolve('electron/package.json')
  } catch {
    installed = false
  }
  if (!installed) return // no electron at all; nothing to say.
  console.warn(
    '[evidence-pack-pdf-smoke] SKIPPED: the electron package is installed but its platform ' +
      'binary has not been downloaded yet (Electron >= 42 fetches lazily, so a fresh `npm ci` ' +
      'leaves no path.txt). Real-Chromium printToPDF coverage is OFF for this run. Run ' +
      '`npx electron --version` once to materialize the binary, then re-run.'
  )
}

const ELECTRON_BIN = electronBinaryPath()
if (ELECTRON_BIN === null) announceSkipReason()
const displayReachable =
  process.platform !== 'linux' ||
  Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)
const enabled = ELECTRON_BIN !== null && displayReachable

const GOLDEN_DIR = join(__dirname, '..', 'fixtures', 'evidence-packs')
const EN_PACK_ID = 'SMOKE-PACK-ID-EN-1f2e3d4c'
const DE_PACK_ID = 'SMOKE-PACK-ID-DE-9a8b7c6d'
// ZIM knowledge packs (PR #294 review M11 → #301, check T04-b): the two archive-mixed
// goldens print here too. Each job's OWN pack id keeps the cover sentinels distinct; the
// knowledge-pack UUIDs below are golden CONTENT (never normalized away) and must survive
// Chromium print + pdfjs extraction unchanged.
const AR_EN_PACK_ID = 'SMOKE-PACK-ID-AR-EN-2b3c4d5e'
const AR_DE_PACK_ID = 'SMOKE-PACK-ID-AR-DE-6f7a8b9c'
const ARCHIVE_PACK_ID_EN = '5c9a7e21-4b6d-4f38-9a0c-1d2e3f4a5b6c'
const ARCHIVE_PACK_ID_DE = '7e2d4c60-8a19-4b53-bc71-0f5a6d3e2c14'

interface SmokeJobResult {
  name: string
  ok: boolean
  error: string | null
  sourceHtmlRemoved: boolean
  outExists: boolean
}
interface SmokeResult {
  fatal: string | null
  results: SmokeJobResult[]
  requestedUrls: string[]
  offlineViolations: string[]
}

interface PdfFacts {
  numPages: number
  /** All pages' text items joined with single spaces, whitespace-normalized. */
  text: string
  /** `text` with ALL whitespace removed (footer fragments extract as separate items). */
  compact: string
  /** Flattened outline titles in tree order; empty = no outline. */
  outlineTitles: string[]
  /** Max outline nesting depth (1 = only the root level). */
  outlineDepth: number
  /** The /MarkInfo Marked flag — the tagged-PDF marker. */
  marked: boolean
}

async function readPdfFacts(pdfPath: string): Promise<PdfFacts> {
  ensureDomMatrixPolyfill()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(readFileSync(pdfPath)),
    verbosity: 0
  })
  const doc = await loadingTask.promise
  const parts: string[] = []
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p)
    const content = await page.getTextContent()
    for (const item of content.items) {
      const str = (item as { str?: unknown }).str
      if (typeof str === 'string' && str.length > 0) parts.push(str)
    }
  }
  const text = parts.join(' ').replace(/\s+/g, ' ')
  interface OutlineNode {
    title: string
    items?: OutlineNode[]
  }
  const outline = ((await doc.getOutline()) ?? []) as OutlineNode[]
  const titles: string[] = []
  let depth = 0
  const walk = (nodes: OutlineNode[], level: number): void => {
    for (const node of nodes) {
      titles.push(node.title)
      depth = Math.max(depth, level)
      if (node.items?.length) walk(node.items, level + 1)
    }
  }
  walk(outline, 1)
  const markInfo = (await doc.getMarkInfo()) as { Marked?: boolean } | null
  const facts: PdfFacts = {
    numPages: doc.numPages,
    text,
    compact: text.replace(/\s+/g, ''),
    outlineTitles: titles,
    outlineDepth: depth,
    marked: markInfo?.Marked === true
  }
  await loadingTask.destroy()
  return facts
}

let root = ''
let result: SmokeResult | null = null
let enPdf = ''
let dePdf = ''
let arEnPdf = ''
let arDePdf = ''
let killOut = ''
let killSource = ''
let en: PdfFacts | null = null
let de: PdfFacts | null = null
let arEn: PdfFacts | null = null
let arDe: PdfFacts | null = null

describe.skipIf(!enabled)(
  'evidence-pack PDF smoke — REAL Electron printToPDF + pdfjs (skips where the Electron binary/display is absent, e.g. CI)',
  () => {
    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), 'hilbertraum-pdfsmoke-'))

      // 1. Bundle the runner (which imports the REAL harness from source) for the child
      // Electron main process. CJS output — the classic Electron-main path, no ESM edge.
      const esbuild = await import('esbuild')
      const runnerPath = join(root, 'print-pdf-smoke-runner.cjs')
      await esbuild.build({
        entryPoints: [join(__dirname, '..', 'helpers', 'printPdfSmokeRunner.ts')],
        bundle: true,
        platform: 'node',
        format: 'cjs',
        target: 'node20',
        external: ['electron'],
        outfile: runnerPath,
        logLevel: 'silent',
        sourcemap: false
      })

      // 2. Print inputs: the CURRENT goldens (they ARE the current catalog by
      // construction — the golden suite hard-fails on drift), with the normalization
      // placeholders substituted back to concrete sentinels.
      const prepare = (golden: string, packId: string, name: string): string => {
        const html = readFileSync(join(GOLDEN_DIR, golden), 'utf8')
          .replaceAll('PACK_ID', packId)
          .replaceAll('TIMESTAMP', '2026-07-18 12:00 UTC')
        const p = join(root, name)
        writeFileSync(p, html, 'utf8')
        return p
      }
      const enHtml = prepare('relevance.html', EN_PACK_ID, 'en.html')
      const deHtml = prepare('german.html', DE_PACK_ID, 'de.html')
      const arEnHtml = prepare('archive-mixed.html', AR_EN_PACK_ID, 'archive-en.html')
      const arDeHtml = prepare('archive-mixed-de.html', AR_DE_PACK_ID, 'archive-de.html')

      enPdf = join(root, 'en.pdf')
      dePdf = join(root, 'de.pdf')
      arEnPdf = join(root, 'archive-en.pdf')
      arDePdf = join(root, 'archive-de.pdf')
      killOut = join(root, 'killed.pdf')
      killSource = join(root, 'killed.pdf.print.tmp.html')
      const resultPath = join(root, 'result.json')
      const jobFile = join(root, 'jobs.json')
      writeFileSync(
        jobFile,
        JSON.stringify({
          resultPath,
          jobs: [
            {
              name: 'en',
              htmlPath: enHtml,
              packId: EN_PACK_ID,
              outPdfPath: enPdf,
              sourceHtmlPath: join(root, 'en.pdf.print.tmp.html')
            },
            {
              name: 'de',
              htmlPath: deHtml,
              packId: DE_PACK_ID,
              outPdfPath: dePdf,
              sourceHtmlPath: join(root, 'de.pdf.print.tmp.html')
            },
            {
              name: 'archive-en',
              htmlPath: arEnHtml,
              packId: AR_EN_PACK_ID,
              outPdfPath: arEnPdf,
              sourceHtmlPath: join(root, 'archive-en.pdf.print.tmp.html')
            },
            {
              name: 'archive-de',
              htmlPath: arDeHtml,
              packId: AR_DE_PACK_ID,
              outPdfPath: arDePdf,
              sourceHtmlPath: join(root, 'archive-de.pdf.print.tmp.html')
            },
            {
              name: 'kill',
              htmlPath: enHtml,
              packId: EN_PACK_ID,
              outPdfPath: killOut,
              sourceHtmlPath: killSource,
              kill: true
            }
          ]
        }),
        'utf8'
      )

      // 3. One Electron child runs all jobs (startup dominates; ~seconds total). An
      // ISOLATED profile dir is load-bearing: the default %APPDATA%/Electron profile is
      // shared by every default-named Electron instance — a stale/foreign singleton lock
      // crashes startup with 0xFFFF7003 (and the owner runs concurrent sessions).
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE // must launch as Electron, never as plain node
      const args = [`--user-data-dir=${join(root, 'electron-profile')}`, runnerPath, jobFile]
      if (process.platform === 'linux') args.unshift('--no-sandbox') // screenshot-script posture
      const stderr: string[] = []
      const code = await new Promise<number>((resolve, reject) => {
        const child = spawn(ELECTRON_BIN!, args, { env, windowsHide: true })
        child.stderr.on('data', (d: Buffer) => stderr.push(d.toString()))
        const timer = setTimeout(() => {
          child.kill()
          reject(new Error(`electron smoke child timed out\n${stderr.join('')}`))
        }, 150_000)
        child.on('error', (e) => {
          clearTimeout(timer)
          reject(e)
        })
        child.on('exit', (c) => {
          clearTimeout(timer)
          resolve(c ?? -1)
        })
      })
      if (!existsSync(resultPath)) {
        throw new Error(`smoke child wrote no result (exit ${code})\n${stderr.join('')}`)
      }
      result = JSON.parse(readFileSync(resultPath, 'utf8')) as SmokeResult
      expect(result.fatal, `runner fatal: ${result.fatal}\n${stderr.join('')}`).toBeNull()
      expect(code).toBe(0)
      en = await readPdfFacts(enPdf)
      de = await readPdfFacts(dePdf)
      arEn = await readPdfFacts(arEnPdf)
      arDe = await readPdfFacts(arDePdf)
    }, 240_000)

    afterAll(() => {
      if (root) rmSync(root, { recursive: true, force: true })
    })

    it('EN pack: real multi-section PDF — %PDF magic, pages, question/answer/pack-id sentinels, footer page numbers', () => {
      const enResult = result!.results.find((r) => r.name === 'en')!
      expect(enResult.ok, enResult.error ?? '').toBe(true)
      expect(enResult.sourceHtmlRemoved).toBe(true)
      expect(readFileSync(enPdf).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(en!.numPages).toBeGreaterThan(0)
      // Sentinels from the CURRENT catalog + the golden's fixture content. CONTAINS, not
      // layout-exact: pdfjs extraction order varies across platforms (Windows first-class).
      expect(en!.text).toContain(t('en', 'packExport.docTitle')) // "Evidence pack"
      expect(en!.text).toContain('Contract questions') // review title (h1)
      expect(en!.text).toContain('What about termination?') // question
      expect(en!.text).toContain('Termination requires 30 days notice.') // answer
      expect(en!.text).toContain(EN_PACK_ID) // pack id (cover .mono)
      // The repeating footer: pack id + pageNumber/totalPages on page 1 (spec §17.1).
      expect(en!.compact).toContain(`1/${en!.numPages}`)
      // Text is real extractable text (searchable/selectable), not raster — proven by
      // every assertion above extracting through pdfjs.
    })

    it('EN outline: generateDocumentOutline turned the h1→h2→h3 tree into bookmarks (depth 3, no h4)', () => {
      expect(en!.outlineTitles.length).toBeGreaterThan(0)
      // The h1 root and the eight h2 section heads, per the CURRENT catalog.
      expect(en!.outlineTitles.some((title) => title.includes('Contract questions'))).toBe(true)
      expect(en!.outlineTitles).toContain(t('en', 'packExport.section.qa'))
      expect(en!.outlineTitles).toContain(t('en', 'packExport.section.sources'))
      // h3 subsections nest below — depth exactly 3 (render contract: no h4+).
      expect(en!.outlineTitles).toContain(t('en', 'packExport.qa.question'))
      expect(en!.outlineDepth).toBe(3)
    })

    it('DE pack: German sentinels from the CURRENT catalog (P5-final strings), umlauts/ß intact, DE outline', () => {
      const deResult = result!.results.find((r) => r.name === 'de')!
      expect(deResult.ok, deResult.error ?? '').toBe(true)
      expect(deResult.sourceHtmlRemoved).toBe(true)
      expect(de!.numPages).toBeGreaterThan(0)
      expect(de!.text).toContain(t('de', 'packExport.docTitle')) // "Nachweispaket"
      expect(de!.text).toContain(t('de', 'packExport.qa.question')) // "Frage"
      expect(de!.text).toContain('Vertragsfragen') // review title
      expect(de!.text).toContain('Was gilt bei Kündigung?') // question, umlaut intact
      expect(de!.text).toContain('Die Kündigungsfrist beträgt 30 Tage.') // answer
      expect(de!.text).toContain('ausschließlich') // ß through print + extraction
      expect(de!.text).toContain(DE_PACK_ID)
      expect(de!.compact).toContain(`1/${de!.numPages}`)
      expect(de!.outlineTitles).toContain(t('de', 'packExport.section.qa'))
      expect(de!.outlineDepth).toBe(3)
    })


    // ---- ZIM knowledge packs (PR #294 review M11 → #301), T04-b: the archive locator has to
    // survive the ONE step the golden bytes cannot cover — Chromium's print + text extraction.
    // The two archive-mixed goldens print here, and their pack title / pack id / article path
    // (umlaut + ß + the escaped hostile `<b>`) are read back out of the produced PDFs.
    it('EN archive pack: the article title, the archive title, the pack id and the article path all survive print + text extraction; the archive card carries the archive warning, not the legacy unresolved one', () => {
      const job = result!.results.find((r) => r.name === 'archive-en')!
      expect(job.ok, job.error ?? '').toBe(true)
      expect(job.sourceHtmlRemoved).toBe(true)
      expect(readFileSync(arEnPdf).subarray(0, 5).toString('latin1')).toBe('%PDF-')
      expect(arEn!.numPages).toBeGreaterThan(0)
      // Provenance: the article title, the pack line, and the mono locator (pack UUID + entry
      // path). The locator strings carry no spaces, so `compact` is the exact-match surface.
      expect(arEn!.text).toContain('Treibhausgas')
      expect(arEn!.text).toContain(
        `${t('en', 'packExport.evidence.archive')}: Wikipedia (DE) – Klimawandel <b>`
      )
      expect(arEn!.text).toContain(t('en', 'packExport.evidence.packId'))
      expect(arEn!.compact).toContain(ARCHIVE_PACK_ID_EN)
      expect(arEn!.text).toContain(t('en', 'packExport.evidence.article'))
      expect(arEn!.compact).toContain('Treibhausgas/Übersicht_ß')
      // The archive-specific identity warning, never the legacy document claim.
      expect(arEn!.text).toContain(t('en', 'packExport.evidence.archiveIdentity'))
      expect(arEn!.text).not.toContain(t('en', 'packExport.evidence.identityUnresolved'))
      // §16.1.7 register row: the archive type + availability wording, and no invented hash —
      // the workspace document's SHA-256 is in the PDF exactly once, on its OWN row.
      expect(arEn!.text).toContain(t('en', 'packExport.sources.typeArchive'))
      expect(arEn!.text).toContain(t('en', 'packExport.sources.availabilityArchive'))
      expect(arEn!.compact.split('ab'.repeat(32)).length - 1).toBe(1)
      // Structure survived: the pack id footer and the sources bookmark are still there.
      expect(arEn!.compact).toContain(`1/${arEn!.numPages}`)
      expect(arEn!.text).toContain(AR_EN_PACK_ID)
      expect(arEn!.outlineTitles).toContain(t('en', 'packExport.section.sources'))
    })

    it('DE archive pack: the German archive strings, the pack id and the umlaut/ß article path survive print + text extraction; the archive card carries the archive warning, not the legacy unresolved one', () => {
      const job = result!.results.find((r) => r.name === 'archive-de')!
      expect(job.ok, job.error ?? '').toBe(true)
      expect(job.sourceHtmlRemoved).toBe(true)
      expect(arDe!.numPages).toBeGreaterThan(0)
      expect(arDe!.text).toContain(t('de', 'packExport.docTitle')) // "Nachweispaket"
      expect(arDe!.text).toContain('Treibhausgas')
      expect(arDe!.text).toContain(
        `${t('de', 'packExport.evidence.archive')}: Wikipedia (DE) – Klimawandel`
      )
      expect(arDe!.text).toContain(t('de', 'packExport.evidence.packId'))
      expect(arDe!.compact).toContain(ARCHIVE_PACK_ID_DE)
      expect(arDe!.text).toContain(t('de', 'packExport.evidence.article'))
      expect(arDe!.compact).toContain('Treibhausgas/Übersicht_ß') // umlaut + ß through print
      expect(arDe!.text).toContain('ausschließlich') // ß in the document card, unchanged
      expect(arDe!.text).toContain(t('de', 'packExport.evidence.archiveIdentity'))
      expect(arDe!.text).not.toContain(t('de', 'packExport.evidence.identityUnresolved'))
      expect(arDe!.text).toContain(t('de', 'packExport.sources.typeArchive'))
      expect(arDe!.text).toContain(t('de', 'packExport.sources.availabilityArchive'))
      expect(arDe!.compact.split('cd'.repeat(32)).length - 1).toBe(1)
      expect(arDe!.compact).toContain(`1/${arDe!.numPages}`)
      expect(arDe!.text).toContain(AR_DE_PACK_ID)
      expect(arDe!.outlineTitles).toContain(t('de', 'packExport.section.sources'))
    })

    it('generateTaggedPDF produced a MARKED (tagged) PDF — best-effort accessibility, never a PDF/UA claim', () => {
      // The honest scope (known-limitations.md): Electron marks the option experimental,
      // so this asserts exactly what we claim — a tagged structure exists — and no more.
      expect(en!.marked).toBe(true)
      expect(de!.marked).toBe(true)
    })

    it('kill-mid-print (app quit after load): the REAL quit hook rejects the print, no output, source cleaned', () => {
      const kill = result!.results.find((r) => r.name === 'kill')!
      expect(kill.ok).toBe(false)
      expect(kill.error).toBeTruthy()
      expect(kill.outExists).toBe(false)
      expect(existsSync(killOut)).toBe(false)
      expect(kill.sourceHtmlRemoved).toBe(true)
      expect(existsSync(killSource)).toBe(false)
    })

    it('no network across the entire run: every Chromium request is file://, the offline guard stayed silent', () => {
      expect(result!.requestedUrls.length).toBeGreaterThan(0) // the loads themselves
      const nonFile = result!.requestedUrls.filter((u) => !u.startsWith('file://'))
      expect(nonFile).toEqual([])
      expect(result!.offlineViolations).toEqual([])
    })
  }
)
