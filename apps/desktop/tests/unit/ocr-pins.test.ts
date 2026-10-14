import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateRuntimeSources, type OcrSources } from '../../src/shared/runtime-sources'
import { OCR_PINS, ocrPinRelPath } from '../../src/main/services/ocr-install'

// #410 — OCR_PINS (services/ocr-install.ts) is the CODE-side anchor for what the in-app
// installer fetches; the committed model-manifests/runtime-sources.yaml `ocr:` block
// supplies ONLY the download URL (the installer refuses a yaml whose sha256 disagrees).
// This is the drift net: the two must describe the SAME files — same languages, same
// hashes, same fixed destination — or the installer would refuse every install against
// the real shipped drive. It also holds OCR_PINS to the licence-review table in
// docs/model-policy.md, the only other statement of the exact sizes (the yaml carries none).

const MiB = 1024 * 1024

const repoRoot = join(__dirname, '../../../../')

function shippedOcrBlock(): OcrSources {
  const raw = parseYaml(readFileSync(join(repoRoot, 'model-manifests', 'runtime-sources.yaml'), 'utf8'))
  const result = validateRuntimeSources(raw)
  expect(result.ok, result.errors.join('; ')).toBe(true)
  expect(result.ocr).toBeDefined()
  return result.ocr as OcrSources
}

describe('OCR_PINS matches the committed runtime-sources.yaml ocr: block (#410)', () => {
  it('the same set of files — exactly deu + eng + the osd orientation data (#538) — on both sides', () => {
    const ocr = shippedOcrBlock()
    expect(OCR_PINS.map((p) => p.lang).sort()).toEqual(['deu', 'eng', 'osd'])
    expect(ocr.files.map((f) => f.lang).sort()).toEqual(['deu', 'eng', 'osd'])
  })

  it('the same real sha256 per language: a lower-case 64-hex pin (never a placeholder) the yaml repeats exactly', () => {
    const ocr = shippedOcrBlock()
    for (const pin of OCR_PINS) {
      expect(pin.sha256, pin.lang).toMatch(/^[a-f0-9]{64}$/)
      const file = ocr.files.find((f) => f.lang === pin.lang)
      expect(file, pin.lang).toBeDefined()
      expect(file?.sha256).toBe(pin.sha256)
    }
  })

  it('the yaml dest equals ocrPinRelPath(lang) for every pin (the installer ignores dest, but the committed file must still state the truth)', () => {
    const ocr = shippedOcrBlock()
    for (const pin of OCR_PINS) {
      const file = ocr.files.find((f) => f.lang === pin.lang)
      expect(file?.dest).toBe(ocrPinRelPath(pin.lang))
    }
  })

  it('every pin: a positive integer size no larger than 8 MiB, and the bundle stays under 12 MiB', () => {
    let total = 0
    for (const pin of OCR_PINS) {
      expect(Number.isInteger(pin.sizeBytes)).toBe(true)
      expect(pin.sizeBytes).toBeGreaterThan(0)
      expect(pin.sizeBytes).toBeLessThanOrEqual(8 * MiB)
      total += pin.sizeBytes
    }
    expect(total).toBeLessThanOrEqual(12 * MiB)
  })
})

interface PolicyTableRow {
  lang: string
  sha256: string | undefined
  sizeBytes: number | undefined
}

/**
 * The asset table of docs/model-policy.md "The OCR asset class": one entry per row whose first cell is a backticked
 * `ocr/<lang>.traineddata.gz`, with the backticked sha256 of its second cell and the `(<n> bytes)` count of its third.
 * Rows are split on `|`, so re-aligning the columns does not break the parse; a hash or count that cannot be read stays
 * `undefined` and fails the comparison below.
 */
function policyTableRows(): PolicyTableRow[] {
  const md = readFileSync(join(repoRoot, 'docs', 'model-policy.md'), 'utf8')
  const start = md.indexOf('\n## The OCR asset class')
  expect(start, 'docs/model-policy.md has a "The OCR asset class" section').toBeGreaterThanOrEqual(0)
  const end = md.indexOf('\n## ', start + 1)
  const rows: PolicyTableRow[] = []
  for (const line of md.slice(start, end === -1 ? undefined : end).split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue
    const cells = line.split('|').map((c) => c.trim())
    const asset = /^`ocr\/([a-z]+)\.traineddata\.gz`$/.exec(cells[1] ?? '')
    if (!asset) continue
    const bytes = /\(([\d,]+) bytes\)/.exec(cells[3] ?? '')?.[1]
    rows.push({
      lang: asset[1],
      sha256: /^`([a-f0-9]{64})`$/.exec(cells[2] ?? '')?.[1],
      sizeBytes: bytes === undefined ? undefined : Number(bytes.replace(/,/g, ''))
    })
  }
  return rows
}

describe('OCR_PINS matches docs/model-policy.md "The OCR asset class" (#410 §5)', () => {
  it('the licence-review table lists the same files with the same sha256 and exact byte size as OCR_PINS', () => {
    const rows = policyTableRows()
    // Sorted lists, not sets: a language listed twice in the table fails here too.
    expect(rows.map((r) => r.lang).sort()).toEqual(OCR_PINS.map((p) => p.lang).sort())
    for (const pin of OCR_PINS) {
      expect(rows.find((r) => r.lang === pin.lang), pin.lang).toEqual({
        lang: pin.lang,
        sha256: pin.sha256,
        sizeBytes: pin.sizeBytes
      })
    }
  })
})
