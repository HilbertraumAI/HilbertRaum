import { describe, it, expect, vi } from 'vitest'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ensureDomMatrixPolyfill } from '../../src/main/services/ingestion/parsers/dommatrix-polyfill'
import {
  CCITT_SCAN_HEIGHT,
  CCITT_SCAN_WIDTH,
  ccittScanIsBlack,
  makeCcittScanPdf
} from '../helpers/fixtures'

// #551: pdf.js 6 decodes CCITT fax, JBIG2 and JPEG 2000 images only through modules it loads at
// run time from `wasmUrl` (pdfjs-dist/wasm/: a wasm build, and a plain-JS build it falls back
// to). The OCR rasterizer passed no `wasmUrl`, so a black-and-white office scan (CCITT G4)
// rendered as a blank page and "Make searchable (OCR)" found no text. Three links keep it
// working, one block each: the installed pdf.js decodes such a scan given `wasmUrl`; the
// renderer build ships every module the bundled worker asks for, under the name it asks for;
// and the rasterizer page passes `wasmUrl`.

const req = createRequire(__filename)
const PDFJS_WASM_DIR = join(dirname(req.resolve('pdfjs-dist/package.json')), 'wasm')

interface DecodedScan {
  /** The page's image as pdf.js decoded it, or null when pdf.js could not decode it. */
  image: { width: number; height: number; kind: number; data: Uint8Array } | null
  /** pdf.js's own warnings while it did. */
  warnings: string[]
}

async function decodeScan(options: Record<string, unknown>): Promise<DecodedScan> {
  ensureDomMatrixPolyfill()
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  // pdf.js warns through console.warn; record those lines instead of printing them.
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  const task = pdfjs.getDocument({
    data: new Uint8Array(makeCcittScanPdf()),
    verbosity: pdfjs.VerbosityLevel.WARNINGS,
    ...options
  })
  try {
    const page = await (await task.promise).getPage(1)
    const ops = await page.getOperatorList()
    const at = ops.fnArray.indexOf(pdfjs.OPS.paintImageXObject)
    expect(at, 'the scan page paints one image XObject').toBeGreaterThanOrEqual(0)
    const objId = String(ops.argsArray[at][0])
    const store = objId.startsWith('g_') ? page.commonObjs : page.objs
    const image = await new Promise<DecodedScan['image']>((resolve) => store.get(objId, resolve))
    const warnings = warn.mock.calls.map((args) => String(args[0])).filter((l) => l.startsWith('Warning:'))
    return { image, warnings }
  } finally {
    // Destroying the document also clears pdf.js's cached decoder module, so each case loads its own.
    await task.destroy()
    warn.mockRestore()
  }
}

/** Pixels that differ from the fixture's pattern. pdf.js packs 1-bit rows MSB first; a 1 bit is white. */
async function patternMismatches(image: NonNullable<DecodedScan['image']>): Promise<number> {
  const { ImageKind } = await import('pdfjs-dist/legacy/build/pdf.mjs')
  expect(image.kind).toBe(ImageKind.GRAYSCALE_1BPP)
  expect([image.width, image.height]).toEqual([CCITT_SCAN_WIDTH, CCITT_SCAN_HEIGHT])
  const rowBytes = Math.ceil(image.width / 8)
  let mismatches = 0
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      const black = (image.data[y * rowBytes + (x >> 3)]! & (0x80 >> (x & 7))) === 0
      if (black !== ccittScanIsBlack(x, y)) mismatches++
    }
  }
  return mismatches
}

describe('pdf.js decodes a CCITT G4 scan only through its decoder modules (#551)', () => {
  it('without wasmUrl the image does not decode (the scan rendered blank)', async () => {
    const { image, warnings } = await decodeScan({})
    expect(image).toBeNull()
    expect(warnings.join('\n')).toContain('`wasmUrl`')
  })

  it('with wasmUrl it decodes pixel for pixel through the wasm build', async () => {
    // A filesystem path: pdf.js reads binary data with fs in Node.
    const { image, warnings } = await decodeScan({ wasmUrl: `${PDFJS_WASM_DIR}/` })
    expect(warnings).toEqual([])
    expect(image).not.toBeNull()
    expect(await patternMismatches(image!)).toBe(0)
  })

  it('it decodes the same through the plain-JS build pdf.js falls back to', async () => {
    // pdf.js imports the JS build, so it needs a URL here.
    const { image, warnings } = await decodeScan({
      wasmUrl: `${pathToFileURL(PDFJS_WASM_DIR).href}/`,
      useWasm: false
    })
    expect(warnings).toEqual([])
    expect(image).not.toBeNull()
    expect(await patternMismatches(image!)).toBe(0)
  })
})

// Runs against out/renderer (`electron-vite build`); CI builds before it tests, and the last block
// reddens there if this one stops running (the csp-build-output idiom).
const OUT_RENDERER = join(__dirname, '..', '..', 'out', 'renderer')
const ASSETS = join(OUT_RENDERER, 'assets')
/** Must match electron.vite.config.ts `assetFileNames`. */
const DECODERS = join(OUT_RENDERER, 'pdfjs-wasm')
const built = existsSync(ASSETS)
const builtFile = (re: RegExp): string => {
  const hits = readdirSync(ASSETS).filter((f) => re.test(f))
  expect(hits, `exactly one ${re} in out/renderer/assets`).toHaveLength(1)
  return readFileSync(join(ASSETS, hits[0]!), 'utf8')
}

describe.skipIf(!built)('the renderer build ships the decoders the bundled pdf.js worker loads (#551)', () => {
  it('every module the worker names sits in pdfjs-wasm/ under that name, byte for byte', () => {
    const worker = builtFile(/^pdf\.worker-.*\.mjs$/)
    const named = [...worker.matchAll(/_(?:noWasm)?[fF]ilename = "([^"]+)"/g)].map((m) => m[1]!)
    expect(named).toEqual(
      expect.arrayContaining(['jbig2.wasm', 'jbig2_nowasm_fallback.js', 'openjpeg.wasm', 'openjpeg_nowasm_fallback.js'])
    )
    for (const name of named) {
      const shipped = join(DECODERS, name)
      expect(existsSync(shipped), `out/renderer/pdfjs-wasm/${name}`).toBe(true)
      expect(readFileSync(shipped).equals(readFileSync(join(PDFJS_WASM_DIR, name))), name).toBe(true)
    }
  })

  it('the rasterizer page derives its wasmUrl from that directory', () => {
    expect(builtFile(/^ocr-.*\.js$/)).toContain('"../pdfjs-wasm/jbig2.wasm"')
  })
})

describe('the rasterizer page hands pdf.js its decoders (#551)', () => {
  it('src/renderer/ocr/main.ts passes wasmUrl to getDocument', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'renderer', 'ocr', 'main.ts'), 'utf8')
    const calls = src.split('\n').filter((line) => line.includes('pdfjs.getDocument('))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatch(/\bwasmUrl: DECODERS_URL\b/)
  })

  it('the build-output checks above actually ran on CI', () => {
    if (process.env.CI) expect(built).toBe(true)
  })
})
