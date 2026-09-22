import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  composeOcrEngine,
  probeOcrEngine,
  refreshOcrSlot,
  type OcrSlot
} from '../../src/main/services/compose-services'
import { TesseractOcrEngine, type OcrAvailability, type OcrEngine } from '../../src/main/services/ocr'

// Issue #410 — the OCR slot refresh after an in-app install (the transcriber twin is
// compose-transcriber.test.ts). `refreshOcrSlot` re-reads the drive's REAL `ocr/` folder (a temp
// drive here) and applies the three D2 rules: a null slot is composed + probed, an engine that
// could not start with the same language set is probed again, and a LIVE engine whose language
// set grew is left alone with a "restart required" verdict. The engine itself is a fake (no
// tesseract worker is ever spawned); its probe settles the availability the way the real one does.

function tempDrive(langs: string[] = []): string {
  const root = mkdtempSync(join(tmpdir(), 'hilbertraum-compose-ocr-'))
  if (langs.length > 0) addLanguages(root, langs)
  return root
}

function addLanguages(root: string, langs: string[]): void {
  mkdirSync(join(root, 'ocr'), { recursive: true })
  for (const lang of langs) writeFileSync(join(root, 'ocr', `${lang}.traineddata.gz`), `${lang}-bytes`)
}

interface FakeEngine extends OcrEngine {
  probe: ReturnType<typeof vi.fn>
  stop: ReturnType<typeof vi.fn>
  suspend: ReturnType<typeof vi.fn>
}

/** A fake engine whose probe settles `availability()` like the real one (#232). */
function fakeEngine(
  languages: readonly string[],
  opts: { state?: OcrAvailability; probeOk?: boolean } = {}
): FakeEngine {
  let state: OcrAvailability = opts.state ?? 'probing'
  return {
    id: 'fake-ocr',
    languages,
    recognize: async () => ({ text: '', confidence: null }),
    availability: () => state,
    probe: vi.fn(async () => {
      state = opts.probeOk === false ? 'unavailable' : 'available'
      return opts.probeOk !== false
    }),
    stop: vi.fn(async () => undefined),
    suspend: vi.fn(async () => undefined)
  }
}

function slot(root: string, engine: OcrEngine | null, isDev = false): OcrSlot {
  return { ocrEngine: engine, paths: { rootPath: root }, isDev }
}

describe('refreshOcrSlot — a null slot (#410, D2 rule 1)', () => {
  it('composes an engine over the folder and probes it: activated, no restart', async () => {
    const root = tempDrive(['deu', 'eng'])
    const made: FakeEngine[] = []
    const ctx = slot(root, null)
    const outcome = await refreshOcrSlot(ctx, {
      makeEngine: (_dir, languages) => {
        const e = fakeEngine(languages)
        made.push(e)
        return e
      }
    })
    expect(outcome).toBe('activated')
    expect(made).toHaveLength(1)
    expect(ctx.ocrEngine).toBe(made[0])
    expect(ctx.ocrEngine?.languages).toEqual(['deu', 'eng'])
    expect(made[0].probe).toHaveBeenCalledTimes(1)
    expect(ctx.ocrEngine?.availability?.()).toBe('available')
  })

  it('an engine that cannot start in this build fills the slot and reports startFailed (status stays honest)', async () => {
    const root = tempDrive(['deu', 'eng'])
    const ctx = slot(root, null)
    const outcome = await refreshOcrSlot(ctx, {
      makeEngine: (_dir, languages) => fakeEngine(languages, { probeOk: false })
    })
    expect(outcome).toBe('startFailed')
    // Held on the slot, so `ocrState` reads 'unavailable' (files present, recognizer cannot run)
    // instead of 'missing' — the #232 distinction.
    expect(ctx.ocrEngine?.availability?.()).toBe('unavailable')
  })

  it('a folder that still holds no language files leaves the slot null: unchanged', async () => {
    const root = tempDrive()
    const makeEngine = vi.fn()
    const ctx = slot(root, null)
    expect(await refreshOcrSlot(ctx, { makeEngine })).toBe('unchanged')
    expect(ctx.ocrEngine).toBeNull()
    expect(makeEngine).not.toHaveBeenCalled()
  })

  it('a .part left in the folder is not a language (the suffix filter)', async () => {
    const root = tempDrive()
    mkdirSync(join(root, 'ocr'), { recursive: true })
    writeFileSync(join(root, 'ocr', 'deu.traineddata.gz.part'), 'partial')
    const ctx = slot(root, null)
    expect(await refreshOcrSlot(ctx, { makeEngine: (_d, l) => fakeEngine(l) })).toBe('unchanged')
    expect(ctx.ocrEngine).toBeNull()
  })
})

describe('refreshOcrSlot — an existing engine (#410, D2 rules 2 and 3)', () => {
  it("'unavailable' with the same language set on disk: the SAME instance is probed again", async () => {
    const root = tempDrive(['deu', 'eng'])
    const existing = fakeEngine(['deu', 'eng'], { state: 'unavailable' })
    const makeEngine = vi.fn()
    const ctx = slot(root, existing)
    expect(await refreshOcrSlot(ctx, { makeEngine })).toBe('activated')
    expect(ctx.ocrEngine).toBe(existing)
    expect(existing.probe).toHaveBeenCalledTimes(1)
    expect(makeEngine).not.toHaveBeenCalled()
  })

  it("'unavailable', same set, and the probe fails again: startFailed, still the same instance", async () => {
    const root = tempDrive(['deu', 'eng'])
    const existing = fakeEngine(['deu', 'eng'], { state: 'unavailable', probeOk: false })
    const ctx = slot(root, existing)
    expect(await refreshOcrSlot(ctx)).toBe('startFailed')
    expect(ctx.ocrEngine).toBe(existing)
  })

  it('a LIVE engine whose language set grew: restartRequired — never replaced, never stopped', async () => {
    const root = tempDrive(['deu', 'eng'])
    const live = fakeEngine(['deu'], { state: 'available' })
    const makeEngine = vi.fn()
    const ctx = slot(root, live)
    expect(await refreshOcrSlot(ctx, { makeEngine })).toBe('restartRequired')
    expect(ctx.ocrEngine).toBe(live)
    expect(makeEngine).not.toHaveBeenCalled()
    expect(live.probe).not.toHaveBeenCalled()
    expect(live.stop).not.toHaveBeenCalled()
    expect(live.suspend).not.toHaveBeenCalled()
  })

  it('an engine that could not start with a DIFFERENT set is not replaced either (restartRequired)', async () => {
    const root = tempDrive(['deu', 'eng'])
    const dead = fakeEngine(['deu'], { state: 'unavailable' })
    const ctx = slot(root, dead)
    expect(await refreshOcrSlot(ctx)).toBe('restartRequired')
    expect(ctx.ocrEngine).toBe(dead)
    expect(dead.probe).not.toHaveBeenCalled()
  })

  it("'available' with the same set: unchanged, no probe", async () => {
    const root = tempDrive(['eng', 'deu'])
    const live = fakeEngine(['deu', 'eng'], { state: 'available' })
    const ctx = slot(root, live)
    expect(await refreshOcrSlot(ctx)).toBe('unchanged')
    expect(ctx.ocrEngine).toBe(live)
    expect(live.probe).not.toHaveBeenCalled()
  })

  it("'probing' (the startup proof still running) with the same set: unchanged, no second probe", async () => {
    const root = tempDrive(['deu', 'eng'])
    const pending = fakeEngine(['deu', 'eng'], { state: 'probing' })
    const ctx = slot(root, pending)
    expect(await refreshOcrSlot(ctx)).toBe('unchanged')
    expect(pending.probe).not.toHaveBeenCalled()
  })
})

describe('refreshOcrSlot never throws (#410)', () => {
  it('a throwing engine factory reads as startFailed', async () => {
    const root = tempDrive(['deu'])
    const ctx = slot(root, null)
    const outcome = await refreshOcrSlot(ctx, {
      makeEngine: () => {
        throw new Error('boom')
      }
    })
    expect(outcome).toBe('startFailed')
    expect(ctx.ocrEngine).toBeNull()
  })

  it('a throwing folder listing reads as startFailed', async () => {
    const root = tempDrive(['deu'])
    const ctx = slot(root, fakeEngine(['deu'], { state: 'available' }))
    const outcome = await refreshOcrSlot(ctx, {
      listLanguages: () => {
        throw new Error('EIO')
      }
    })
    expect(outcome).toBe('startFailed')
  })
})

describe('composeOcrEngine + probeOcrEngine (#410, shared with startup)', () => {
  it('builds the real engine over the folder: dev starts available, packaged starts probing (#232)', () => {
    const root = tempDrive(['deu', 'eng'])
    const dev = composeOcrEngine({ rootPath: root, isDev: true })
    const packaged = composeOcrEngine({ rootPath: root, isDev: false })
    expect(dev).toBeInstanceOf(TesseractOcrEngine)
    expect(dev?.languages).toEqual(['deu', 'eng'])
    expect(dev?.availability?.()).toBe('available')
    expect(packaged?.availability?.()).toBe('probing')
    // Construction spawns nothing — the worker starts lazily on the first recognition / probe.
  })

  it('returns null without language files (no mock engine)', () => {
    expect(composeOcrEngine({ rootPath: tempDrive(), isDev: true })).toBeNull()
  })

  it('probeOcrEngine never rejects: a throwing probe reads as false', async () => {
    const engine: OcrEngine = {
      id: 'x',
      languages: ['deu'],
      recognize: async () => ({ text: '', confidence: null }),
      probe: async () => {
        throw new Error('worker exploded')
      }
    }
    await expect(probeOcrEngine(engine)).resolves.toBe(false)
  })

  it('probeOcrEngine on an engine without a probe reports its availability', async () => {
    const engine: OcrEngine = {
      id: 'x',
      languages: ['deu'],
      recognize: async () => ({ text: '', confidence: null })
    }
    await expect(probeOcrEngine(engine)).resolves.toBe(true)
  })
})

// #410 wiring pin: `main/index.ts` is composition (no unit harness), so the two consumers that
// used to CAPTURE the startup engine are pinned by source text (precedent: the #372 pin in
// runtime-ladder.test.ts). A captured value would leave "Make searchable (OCR)", photo
// re-extraction (translate/compare) and categorize on the old null after an in-app install —
// the split brain the analysis found.
describe('#410 wiring pin: the doc-task deps read the OCR engine LIVE off ctx', () => {
  const indexSrc = readFileSync(join(__dirname, '../../src/main/index.ts'), 'utf8')
  const start = indexSrc.indexOf('new DocTaskManager({')
  const block = indexSrc.slice(start, indexSrc.indexOf('\n  })\n', start))

  it('the pin found the DocTaskManager construction', () => {
    expect(start).toBeGreaterThanOrEqual(0)
    expect(block).toContain('getIngestionDeps')
    expect(block).toContain('getOcrEngine')
  })

  it('getIngestionDeps passes ctx.ocrEngine, not the startup const', () => {
    const deps = block.slice(block.indexOf('getIngestionDeps'), block.indexOf('beginDocumentWork'))
    expect(deps).toContain('ocrEngine: ctx?.ocrEngine ?? null')
    // No shorthand `ocrEngine,` / `ocrEngine }` capture of the destructured startup value.
    expect(deps).not.toMatch(/[{,]\s*ocrEngine\s*[,}]/)
  })

  it('getOcrEngine reads ctx.ocrEngine, not the startup const', () => {
    expect(block).toContain('getOcrEngine: () => ctx?.ocrEngine ?? null')
    expect(block).not.toMatch(/getOcrEngine:\s*\(\)\s*=>\s*ocrEngine\b/)
  })
})
