import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import {
  createSelectedOcrEngine,
  listOcrLanguages,
  ocrAssetsDir
} from '../../src/main/services/ocr'

// MANUAL OCR smoke (Phase 38, wave-3 plan §14 R-O2/R-O3 live verification) — NOT CI.
//
// CI stays zero-network/zero-model, so this file is skipped unless HILBERTRAUM_OCR_SMOKE
// points at a root whose ocr/ dir holds the vendored language files (the whisper-smoke
// shape):
//
//   HILBERTRAUM_OCR_SMOKE=<root with ocr/deu.traineddata.gz + ocr/eng.traineddata.gz>
//   HILBERTRAUM_OCR_IMAGE=<a real German scan image (png/jpg) — NEVER committed>
//   npx vitest run tests/manual/ocr-smoke.test.ts
//
// Against the REAL pinned tesseract.js + the real vendored traineddata this proves
// what the fake-engine tests cannot:
//   R-O2: recognition runs with ZERO remote connection attempts (a net.Socket watch —
//         the offline-guard mechanism — runs for the whole recognition), and
//   R-O3: real German umlaut/ß quality on a real scan image.
// The hidden-window PDF rasterizer leg needs Electron and is covered by the built-app
// eyeball walk (walk-phase38), not by this harness.
//
// Findings 2026-06-11 (dev box): german-scan 150-DPI JPEG → confidence 95, all probe
// words exact in both runtimes; degraded ~82-DPI JPEG → best_int 3 misses of 104
// words vs fast 7 (the shipped-variant decision); zero remote attempts.

const ROOT = process.env.HILBERTRAUM_OCR_SMOKE?.trim() ?? ''
const IMAGE = process.env.HILBERTRAUM_OCR_IMAGE?.trim() ?? ''
const enabled =
  ROOT.length > 0 &&
  existsSync(ROOT) &&
  listOcrLanguages(ocrAssetsDir(ROOT)).length > 0 &&
  IMAGE.length > 0 &&
  existsSync(IMAGE)

describe.skipIf(!enabled)('HILBERTRAUM_OCR_SMOKE — real tesseract.js on a real scan', () => {
  it(
    'recognizes German text from the vendored assets with zero remote attempts',
    { timeout: 300_000 },
    async () => {
      // Net watch (the offline-guard mechanism): any non-loopback connect is a failure.
      const remoteAttempts: string[] = []
      const origConnect = net.Socket.prototype.connect
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(net.Socket.prototype as any).connect = function (...args: unknown[]) {
        const a = args[0] as Record<string, unknown> | string
        const host =
          typeof a === 'object' && a !== null
            ? String(a.host ?? a.path ?? 'unknown')
            : typeof args[1] === 'string'
              ? (args[1] as string)
              : String(a)
        if (!/^(127\.|::1|localhost$)/.test(host)) remoteAttempts.push(host)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (origConnect as any).apply(this, args)
      }
      try {
        const engine = createSelectedOcrEngine({ rootPath: ROOT })
        expect(engine).not.toBeNull()
        const image = readFileSync(IMAGE)
        const t0 = Date.now()
        const result = await engine!.recognize(image)
        const ms = Date.now() - t0
        // eslint-disable-next-line no-console
        console.log(
          `[ocr-smoke] languages=${engine!.languages.join(',')} confidence=${result.confidence} ` +
            `ms=${ms} chars=${result.text.length}`
        )
        // eslint-disable-next-line no-console
        console.log(`[ocr-smoke] text head:\n${result.text.slice(0, 400)}`)
        expect(result.text.trim().length).toBeGreaterThan(20)
        expect(result.confidence ?? 0).toBeGreaterThan(60)
        // German letter sanity on a German scan: at least one umlaut/ß survived.
        expect(/[äöüÄÖÜß]/.test(result.text)).toBe(true)
        expect(remoteAttempts).toEqual([])
        await engine!.stop?.()
      } finally {
        net.Socket.prototype.connect = origConnect
      }
    }
  )
})

describe.skipIf(enabled)('HILBERTRAUM_OCR_SMOKE disabled', () => {
  it('skips without HILBERTRAUM_OCR_SMOKE/HILBERTRAUM_OCR_IMAGE (CI posture: zero network, zero assets)', () => {
    expect(enabled).toBe(false)
  })
})
