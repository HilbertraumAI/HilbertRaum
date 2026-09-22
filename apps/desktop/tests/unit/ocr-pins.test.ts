import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { validateRuntimeSources, type OcrSources } from '../../src/shared/runtime-sources'
import { OCR_LICENSE, OCR_PINS, ocrPinRelPath } from '../../src/main/services/ocr-install'

// #410 — OCR_PINS (services/ocr-install.ts) is the CODE-side anchor for what the in-app
// installer fetches; the committed model-manifests/runtime-sources.yaml `ocr:` block
// supplies ONLY the download URL (the installer refuses a yaml whose sha256 disagrees).
// This is the drift net: the two must describe the SAME files — same languages, same
// hashes, same fixed destination — or the installer would refuse every install against
// the real shipped drive.

const MiB = 1024 * 1024

function shippedOcrBlock(): OcrSources {
  const repoRoot = join(__dirname, '../../../../')
  const raw = parseYaml(readFileSync(join(repoRoot, 'model-manifests', 'runtime-sources.yaml'), 'utf8'))
  const result = validateRuntimeSources(raw)
  expect(result.ok, result.errors.join('; ')).toBe(true)
  expect(result.ocr).toBeDefined()
  return result.ocr as OcrSources
}

describe('OCR_PINS matches the committed runtime-sources.yaml ocr: block (#410)', () => {
  it('the same set of languages — exactly deu + eng — on both sides', () => {
    const ocr = shippedOcrBlock()
    expect(OCR_PINS.map((p) => p.lang).sort()).toEqual(['deu', 'eng'])
    expect(ocr.files.map((f) => f.lang).sort()).toEqual(['deu', 'eng'])
  })

  it('the same sha256 per language', () => {
    const ocr = shippedOcrBlock()
    for (const pin of OCR_PINS) {
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

  it('every pin: a positive integer size no larger than 8 MiB, and the total stays under it too', () => {
    let total = 0
    for (const pin of OCR_PINS) {
      expect(Number.isInteger(pin.sizeBytes)).toBe(true)
      expect(pin.sizeBytes).toBeGreaterThan(0)
      expect(pin.sizeBytes).toBeLessThanOrEqual(8 * MiB)
      total += pin.sizeBytes
    }
    expect(total).toBeLessThanOrEqual(8 * MiB)
  })

  it('every pin carries a real, lower-case 64-hex sha256 (never a placeholder)', () => {
    for (const pin of OCR_PINS) {
      expect(pin.sha256).toMatch(/^[a-f0-9]{64}$/)
    }
  })

  it('OCR_LICENSE is Apache-2.0 (docs/model-policy.md, the approved OCR asset class)', () => {
    expect(OCR_LICENSE).toBe('Apache-2.0')
  })
})
