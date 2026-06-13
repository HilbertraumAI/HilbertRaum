import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { t } from '../../src/shared/i18n'
import { applyUiLanguageSetting, initMainI18n } from '../../src/main/services/i18n'
import { openDatabase, type Db } from '../../src/main/services/db'
import {
  createQueuedDocument,
  documentsDir,
  getDocument,
  processDocument
} from '../../src/main/services/ingestion'
import { PDF_SCAN_DETECTED_MESSAGE } from '../../src/main/services/ingestion/parsers/pdf'
import { assertDownloadAllowed } from '../../src/main/services/downloads'
import { DocTaskManager, isFriendlyTaskError } from '../../src/main/services/doctasks'
import { buildWarnings } from '../../src/main/services/benchmark'
import { makeScanOnlyPdf } from '../helpers/fixtures'

// Phase 41 — the §3.3 two-rule boundary under a GERMAN-cached main-process language:
// emissions (IPC throws, job errors) localize via tMain, while everything persisted
// (documents.error_message, benchmark warnings) keeps writing canonical English so the
// data contracts — above all the scanDetected exact match — never move (D-L4/D-L5).

let tmp: string
let db: Db
let storeDir: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'paid-i18n-boundary-'))
  db = openDatabase(join(tmp, 'test.sqlite'))
  storeDir = documentsDir(join(tmp, 'workspace'))
})

// The main-process language cache is module-global — never leak German into the
// other tests of this worker.
afterEach(() => {
  initMainI18n('en-US')
})

async function importScanPdf(): Promise<string> {
  const p = join(tmp, 'scan.pdf')
  writeFileSync(p, makeScanOnlyPdf(2))
  const info = createQueuedDocument(db, p)
  await processDocument(db, storeDir, info.id)
  return info.id
}

describe('Phase 41 — emissions localize, persisted rows stay English', () => {
  it('a German-cached language localizes an emitted error while the persisted row stays English', async () => {
    applyUiLanguageSetting('de')

    // Emission side: the download policy refusal is thrown in German…
    let thrown = ''
    try {
      assertDownloadAllowed({ policyAllows: false, settingAllows: false })
    } catch (err) {
      thrown = err instanceof Error ? err.message : String(err)
    }
    expect(thrown).toBe(t('de', 'main.download.policyDisabled'))
    expect(thrown).not.toBe(t('en', 'main.download.policyDisabled'))

    // …while the persist side keeps writing the canonical ENGLISH constant.
    const id = await importScanPdf()
    const doc = getDocument(db, id)
    expect(doc?.errorMessage).toBe(t('en', 'main.ingest.pdfScanDetected'))
    expect(doc?.errorMessage).toBe(PDF_SCAN_DETECTED_MESSAGE)
    expect(doc?.scanDetected).toBe(true)
  })

  it('doc-task guard throws localize, and the friendly pass-through recognizes both languages', () => {
    applyUiLanguageSetting('de')
    const manager = new DocTaskManager({
      getDb: () => db,
      getRuntime: () => null,
      isChatStreaming: () => false,
      getContextTokens: () => 4096,
      getStoreDir: () => storeDir,
      getIngestionDeps: () => ({}),
      beginDocumentWork: () => () => {}
    })
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

  it('benchmark warnings stay canonical English under a German cache (persisted in lastBenchmark)', () => {
    applyUiLanguageSetting('de')
    const warnings = buildWarnings({
      profile: 'TINY',
      driveReadMbps: 5,
      driveWriteMbps: 5
    })
    expect(warnings).toContain(t('en', 'main.benchmark.warnTiny'))
    expect(warnings).toContain(t('en', 'main.benchmark.warnSlowDrive'))
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
    expect(getDocument(db, id2)?.scanDetected).toBe(true)

    applyUiLanguageSetting('en')
    expect(getDocument(db, id)?.scanDetected).toBe(true)
    expect(getDocument(db, id2)?.scanDetected).toBe(true)
  })
})
