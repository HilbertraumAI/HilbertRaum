import { describe, it, expect } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
  auditStoredCopies,
  classifyFile,
  extClassOf,
  formatStoredCopyAuditReport,
  type AuditDirEntry,
  type AuditInput,
  type AuditRow
} from '../helpers/stored-copy-audit'
import { fingerprintTree, treeUnchanged } from '../helpers/read-only-witness'

// Issue #190 — CI proof for the PURE half of the stored-copy diagnostic.
//
// The tool's whole purpose is to produce numbers a cleanup decision (issue #190 checkbox 2) will
// rest on, so the numbers have to be exact and the class boundaries have to be the RIGHT ones.
// The wave-188 discipline applies: each guard below is written so that breaking it turns a test
// red, and the mutation runs are recorded in the design record.
//
// The direction of danger is asymmetric and the tests encode that: an UNDER-count of orphans is
// merely uninformative; an OVER-count invents an orphan out of a live file (a staged rekey, an
// in-flight import) and would hand a future sweep a file whose deletion loses user data.

const CLEAN_AT_REST = { recovery: false, wal: false, shm: false, dbRekeyStaged: false }

function row(over: Partial<AuditRow> & { id: string }): AuditRow {
  return {
    status: 'indexed',
    stored_path: null,
    stored_name: null,
    original_path: null,
    mime_type: null,
    ...over
  }
}

function input(over: Partial<AuditInput>): AuditInput {
  return {
    rows: [],
    dirEntries: [],
    existingRecordedPaths: [],
    storedNameColumn: true,
    descriptorVersion: 2,
    atRest: CLEAN_AT_REST,
    ...over
  }
}

describe('#190 stored-copy audit — file classification', () => {
  const id = randomUUID()

  it('separates a stored copy from every transient class a writer can leave in documents/', () => {
    // The complete writer inventory for `workspace/documents/` (see the module header).
    expect(classifyFile(`${id}.pdf.enc`)).toBe('stored-copy')
    expect(classifyFile(`${id}.pdf`)).toBe('stored-copy') // plaintext_dev workspace
    expect(classifyFile(`${id}.parse.pdf`)).toBe('parse-transient') // re-index
    expect(classifyFile(`${id}.parse-preview-${randomUUID()}.pdf`)).toBe('parse-transient')
    expect(classifyFile(`${id}.parse-export-${randomUUID()}.pdf`)).toBe('parse-transient')
    expect(classifyFile(`${id}.parse-export-bin-${randomUUID()}.pdf`)).toBe('parse-transient')
    expect(classifyFile(`${randomUUID()}.parse-dictation.wav`)).toBe('parse-transient')
    expect(classifyFile(`${randomUUID()}.parse-transcript.txt`)).toBe('parse-transient')
    expect(classifyFile(`${id}.parse.md`)).toBe('parse-transient') // doc-task markdown
    expect(classifyFile(`${id}.parse-ocr.pdf`)).toBe('parse-transient')
    expect(classifyFile(`${id}.pdf.enc.new`)).toBe('rekey-staged') // stageRekey
    expect(classifyFile(`${id}.pdf.enc.tmp`)).toBe('write-temp') // encryptFile
    expect(classifyFile(`${id}.pdf.enc.new.tmp`)).toBe('write-temp')
    expect(classifyFile(`${id}.pdf.enc.rekey.tmp`)).toBe('write-temp')
    expect(classifyFile('notes.txt')).toBe('unknown') // no id prefix: somebody's stray file
  })

  it('MUTATION GUARD — a staged rekey file is never a stored copy, and never an orphan', () => {
    // `<id><ext>.enc.new` is a LIVE document being re-encrypted during a password change. A
    // classifier matching `.enc` loosely (`includes` instead of `endsWith`, or checking `.enc`
    // before `.enc.new`) parks it in the orphan bucket — and a cleanup built on that count would
    // delete the only copy of that document mid-rekey. This is the single most dangerous
    // misclassification the tool can make.
    const staged = `${id}.pdf.enc.new`
    expect(classifyFile(staged)).toBe('rekey-staged')
    const r = auditStoredCopies(input({ dirEntries: [{ name: staged, bytes: 4096 }] }))
    expect(r.orphans.count).toBe(0)
    expect(r.fileClasses['rekey-staged']).toEqual({ count: 1, bytes: 4096 })
    expect(r.fileClasses['stored-copy'].count).toBe(0)
  })

  it('MUTATION GUARD — an in-flight import transient is never an orphan', () => {
    // The other half of the D4 race: a concurrent import has its transient (and, briefly, its
    // file) on disk before the row is written.
    const t = `${id}.parse-preview-${randomUUID()}.pdf`
    const r = auditStoredCopies(input({ dirEntries: [{ name: t, bytes: 10 }] }))
    expect(r.orphans.count).toBe(0)
    expect(r.fileClasses['parse-transient'].count).toBe(1)
  })
})

describe('#190 stored-copy audit — ownership', () => {
  it('a file claimed by ANY of the three row sources is not an orphan', () => {
    // Over-claiming under-counts orphans (harmless); under-claiming invents one (dangerous).
    const a = randomUUID()
    const b = randomUUID()
    const c = randomUUID()
    const rows = [
      // healed row: `stored_name` alone names the file
      row({ id: a, stored_name: `${a}.pdf.enc`, stored_path: null }),
      // legacy row on a relocated drive: only the stale absolute path names it
      row({ id: b, stored_path: `H:\\old\\workspace\\documents\\${b}.docx.enc` }),
      // a row whose file sits outside the store dir entirely (nothing to heal it to)
      row({ id: c, stored_path: `/elsewhere/${c}.txt.enc` })
    ]
    const dirEntries: AuditDirEntry[] = [
      { name: `${a}.pdf.enc`, bytes: 1 },
      { name: `${b}.docx.enc`, bytes: 2 },
      { name: `${c}.txt.enc`, bytes: 3 }
    ]
    const r = auditStoredCopies(input({ rows, dirEntries }))
    expect(r.orphans.count).toBe(0)
    expect(r.fileClasses['stored-copy'].count).toBe(3)
  })

  it('MUTATION GUARD — a live row with an UNNAMEABLE leaf still owns its file', () => {
    // Found by the first end-to-end operator smoke. A row whose recorded strings are corrupt names
    // nothing the first three sources can match — `canonicalLeafFor` refuses the leaf — so its
    // perfectly healthy copy looked like an orphan. The store's naming is `<documentId><ext>[.enc]`
    // and the id is a never-reused UUID primary key, so a file whose LEADING id is a live row's id
    // belongs to that row whatever the row recorded. Dropping the id fallback re-creates a phantom
    // orphan out of live user data — the exact failure the orphan count must never have.
    const id = randomUUID()
    const rows = [row({ id, stored_path: 'H:garbage-no-separators.enc', stored_name: '../evil.enc' })]
    const r = auditStoredCopies(
      input({ rows, dirEntries: [{ name: `${id}.docx.enc`, bytes: 99 }] })
    )
    expect(r.orphans.count).toBe(0)
    expect(r.rows.staleUnnameable).toBe(1)
    // ...and the report says so, so nobody reads the orphan line as more certain than it is.
    expect(formatStoredCopyAuditReport(r)).toContain('the safety guard refuses')
  })

  it('counts a genuine orphan with its bytes and a shape token', () => {
    const orphan = randomUUID()
    const r = auditStoredCopies(
      input({ dirEntries: [{ name: `${orphan}.pdf.enc`, bytes: 5_000_000 }] })
    )
    expect(r.orphans.count).toBe(1)
    expect(r.orphans.bytes).toBe(5_000_000)
    expect(r.orphans.tokens).toEqual([`${orphan.slice(0, 8)} pdf <8M`])
  })
})

describe('#190 stored-copy audit — the row ladder', () => {
  const a = randomUUID() // healthy, resolves as recorded
  const b = randomUUID() // stale but healable at the canonical location
  const c = randomUUID() // stale and gone everywhere
  const d = randomUUID() // never stored a copy (queued)
  const e = randomUUID() // healthy audio
  const f = randomUUID() // stale, and the safety guard refuses its leaf

  const rows: AuditRow[] = [
    row({ id: a, stored_path: `/new/workspace/documents/${a}.pdf.enc`, stored_name: `${a}.pdf.enc` }),
    row({ id: b, stored_path: `H:\\old\\workspace\\documents\\${b}.docx.enc` }),
    row({ id: c, stored_path: `H:\\old\\workspace\\documents\\${c}.txt.enc` }),
    row({ id: d, stored_path: null, status: 'queued', mime_type: 'application/pdf' }),
    row({ id: e, stored_path: `/new/workspace/documents/${e}.wav.enc`, stored_name: `${e}.wav.enc` }),
    // A corrupted/foreign `stored_name`: `canonicalLeafFor` refuses it (traversal + wrong owner),
    // so the resolver would fall back to the recorded absolute path verbatim — which is gone.
    row({ id: f, stored_path: `H:\\old\\elsewhere\\weird.enc`, stored_name: '../evil.enc' })
  ]
  const dirEntries: AuditDirEntry[] = [
    { name: `${a}.pdf.enc`, bytes: 1000 },
    { name: `${b}.docx.enc`, bytes: 2000 },
    { name: `${e}.wav.enc`, bytes: 3000 }
  ]
  const existingRecordedPaths = [
    `/new/workspace/documents/${a}.pdf.enc`,
    `/new/workspace/documents/${e}.wav.enc`
  ]
  const report = auditStoredCopies(input({ rows, dirEntries, existingRecordedPaths }))

  it('counts documents by status', () => {
    expect(report.documents.total).toBe(6)
    expect(report.documents.byStatus).toEqual({ indexed: 5, queued: 1 })
  })

  it('counts stale rows, and how many of them are healable — the staleness verdict', () => {
    // This pair is the whole point of the tool on the reporting drive: stale > 0 with
    // healable == stale means "the drive moved and every copy is still there".
    expect(report.rows.stale).toBe(3) // b, c, f
    expect(report.rows.healable).toBe(1) // b — the copy IS at the canonical location
    expect(report.rows.staleUnnameable).toBe(1) // f — the guard refuses the leaf
    expect(report.rows.missingEverywhere).toBe(2) // c and f
    expect(report.rows.neverStored).toBe(1) // d
    expect(report.rows.resolvedAsRecorded).toBe(2) // a and e
  })

  it('MUTATION GUARD — a row with no stored_path at all is never counted stale', () => {
    // A queued row has recorded nothing; folding it into `stale` would inflate the very number
    // the cleanup decision reads.
    const only = auditStoredCopies(input({ rows: [rows[3]] }))
    expect(only.rows.stale).toBe(0)
    expect(only.rows.missingEverywhere).toBe(0)
    expect(only.rows.neverStored).toBe(1)
  })

  it('builds the extension histogram over rows, with mime_type as the fallback source', () => {
    // REQUIRED by #190 checkbox 3: audio is the only document class whose PREVIEW does not touch
    // the file (it replays the stored chunks via `audioSegmentsFromChunks`), so exactly one audio
    // document explains "Vorschau works" alongside an export failure with no contradiction.
    expect(report.extensions).toEqual({ pdf: 2, docx: 1, txt: 1, wav: 1, other: 1 })
    expect(report.audioRows).toBe(1)
  })

  it('reports stored_name adoption', () => {
    expect(report.storedName).toEqual({ column: true, populated: 3 })
  })

  it('emits one shape token per row and per orphan', () => {
    expect(report.rowTokens).toHaveLength(6)
    for (const t of report.rowTokens) expect(t).toMatch(/^[0-9a-f]{8} [a-z]+ [-ENOPSHMX.]+$/)
  })
})

describe('#190 stored-copy audit — schema and vault findings', () => {
  it('distinguishes an ABSENT stored_name column from an unpopulated one', () => {
    // The reporting drive predates #189 and the column is added by `ensureColumn` at open, which
    // the diagnostic must never trigger — so "absent" is a real, expected state, not an error.
    const id = randomUUID()
    const absent = auditStoredCopies(
      input({ rows: [row({ id, stored_name: undefined, stored_path: `/x/${id}.pdf.enc` })], storedNameColumn: false })
    )
    expect(absent.storedName).toEqual({ column: false, populated: 0 })
    expect(formatStoredCopyAuditReport(absent)).toContain('ABSENT (pre-#189 schema)')
  })

  it('reports the descriptor version and the plaintext_dev case', () => {
    expect(auditStoredCopies(input({ descriptorVersion: 1 })).vault).toEqual({
      descriptorVersion: 1,
      mode: 'encrypted'
    })
    expect(auditStoredCopies(input({ descriptorVersion: null })).vault).toEqual({
      descriptorVersion: null,
      mode: 'plaintext_dev'
    })
  })

  it('surfaces each at-rest finding separately', () => {
    const r = auditStoredCopies(
      input({ atRest: { recovery: true, wal: true, shm: false, dbRekeyStaged: true } })
    )
    const text = formatStoredCopyAuditReport(r)
    expect(text).toContain('.recovery        PRESENT — a lock failed')
    expect(text).toContain('-wal             PRESENT — unclean last session')
    expect(text).toContain('-shm             no')
    expect(text).toContain('db .enc.new      PRESENT — interrupted password change')
  })
})

describe('#190 stored-copy audit — the report is safe to paste in public', () => {
  it('leaks no path, no file name and no unlisted extension into the rendered text', () => {
    const id = randomUUID()
    const orphan = randomUUID()
    const rows = [
      row({
        id,
        // Everything identifying the tool could possibly echo: a drive letter, a folder name, a
        // user name, and an off-allowlist extension.
        stored_path: `H:\\Users\\ImogenSchmidt\\Steuerbescheid-2019\\workspace\\documents\\${id}.p7s.enc`,
        original_path: 'H:\\Users\\ImogenSchmidt\\Steuerbescheid-2019\\Original.p7s',
        mime_type: 'application/pkcs7-signature'
      })
    ]
    const text = formatStoredCopyAuditReport(
      auditStoredCopies(
        input({ rows, dirEntries: [{ name: `${orphan}.p7s.enc`, bytes: 12 }] })
      )
    )
    for (const secret of [
      'ImogenSchmidt',
      'Steuerbescheid',
      'Original.p7s',
      'H:\\',
      'pkcs7',
      'p7s',
      id, // the full id — only the 8-char prefix may appear
      orphan
    ]) {
      expect(text, `report must not contain "${secret}"`).not.toContain(secret)
    }
    // The 8-char prefixes ARE present: they are what lets two lines of the report be correlated.
    expect(text).toContain(id.slice(0, 8))
    expect(text).toContain(orphan.slice(0, 8))
    // The off-allowlist extension collapsed to the closed-set label.
    expect(extClassOf(rows[0])).toBe('other')
  })
})

describe('#190 diagnostic — the read-only capabilities it depends on', () => {
  it('node:sqlite honours { readOnly: true } on the engines floor (>= 22.12)', () => {
    // The diagnostic opens the decrypted COPY read-only as its innermost guard. CI runs both ends
    // of the supported Node range, so this asserts the option is real on the 22.x leg rather than
    // trusting the docs — if a floor bump ever loses it, this goes red before the drive does.
    const dir = mkdtempSync(join(tmpdir(), 'hr-audit-ro-'))
    try {
      const path = join(dir, 'probe.sqlite')
      const w = new DatabaseSync(path)
      w.exec('CREATE TABLE t (a TEXT)')
      w.exec("INSERT INTO t VALUES ('x')")
      w.close()
      const r = new DatabaseSync(path, { readOnly: true })
      try {
        expect(r.prepare('SELECT a FROM t').all()).toEqual([{ a: 'x' }])
        expect(() => r.exec('CREATE TABLE z (b TEXT)')).toThrow(/readonly/i)
      } finally {
        r.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('the read-only witness notices a size change, an mtime change, and a new entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hr-audit-witness-'))
    try {
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'a.bin'), 'aaa')
      const before = fingerprintTree(dir)
      expect(treeUnchanged(before, fingerprintTree(dir))).toBe(true)

      writeFileSync(join(dir, 'sub', 'a.bin'), 'aaaa') // size change
      expect(treeUnchanged(before, fingerprintTree(dir))).toBe(false)

      writeFileSync(join(dir, 'sub', 'a.bin'), 'aaa') // back to the same size...
      const sameSize = fingerprintTree(dir)
      utimesSync(join(dir, 'sub', 'a.bin'), new Date(0), new Date(0)) // ...but a different mtime
      expect(treeUnchanged(sameSize, fingerprintTree(dir))).toBe(false)

      const withNew = fingerprintTree(dir)
      writeFileSync(join(dir, 'sub', 'b.bin'), 'b') // a new entry (a rolled-forward .recovery)
      expect(treeUnchanged(withNew, fingerprintTree(dir))).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
