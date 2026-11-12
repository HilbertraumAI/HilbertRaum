import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { en, t, UI_LANGUAGES, type MessageKey } from '../../src/shared/i18n'
import type { StartDocTaskRequest } from '../../src/shared/types'
import type { Translator } from '../../src/main/services/translation'
import { applyUiLanguageSetting, initMainI18n } from '../../src/main/services/i18n'
import { openDatabase, type Db } from '../../src/main/services/db'
import { documentsDir, getDocument } from '../../src/main/services/ingestion'
import { PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import { assertDownloadAllowed } from '../../src/main/services/downloads'
import { isFriendlyTaskError } from '../../src/main/services/doctasks'
import { buildWarnings } from '../../src/main/services/benchmark'
import { docTaskManager, importWords, scriptedTranslator, waitTerminal } from '../helpers/doctask-fixtures'
import { importScan } from '../helpers/ocr-fixtures'
import { catalogOf } from '../helpers/i18n-catalogs'

// Phase 41 — the §3.3 two-rule boundary under a GERMAN-cached main-process language:
// emissions (IPC throws, job errors) localize via tMain, while everything persisted
// (documents.error_message, benchmark warnings) keeps writing canonical English so the
// data contracts — above all the scanDetected exact match — never move (D-L4/D-L5).

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'hilbertraum-i18n-boundary-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

// The main-process language cache is module-global — never leak German into the
// other tests of this worker.
afterEach(() => {
  initMainI18n('en-US')
})

/** A two-page scan through the real pipeline (`importScan` asserts it failed as a detected scan). */
const importScanPdf = (): Promise<string> => importScan({ root: tmp, db, storeDir })

describe('Phase 41 — emissions localize, persisted rows stay English', () => {
  it('a German-cached language localizes an emitted error (the download policy refusal)', () => {
    applyUiLanguageSetting('de')

    // Emission side: the download policy refusal is thrown in German. (The persist side — a
    // scan imported under German still writes English — is the scanDetected row below.)
    let thrown = ''
    try {
      assertDownloadAllowed({ policyAllows: false, settingAllows: false })
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(thrown).toBe(t('de', 'main.download.policyDisabled'))
    expect(thrown).not.toBe(t('en', 'main.download.policyDisabled'))
  })

  it('doc-task guard throws localize, and the friendly pass-through recognizes both languages', () => {
    applyUiLanguageSetting('de')
    const manager = docTaskManager({ root: tmp, db, storeDir })
    let thrown = ''
    try {
      manager.startDocTask({ kind: 'summary', documentIds: ['some-doc'] })
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(thrown).toBe(t('de', 'main.noModelRunning'))

    // The exact-match pass-through (task.status.error keeps guard copy verbatim)
    // accepts the guard copy in EITHER language and still rejects raw errors.
    expect(isFriendlyTaskError(t('en', 'main.noModelRunning'))).toBe(true)
    expect(isFriendlyTaskError(t('de', 'main.noModelRunning'))).toBe(true)
    expect(isFriendlyTaskError('ECONNREFUSED 127.0.0.1:8080')).toBe(false)
  })

  // i18n record §3.3 rule 3: the pass-through recognizes guard copy in EVERY registered language.
  // Looping the registry covers a language the day it is registered; one left out of the filter
  // would see its own guard copy replaced by the generic failure.
  it.each(UI_LANGUAGES.map(({ code }) => code))(
    'a task that fails on a guard keeps the guard copy when main speaks %s',
    async (code) => {
      applyUiLanguageSetting(code)
      const world = { root: tmp, db, storeDir }
      const a = await importWords(world, 60, { name: 'a.txt' })
      const b = await importWords(world, 60, { name: 'b.txt' })
      // B queues behind A; the translator goes away while B waits, so B's dequeue guard throws
      // in main's language and the failure handler decides whether that text may pass.
      let available: Translator | null = scriptedTranslator()
      const manager = docTaskManager(world, { getTranslator: () => available })
      const request = (id: string): StartDocTaskRequest => ({
        kind: 'translation',
        documentIds: [id],
        params: { sourceLang: 'en', targetLang: 'de' }
      })
      const first = manager.startDocTask(request(a))
      const second = manager.startDocTask(request(b))
      available = null
      expect((await waitTerminal(manager, first.jobId)).state).toBe('done')
      const failed = await waitTerminal(manager, second.jobId)
      expect(failed.state).toBe('failed')
      expect(failed.error).toBe(t(code, 'main.translation.noModel'))

      // The language can change between the throw and the record: the same text still
      // passes whichever registered language main has switched to since.
      for (const { code: now } of UI_LANGUAGES) {
        applyUiLanguageSetting(now)
        expect(isFriendlyTaskError(t(code, 'main.translation.noModel'))).toBe(true)
      }
    }
  )

  // The pass-through is an exact match against each guard's copy rendered with no params, so a
  // guard key with a {param} could never match what its guard throws: that failure would show
  // the generic copy instead. Every key the filter accepts stays param-less in every catalog.
  it('every guard key the pass-through accepts has no {param} in any registered catalog', () => {
    // A key's English render (a placeholder left literal) passes exactly when the filter lists
    // that key, or one with the same English text: this finds the list without reading it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let accepted: MessageKey[]
    try {
      accepted = (Object.keys(en) as MessageKey[]).filter((key) => isFriendlyTaskError(t('en', key)))
    } finally {
      warn.mockRestore()
    }
    expect(accepted).toEqual(expect.arrayContaining(['main.noModelRunning', 'main.translation.noModel']))
    const withParam = accepted.flatMap((key) =>
      UI_LANGUAGES.filter(({ code }) => /\{\w+\}/.test(catalogOf(code)[key])).map(({ code }) => `${code}: ${key}`)
    )
    expect(withParam, 'guard copy with a {param} can never pass the exact-match filter').toEqual([])
  })

  it('benchmark warnings stay canonical English under a German cache (persisted in lastBenchmark)', () => {
    applyUiLanguageSetting('de')
    const warnings = buildWarnings({
      profile: 'TINY',
      driveReadMbps: 5,
      driveWriteMbps: 5,
      // #110: the interpolated slow-read warning persists canonical English too.
      effectiveReadMbps: 70
    })
    expect(warnings).toContain(t('en', 'main.benchmark.warnTiny'))
    expect(warnings).toContain(t('en', 'main.benchmark.warnSlowDrive'))
    expect(warnings).toContain(t('en', 'main.benchmark.warnSlowRead', { mbps: 70 }))
  })

  it('scanDetected survives a language switch (en → de → en)', async () => {
    initMainI18n('en-US')
    const id = await importScanPdf()
    expect(getDocument(db, id)?.scanDetected).toBe(true)

    // The derivation reads the persisted English row — the cached language is
    // irrelevant to it, in both directions.
    applyUiLanguageSetting('de')
    expect(getDocument(db, id)?.scanDetected).toBe(true)
    expect(getDocument(db, id)?.errorMessage).toBe(PDF_SCAN_DETECTED_MESSAGE)

    // A scan imported WHILE German is cached also persists English ⇒ still detected.
    const id2 = await importScanPdf()
    expect(getDocument(db, id2)?.errorMessage).toBe(t('en', 'main.ingest.pdfScanDetected')) // persisted English although German is cached
    expect(getDocument(db, id2)?.scanDetected).toBe(true)

    applyUiLanguageSetting('en')
    expect(getDocument(db, id)?.scanDetected).toBe(true)
    expect(getDocument(db, id2)?.scanDetected).toBe(true)
  })
})
