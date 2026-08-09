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
