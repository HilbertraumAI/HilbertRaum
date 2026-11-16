import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Unit tests for the shared save-export writers (ipc/save-export.ts): `bomFor` (the plain-text BOM rule), the #90 binary
// writer `saveBinaryExport` (bytes VERBATIM, never a BOM), the text writer `saveTextExport` (BOM by the chosen path), and
// the async atomic tail both share since #256: tmp sibling → short-write check → fsync → rename, the tmp removed on any
// failure. `node:fs` is a recording pass-through (no synchronous write may reach the destination, #256);
// `node:fs/promises` is a pass-through whose next `open` can be armed to fail its fsync or to short-write once.

const dialogState = vi.hoisted(() => ({
  result: { canceled: true as boolean, filePath: undefined as string | undefined },
  lastOptions: null as Record<string, unknown> | null
}))
// Pass-through `node:fs` wrapper that only RECORDS the synchronous write-side calls — every
// call still hits the real filesystem (#256, the pattern of the evidence-pack async-fs test).
const syncCalls = vi.hoisted(() => ({ list: [] as Array<{ fn: string; path: string }> }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  const record = <A extends unknown[], R>(name: string, fn: (...args: A) => R) =>
    ((...args: A): R => {
      syncCalls.list.push({ fn: name, path: String(args[0]) })
      return fn(...args)
    }) as (...args: A) => R
  const mocked = {
    ...actual,
    openSync: record('openSync', actual.openSync),
    writeFileSync: record('writeFileSync', actual.writeFileSync),
    appendFileSync: record('appendFileSync', actual.appendFileSync),
    copyFileSync: record('copyFileSync', actual.copyFileSync),
    renameSync: record('renameSync', actual.renameSync)
  }
  return { ...mocked, default: mocked }
})
// Pass-through `node:fs/promises` (production imports `open`, `rename`, `rm` from it). Arming a flag makes the NEXT `open`
// return a handle whose fsync fails, or whose write stores one byte short; the flag is consumed, so a row can check that
// the tail really reached that step.
const fsFaults = vi.hoisted(() => ({ failSync: false, shortWrite: false }))
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args)
    if (fsFaults.failSync) {
      fsFaults.failSync = false
      handle.sync = async (): Promise<void> => {
        throw Object.assign(new Error('EIO: injected fsync failure'), { code: 'EIO' })
      }
    }
    if (fsFaults.shortWrite) {
      fsFaults.shortWrite = false
      const write = handle.write.bind(handle) as (
        b: Buffer,
        o: number,
        l: number,
        p: number | null
      ) => Promise<{ bytesWritten: number; buffer: Buffer }>
      handle.write = (async (b: Buffer, o: number, l: number, p: number | null) =>
        write(b, o, Math.max(0, l - 1), p)) as unknown as typeof handle.write
    }
    return handle
  }) as typeof actual.open
  const mocked = { ...actual, open }
  return { ...mocked, default: mocked }
})
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async (options: Record<string, unknown>) => {
      dialogState.lastOptions = options
      return dialogState.result
    }
  }
}))

import { bomFor, saveBinaryExport, saveTextExport, type SaveExportDialogOptions } from '../../src/main/ipc/save-export'
import { tempRoot } from '../helpers/db-fixtures'

/** Bytes that are NOT valid UTF-8 — a text-decode round-trip would corrupt them. */
const BINARY_BYTES = Buffer.concat([
  Buffer.from('PK docx-ish header ', 'latin1'),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x01])
])

beforeEach(() => {
  dialogState.result = { canceled: true, filePath: undefined }
  dialogState.lastOptions = null
  fsFaults.failSync = false
  fsFaults.shortWrite = false
})

function freshDir(): string {
  return tempRoot('saveexport')
}

const OPTIONS = {
  title: 'Export original file',
  defaultPath: 'contract.docx',
  filters: [{ name: 'DOCX', extensions: ['docx'] }]
}

/** Both writers share the atomic tail: a row about the tail runs once per writer. */
type Writer = (options: SaveExportDialogOptions, text: string) => Promise<string | null>
const WRITERS: Array<[string, Writer]> = [
  ['saveBinaryExport', (options, text) => saveBinaryExport(options, Buffer.from(text, 'utf8'))],
  ['saveTextExport', (options, text) => saveTextExport(options, text)]
]

// invoice-hardening-2026-07-04 P4 — the UTF-8 BOM on plain-text exports. A user's exported German
// transcript opened in a CP1252-defaulting Windows viewer rendered mojibake ("ausschlieÃlich"); the BOM
// makes legacy editors detect UTF-8. It must ride ONLY .md/.txt — a BOM breaks strict JSON parsers (the
// audit-log export) and is wrong for .log tooling.
// Audit 2026-07-16 F-10 (owner decision D-A, 2026-07-17) extended the BOM to .csv: Excel — the primary
// consumer of a transactions CSV — opens BOM-less UTF-8 in the ANSI code page on double-click, garbling
// every umlaut/ß in payee/description text. Still NEVER on .json/.log.
describe('bomFor (P4 + F-10 — text/CSV export BOM)', () => {
  it('prefixes .md, .txt and .csv (case-insensitive)', () => {
    expect(bomFor('C:/exports/chat.md')).toBe('\ufeff')
    expect(bomFor('C:/exports/chat.TXT')).toBe('\ufeff')
    expect(bomFor('C:/exports/items.csv')).toBe('\ufeff') // F-10 (D-A 2026-07-17): Excel-friendly CSV
  })

  it('never prefixes JSON / log exports', () => {
    expect(bomFor('C:/exports/audit.json')).toBe('')
    expect(bomFor('C:/exports/app.log')).toBe('')
  })
})

describe('saveBinaryExport (#90)', () => {
  it('writes the bytes VERBATIM to the chosen path — no BOM even for a .csv destination', async () => {
    const dir = freshDir()
    // A plain-text extension deliberately: `bomFor` would prefix U+FEFF on the TEXT path; the binary path must never
    // consult it.
    const dest = join(dir, 'export.csv')
    dialogState.result = { canceled: false, filePath: dest }

    const saved = await saveBinaryExport(OPTIONS, BINARY_BYTES)
    expect(saved).toBe(dest)
    expect(readFileSync(dest).equals(BINARY_BYTES)).toBe(true)
  })

  it('success leaves only the destination (no tmp sibling)', async () => {
    const dir = freshDir()
    const dest = join(dir, 'contract.docx')
    dialogState.result = { canceled: false, filePath: dest }

    await saveBinaryExport(OPTIONS, BINARY_BYTES)
    expect(readdirSync(dir)).toEqual(['contract.docx'])
  })
})

describe('the shared atomic tail, both writers (#90, #256)', () => {
  it.each(WRITERS)('%s: a cancel that still reports a path returns null and writes nothing', async (_name, write) => {
    const dir = freshDir()
    dialogState.result = { canceled: true, filePath: join(dir, 'out.txt') }
    expect(await write(OPTIONS, 'payload')).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it.each(WRITERS)(
    '%s: a failed fsync while replacing an existing file keeps the old file and leaves no tmp sibling',
    async (_name, write) => {
      const dir = freshDir()
      const dest = join(dir, 'out.txt')
      writeFileSync(dest, 'OLD CONTENT')
      dialogState.result = { canceled: false, filePath: dest }
      fsFaults.failSync = true
      await expect(write(OPTIONS, 'new content')).rejects.toThrow(/injected fsync failure/)
      expect(fsFaults.failSync).toBe(false) // consumed: the tail opened a handle and reached its fsync
      expect(readFileSync(dest, 'utf8')).toBe('OLD CONTENT')
      expect(readdirSync(dir)).toEqual(['out.txt'])
    }
  )

  it.each(WRITERS)(
    '%s: a failed fsync on a new destination rejects, leaves NO destination file and NO tmp residue',
    async (_name, write) => {
      const dir = freshDir()
      dialogState.result = { canceled: false, filePath: join(dir, 'out.txt') }
      fsFaults.failSync = true
      await expect(write(OPTIONS, 'payload')).rejects.toThrow(/injected fsync failure/)
      expect(fsFaults.failSync).toBe(false)
      expect(readdirSync(dir)).toEqual([])
    }
  )

  it('a short write refuses: rejects, leaves NO destination file and NO tmp residue', async () => {
    const dir = freshDir()
    dialogState.result = { canceled: false, filePath: join(dir, 'contract.docx') }
    fsFaults.shortWrite = true
    await expect(saveBinaryExport(OPTIONS, BINARY_BYTES)).rejects.toThrow(/short write/)
    expect(fsFaults.shortWrite).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})

// The text writer used `writeFileSync` on the Electron main thread: a multi-megabyte export
// to a slow USB drive stalled every window and every pending IPC reply for the whole write,
// the defect the print path had already fixed one file away. It now shares the binary
// writer's async atomic tail (#256).
describe('saveTextExport writes off the synchronous fs API (#256)', () => {
  it('no synchronous write reaches the destination directory during the export', async () => {
    const dir = freshDir()
    const dest = join(dir, 'big.md')
    dialogState.result = { canceled: false, filePath: dest }
    const content = 'ausschließlich '.repeat(200_000) // ~3 MB

    syncCalls.list.length = 0
    const saved = await saveTextExport(OPTIONS, content)
    const touched = syncCalls.list.filter((c) => c.path.startsWith(dir))
    expect(touched).toEqual([])
    expect(saved).toBe(dest)
    expect(readFileSync(dest, 'utf8')).toBe(`\ufeff${content}`)
    // Atomic like the binary path: no tmp sibling survives a success.
    expect(readdirSync(dir)).toEqual(['big.md'])
    // Positive control: the recording pass-through does see a synchronous write into this directory.
    writeFileSync(join(dir, 'probe.txt'), '')
    expect(syncCalls.list.filter((c) => c.path.startsWith(dir)).map((c) => c.fn)).toEqual(['writeFileSync'])
  })
})
