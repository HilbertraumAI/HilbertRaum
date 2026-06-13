import { describe, it, expect } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PdfParser, PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import {
  ImageParser,
  IMAGE_NEEDS_OCR_MESSAGE,
  IMAGE_NO_TEXT_MESSAGE,
  IMAGE_OCR_FAILED_MESSAGE
} from '../../src/main/services/ingestion/parsers/image'
import { isImagePath, isPdfPath, selectParser, supportedExtensions } from '../../src/main/services/ingestion/parsers'
import {
  createSelectedOcrEngine,
  listOcrLanguages,
  ocrAssetsDir,
  TesseractOcrEngine,
  type OcrEngine
} from '../../src/main/services/ocr'
import { resolveWorkerScriptPath } from '../../src/main/services/ocr/tesseract'
import { validateRuntimeSources } from '../../src/shared/runtime-sources'
import { planOcrDownloads, sha256Of } from '../../src/main/services/assets'
import { makePdf, makeScanOnlyPdf, makeHybridPdf, TINY_PNG } from '../helpers/fixtures'
import { sha256File } from '../../src/main/services/models'

// Phase 38 — scanned-PDF detection (step 0), the OCR engine seam + offline wiring
// (R-O2), the factory's availability rule (D14/D9: null, never a mock), the ocr:
// asset class on runtime-sources.yaml (D32), and the no-CDN sentinel. CI posture:
// zero network, zero models — the real tesseract.js module is never loaded here.

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-ocr-'))
}

describe('image-only PDF detection (step 0)', () => {
  it('fails a true scan with the friendly notice', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(2))
    await expect(PdfParser.parse(p)).rejects.toThrow(PDF_SCAN_DETECTED_MESSAGE)
  })

  it('does NOT detect a hybrid text+scan PDF — its text pages index normally', async () => {
    const dir = tmp()
    const p = join(dir, 'hybrid.pdf')
    writeFileSync(p, makeHybridPdf())
    const parsed = await PdfParser.parse(p)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0].pageNumber).toBe(1)
    expect(parsed.segments[0].text).toContain('real text layer')
  })

  it('parses a normal text PDF unchanged', async () => {
    const dir = tmp()
    const p = join(dir, 'normal.pdf')
    writeFileSync(p, makePdf('An ordinary text page with plenty of readable words on it.'))
    const parsed = await PdfParser.parse(p)
    expect(parsed.segments.length).toBe(1)
    expect(parsed.segments[0].text).toContain('ordinary text page')
  })

  it('uses stored OCR pages for a scan instead of failing (re-index/preview hook)', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(2))
    const parsed = await PdfParser.parse(p, {
      ocrPages: [
        { pageNumber: 1, text: 'Recognized page one text.' },
        { pageNumber: 2, text: 'Recognized page two text.' }
      ]
    })
    expect(parsed.segments.map((s) => s.pageNumber)).toEqual([1, 2])
    expect(parsed.segments[1].text).toBe('Recognized page two text.')
  })

  it('still fails friendly when the stored OCR pages are all empty', async () => {
    const dir = tmp()
    const p = join(dir, 'scan.pdf')
    writeFileSync(p, makeScanOnlyPdf(1))
    await expect(
      PdfParser.parse(p, { ocrPages: [{ pageNumber: 1, text: '   ' }] })
    ).rejects.toThrow(PDF_SCAN_DETECTED_MESSAGE)
  })
})

describe('photo parser (.png/.jpg OCR on import)', () => {
  const fakeEngine = (text: string): OcrEngine => ({
    id: 'fake-ocr',
    languages: ['deu', 'eng'],
    recognize: async () => ({ text, confidence: 92 })
  })

  it('registers png/jpg/jpeg and the path helpers agree', () => {
    const exts = supportedExtensions()
    for (const e of ['.png', '.jpg', '.jpeg']) expect(exts).toContain(e)
    expect(selectParser('photo.PNG')?.name).toBe('image')
    expect(isImagePath('a/b/photo.jpeg')).toBe(true)
    expect(isImagePath('a/b/doc.pdf')).toBe(false)
    expect(isPdfPath('a/b/doc.PDF')).toBe(true)
  })

  it('recognizes a photo into one page-less segment', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    const parsed = await ImageParser.parse(p, { ocrEngine: fakeEngine('Hello recognized world') })
    expect(parsed.segments).toEqual([
      { text: 'Hello recognized world', pageNumber: null, sectionLabel: null }
    ])
  })

  it('fails friendly without an engine (no OCR files on the drive)', async () => {
    const dir = tmp()
    const p = join(dir, 'page.png')
    writeFileSync(p, TINY_PNG)
    await expect(ImageParser.parse(p, {})).rejects.toThrow(IMAGE_NEEDS_OCR_MESSAGE)
  })

  it('fails friendly when no text is found / when recognition throws', async () => {
    const dir = tmp()
    const p = join(dir, 'page.jpg')
    writeFileSync(p, TINY_PNG)
    await expect(ImageParser.parse(p, { ocrEngine: fakeEngine('   ') })).rejects.toThrow(
      IMAGE_NO_TEXT_MESSAGE
    )
    const failing: OcrEngine = {
      id: 'fake',
      languages: ['eng'],
      recognize: async () => {
        throw new Error('wasm exploded: technical detail')
      }
    }
    await expect(ImageParser.parse(p, { ocrEngine: failing })).rejects.toThrow(
      IMAGE_OCR_FAILED_MESSAGE
    )
  })
})

describe('OCR factory (availability-driven, D9: null — never a mock)', () => {
  it('returns null when the ocr/ dir is absent or empty', () => {
    const root = tmp()
    const reasons: string[] = []
    expect(
      createSelectedOcrEngine({ rootPath: root, onSelect: (_k, r) => reasons.push(r) })
    ).toBeNull()
    expect(reasons[0]).toContain('no OCR language files')
  })

  it('selects an engine over the languages actually present (sorted)', () => {
    const root = tmp()
    const dir = ocrAssetsDir(root)
    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'eng.traineddata.gz'), 'x')
    writeFileSync(join(dir, 'deu.traineddata.gz'), 'x')
    writeFileSync(join(dir, 'notes.txt'), 'not a language file')
    expect(listOcrLanguages(dir)).toEqual(['deu', 'eng'])
    let got: { langDir: string; languages: string[] } | null = null
    const engine = createSelectedOcrEngine({
      rootPath: root,
      makeEngine: (langDir, languages) => {
        got = { langDir, languages }
        return { id: 'fake', languages, recognize: async () => ({ text: '', confidence: null }) }
      }
    })
    expect(engine).not.toBeNull()
    expect(got).toEqual({ langDir: dir, languages: ['deu', 'eng'] })
  })
})

describe('TesseractOcrEngine (offline wiring — R-O2)', () => {
  function fakeModule(): {
    mod: { createWorker: (...a: unknown[]) => Promise<unknown> }
    calls: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }>
    recognized: Buffer[]
    terminated: { value: boolean }
  } {
    const calls: Array<{ langs: string[]; oem: number; options: Record<string, unknown> }> = []
    const recognized: Buffer[] = []
    const terminated = { value: false }
    const mod = {
      createWorker: async (langs: unknown, oem: unknown, options: unknown) => {
        calls.push({
          langs: langs as string[],
          oem: oem as number,
          options: options as Record<string, unknown>
        })
        return {
          recognize: async (img: Buffer) => {
            recognized.push(img)
            return { data: { text: `text-${recognized.length}`, confidence: 90 } }
          },
          terminate: async () => {
            terminated.value = true
          }
        }
      }
    }
    return { mod, calls, recognized, terminated }
  }

  it('passes the explicit offline options: local langPath, gzip, no cache, LSTM-only', async () => {
    const { mod, calls } = fakeModule()
    const engine = new TesseractOcrEngine({
      langDir: 'X:/drive/ocr',
      languages: ['deu', 'eng'],
      loadTesseract: async () => mod as never
    })
    await engine.recognize(Buffer.from('img'))
    expect(calls.length).toBe(1)
    expect(calls[0].langs).toEqual(['deu', 'eng'])
    expect(calls[0].oem).toBe(1) // LSTM_ONLY — the vendored data is LSTM-only (R-O3)
    expect(calls[0].options.langPath).toBe('X:/drive/ocr')
    expect(calls[0].options.gzip).toBe(true)
    expect(calls[0].options.cacheMethod).toBe('none')
  })

  it('reuses one worker across recognitions and terminates on stop()', async () => {
    const { mod, calls, recognized, terminated } = fakeModule()
    const engine = new TesseractOcrEngine({
      langDir: '/ocr',
      languages: ['eng'],
      loadTesseract: async () => mod as never
    })
    const [a, b] = await Promise.all([
      engine.recognize(Buffer.from('1')),
      engine.recognize(Buffer.from('2'))
    ])
    expect(calls.length).toBe(1) // one warm worker
    expect(recognized.length).toBe(2)
    expect([a.text, b.text].sort()).toEqual(['text-1', 'text-2'])
    await engine.stop()
    expect(terminated.value).toBe(true)
    await expect(engine.recognize(Buffer.from('3'))).rejects.toThrow('stopped')
  })

  it('rewrites app.asar worker paths to app.asar.unpacked (packaged app)', () => {
    expect(
      resolveWorkerScriptPath('C:\\app\\resources\\app.asar\\node_modules\\tesseract.js\\w.js')
    ).toBe('C:\\app\\resources\\app.asar.unpacked\\node_modules\\tesseract.js\\w.js')
    expect(resolveWorkerScriptPath('/opt/app/resources/app.asar/node_modules/t/w.js')).toBe(
      '/opt/app/resources/app.asar.unpacked/node_modules/t/w.js'
    )
    expect(resolveWorkerScriptPath('/dev/checkout/node_modules/t/w.js')).toBe(
      '/dev/checkout/node_modules/t/w.js'
    )
  })
})

describe('runtime-sources.yaml ocr: block (D32)', () => {
  const base = {
    llama_cpp: {
      version: 'b1',
      builds: [
        { os: 'win', arch: 'x64', backend: 'cpu', url: 'u', sha256: 'h', extract_to: 'runtime/llama.cpp/win' }
      ]
    }
  }

  it('absent block stays valid (forward compatibility)', () => {
    const r = validateRuntimeSources(base)
    expect(r.ok).toBe(true)
    expect(r.ocr).toBeUndefined()
  })

  it('parses a valid ocr block', () => {
    const r = validateRuntimeSources({
      ...base,
      ocr: {
        version: '4.0.0_best_int',
        files: [
          { lang: 'deu', url: 'https://x/deu.gz', sha256: 'A'.repeat(64), dest: 'ocr/deu.traineddata.gz' },
          { lang: 'eng', url: 'https://x/eng.gz', sha256: 'b'.repeat(64), dest: 'ocr/eng.traineddata.gz' }
        ]
      }
    })
    expect(r.ok).toBe(true)
    expect(r.ocr?.files.map((f) => f.lang)).toEqual(['deu', 'eng'])
    expect(r.ocr?.files[0].sha256).toBe('a'.repeat(64)) // normalized lower-case
  })

  it('rejects malformed blocks: missing fields, dup langs, escaping dest', () => {
    expect(
      validateRuntimeSources({ ...base, ocr: { version: 'v', files: [{ lang: 'deu' }] } }).ok
    ).toBe(false)
    expect(
      validateRuntimeSources({
        ...base,
        ocr: {
          version: 'v',
          files: [
            { lang: 'deu', url: 'u', sha256: 'h', dest: 'ocr/a.gz' },
            { lang: 'deu', url: 'u', sha256: 'h', dest: 'ocr/b.gz' }
          ]
        }
      }).ok
    ).toBe(false)
    expect(
      validateRuntimeSources({
        ...base,
        ocr: { version: 'v', files: [{ lang: 'deu', url: 'u', sha256: 'h', dest: '../escape.gz' }] }
      }).ok
    ).toBe(false)
  })

  it('the committed runtime-sources.yaml carries a fully-pinned ocr block', async () => {
    const yaml = await import('yaml')
    const raw = yaml.parse(
      readFileSync(join(__dirname, '../../../../model-manifests/runtime-sources.yaml'), 'utf8')
    )
    const r = validateRuntimeSources(raw)
    expect(r.ok).toBe(true)
    expect(r.ocr).toBeDefined()
    expect(r.ocr?.files.map((f) => f.lang).sort()).toEqual(['deu', 'eng'])
    for (const f of r.ocr?.files ?? []) {
      expect(f.sha256).toMatch(/^[a-f0-9]{64}$/) // real pins, no placeholders
      expect(f.dest.startsWith('ocr/')).toBe(true)
    }
  })
})

describe('planOcrDownloads (assets.ts)', () => {
  const sources = (sha: string) => ({
    version: 'v',
    files: [{ lang: 'deu', url: 'https://x/deu.gz', sha256: sha, dest: 'ocr/deu.traineddata.gz' }]
  })

  it('absent file → download; matching file → present-verified; mismatch → download', async () => {
    const root = tmp()
    const data = Buffer.from('traineddata-bytes')
    const sha = sha256Of(data)

    let plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('download')

    const { mkdirSync } = require('node:fs') as typeof import('node:fs')
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), data)
    plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('present-verified')

    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz'), 'tampered')
    plan = await planOcrDownloads(root, sources(sha))
    expect(plan[0].status).toBe('download')

    plan = await planOcrDownloads(root, sources('REPLACE_WITH_REAL_HASH'))
    expect(plan[0].status).toBe('present-unverified')
  })

  it('rejects a dest escaping the drive root', async () => {
    const root = tmp()
    await expect(
      planOcrDownloads(root, {
        version: 'v',
        files: [{ lang: 'deu', url: 'u', sha256: 'h', dest: '../outside.gz' }]
      })
    ).rejects.toThrow(/escapes the drive root/)
  })
})

describe('no-CDN sentinel (R-O2: zero remote hosts in app code)', () => {
  it('no tesseract/pdfjs CDN host appears anywhere under src/', () => {
    const SRC = join(__dirname, '../../src')
    const offenders: string[] = []
    const HOSTS = ['cdn.jsdelivr.net', 'tessdata.projectnaptha.com', 'unpkg.com']
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.(ts|tsx|html|css|json)$/.test(name)) continue
        const text = readFileSync(full, 'utf8')
        for (const host of HOSTS) {
          if (text.includes(host)) offenders.push(`${full}: ${host}`)
        }
      }
    }
    walk(SRC)
    expect(offenders).toEqual([])
  })
})

describe('OCR preload channel contract', () => {
  it('the sandboxed preload literals match shared/ipc OCR_RASTER', async () => {
    // The preload hardcodes the channel names (a sandboxed preload must be a single
    // file — importing shared/ipc would split a chunk it cannot require). Keep them
    // in lockstep here.
    const src = readFileSync(join(__dirname, '../../src/preload/ocr.ts'), 'utf8')
    const { OCR_RASTER } = await import('../../src/shared/ipc')
    for (const channel of Object.values(OCR_RASTER)) {
      expect(src).toContain(`'${channel}'`)
    }
  })
})
