import { describe, it, expect, vi, beforeEach } from 'vitest'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Unit tests for the shared save-export writers (ipc/save-export.ts) — above all the #90
// `saveBinaryExport` hoist: the MAIN-side binary save-dialog writer shared by the document
// original export (`docs:exportOriginal`) and the skills same-format DOCX export. The write
// must be ATOMIC (tmp sibling → fsync → rename, the evidence-pack tail) and byte-VERBATIM
// (no BOM, no encoding — `bomFor` is a plain-text concern).

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
vi.mock('electron', () => ({
  BrowserWindow: { getFocusedWindow: () => null },
  dialog: {
    showSaveDialog: async (options: Record<string, unknown>) => {
      dialogState.lastOptions = options
      return dialogState.result
    }
  }
}))

import { bomFor, saveBinaryExport, saveTextExport } from '../../src/main/ipc/save-export'

/** Bytes that are NOT valid UTF-8 — a text-decode round-trip would corrupt them. */
const BINARY_BYTES = Buffer.concat([
  Buffer.from('PK docx-ish header ', 'latin1'),
  Buffer.from([0x00, 0xff, 0xfe, 0x80, 0xc3, 0x28, 0x01])
])

beforeEach(() => {
  dialogState.result = { canceled: true, filePath: undefined }
  dialogState.lastOptions = null
})

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'hilbertraum-saveexport-'))
}

const OPTIONS = {
  title: 'Export original file',
  defaultPath: 'contract.docx',
  filters: [{ name: 'DOCX', extensions: ['docx'] }]
}

describe('saveBinaryExport (#90)', () => {
  it('writes the bytes VERBATIM to the chosen path — no BOM even for a .csv/.txt destination', async () => {
    const dir = freshDir()
    // A plain-text extension deliberately: `bomFor` would prefix '﻿' on the TEXT path;
    // the binary path must never consult it.
    const dest = join(dir, 'export.csv')
    dialogState.result = { canceled: false, filePath: dest }

    const saved = await saveBinaryExport(OPTIONS, BINARY_BYTES)
    expect(saved).toBe(dest)
    expect(readFileSync(dest).equals(BINARY_BYTES)).toBe(true)
  })

  it('is atomic: success leaves no tmp sibling next to the destination', async () => {
    const dir = freshDir()
    const dest = join(dir, 'contract.docx')
    dialogState.result = { canceled: false, filePath: dest }

    await saveBinaryExport(OPTIONS, BINARY_BYTES)
    expect(readdirSync(dir)).toEqual(['contract.docx'])
  })

  it('cancel returns null and writes nothing at all', async () => {
    const dir = freshDir()
    dialogState.result = { canceled: true, filePath: undefined }

    const saved = await saveBinaryExport(OPTIONS, BINARY_BYTES)
    expect(saved).toBeNull()
    expect(readdirSync(dir)).toEqual([])
  })

  it('a failed write rejects, leaves NO destination file and NO tmp residue', async () => {
    const dir = freshDir()
    // A destination inside a directory that does not exist: the tmp-sibling open fails,
    // and the atomic contract says nothing may exist afterwards.
    const dest = join(dir, 'no-such-subdir', 'contract.docx')
    dialogState.result = { canceled: false, filePath: dest }

    await expect(saveBinaryExport(OPTIONS, BINARY_BYTES)).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })

  it('passes the dialog options through (incl. the optional encryption-boundary `message`)', async () => {
    const dir = freshDir()
    const dest = join(dir, 'contract.docx')
    dialogState.result = { canceled: false, filePath: dest }

    await saveBinaryExport({ ...OPTIONS, message: 'boundary warning' }, BINARY_BYTES)
    expect(dialogState.lastOptions).toMatchObject({
      title: 'Export original file',
      defaultPath: 'contract.docx',
      message: 'boundary warning'
    })
  })
})

describe('saveTextExport (unchanged semantics pin)', () => {
  it('still prefixes the BOM on .md and writes utf8', async () => {
    const dir = freshDir()
    const dest = join(dir, 'export.md')
    dialogState.result = { canceled: false, filePath: dest }

    const saved = await saveTextExport(OPTIONS, 'hallo ausschließlich')
    expect(saved).toBe(dest)
    expect(readFileSync(dest, 'utf8')).toBe(`${bomFor(dest)}hallo ausschließlich`)
    expect(bomFor(dest)).toBe('﻿')
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
    expect(readFileSync(dest, 'utf8')).toBe(`﻿${content}`)
    // Atomic like the binary path: no tmp sibling survives a success.
    expect(readdirSync(dir)).toEqual(['big.md'])
  })

  it('a failed write rejects and leaves NO destination file and NO tmp residue', async () => {
    const dir = freshDir()
    const dest = join(dir, 'no-such-subdir', 'export.txt')
    dialogState.result = { canceled: false, filePath: dest }

    await expect(saveTextExport(OPTIONS, 'x')).rejects.toThrow()
    expect(existsSync(dest)).toBe(false)
    expect(readdirSync(dir)).toEqual([])
  })
})
