import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { planModelDownloads } from '../../src/main/services/assets'
import type { ModelManifest } from '../../src/shared/manifest'
import { committedManifests } from '../helpers/catalog'
import { testBudgetMs } from '../helpers/hang-budget'
import { sha256, writeDriveFile } from '../helpers/manifest-fixtures'
import { REPO_ROOT } from '../helpers/repo-files'
import { SCRIPT_LEGS, downloadEnv, outputOf, scriptRoot, type ScriptLeg } from '../helpers/script-legs'

// fetch-models really downloading, from `file://` sources (#769): the size-guarded delete before a re-download (AUD-24),
// resume of a short partial, the delete after a mismatch, and the aria2 keep branch, on both twins and into a drive root
// with a space and a `[` in its name (#767). Every run passes `downloadEnv()`: every CI image ships aria2c, which the
// scripts prefer and which reads no `file://` URL. script-execution.test.ts holds the dry-run plan rows.

vi.setConfig({ testTimeout: testBudgetMs(90_000) })

const ID = 'd-model'
const PRIMARY = `models/chat/${ID}.gguf`
const SOURCE = 'AAAAAAAAAABBBBBBBBBB'

/** A `file://` source holding `content`, outside the drive root: curl reads a `[` in a URL as a glob. */
function source(content: string): string {
  const file = join(mkdtempSync(join(tmpdir(), 'hilbertraum-fm-src-')), 'w.gguf')
  writeFileSync(file, content)
  return pathToFileURL(file).href
}

/** The one model of a drive, keys in the order the scripts' flat parsers read; `after` follows the top-level download. */
function manifest(o: { sha: string; url: string; size?: number; after?: string[] }): string {
  return [
    `id: ${ID}`,
    `display_name: ${ID}`,
    'family: t',
    'role: chat',
    'format: gguf',
    'runtime: llama_cpp',
    'license: test',
    'size_on_disk_gb: 0.000001',
    'recommended_min_ram_gb: 1',
    'recommended_ram_gb: 1',
    'recommended_context_tokens: 2048',
    `local_path: ${PRIMARY}`,
    `sha256: ${o.sha}`,
    'license_review:',
    '  status: approved',
    '  reviewed_by: test',
    "  reviewed_at: '2026-11-03'",
    '  notes: test fixture',
    'download:',
    `  url: ${o.url}`,
    `  sha256: ${o.sha}`,
    ...(o.size === undefined ? [] : [`  size_bytes: ${o.size}`]),
    ...(o.after ?? []),
    ''
  ].join('\n')
}

function drive(yaml: string, onDisk: Record<string, string>): string {
  const root = scriptRoot('fetch-models-')
  writeDriveFile(root, 'model-manifests/d.yaml', yaml)
  for (const [rel, content] of Object.entries(onDisk)) writeDriveFile(root, rel, content)
  return root
}

const bytesAt = (root: string, rel: string): string | null => {
  const file = join(root, ...rel.split('/'))
  return existsSync(file) ? readFileSync(file, 'utf8') : null
}

/**
 * A stand-in aria2c first on PATH. It logs what sat at the destination when it was called, then completes the download
 * the way aria2 does: it writes the bytes and removes its own `.aria2` control file.
 */
function aria2Stub(): { dir: string; calls: () => Array<{ seen: number; control: boolean }> } {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-aria2-stub-'))
  const log = join(dir, 'calls.log')
  writeFileSync(
    join(dir, 'aria2c-stub.cjs'),
    [
      "const fs = require('node:fs'), path = require('node:path'), { fileURLToPath } = require('node:url')",
      'const a = process.argv.slice(2)',
      "const dest = path.join(a[a.indexOf('--dir') + 1], a[a.indexOf('--out') + 1])",
      "const seen = fs.existsSync(dest) ? fs.statSync(dest).size : -1, control = fs.existsSync(dest + '.aria2')",
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ seen, control }) + '\\n')`,
      'fs.writeFileSync(dest, fs.readFileSync(fileURLToPath(a[a.length - 1])))',
      "fs.rmSync(dest + '.aria2', { force: true })",
      ''
    ].join('\n')
  )
  writeFileSync(join(dir, 'aria2c.cmd'), '@"%STUB_NODE%" "%~dp0aria2c-stub.cjs" %*\r\n@exit /b %ERRORLEVEL%\r\n')
  writeFileSync(join(dir, 'aria2c'), '#!/bin/sh\nexec "$STUB_NODE" "$(dirname "$0")/aria2c-stub.cjs" "$@"\n', { mode: 0o755 })
  const calls = (): Array<{ seen: number; control: boolean }> =>
    existsSync(log)
      ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { seen: number; control: boolean })
      : []
  return { dir, calls }
}

/** Whether this leg's shell finds an aria2c on the PATH of `env`, by the lookup the script itself makes. */
function resolvesAria2(leg: ScriptLeg, env: NodeJS.ProcessEnv): boolean {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^path$/i.test(k)))
  const opts = { encoding: 'utf8' as const, env: { ...base, ...env }, windowsHide: true }
  const r =
    leg.ext === 'ps1'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'if (Get-Command aria2c -ErrorAction SilentlyContinue) { exit 0 }; exit 1'], opts)
      : spawnSync('bash', ['-c', 'command -v aria2c'], opts)
  return r.status === 0
}

for (const leg of SCRIPT_LEGS) {
  describe.skipIf(leg.skip)(`fetch-models downloads — ${leg.name}`, () => {
    const f = leg.flag
    const fetchModels = (root: string, env = downloadEnv(), extra: string[] = []) =>
      leg.run(`fetch-models.${leg.ext}`, [f('Target'), root, ...extra], { env })

    // A guard for every row below: a leaked aria2c fails each with a protocol error, far from the cause.
    it('under downloadEnv() no aria2c resolves, and one put first on PATH does', () => {
      expect(resolvesAria2(leg, downloadEnv())).toBe(false)
      expect(resolvesAria2(leg, downloadEnv(aria2Stub().dir))).toBe(true)
    })

    interface DownloadRow {
      /** The primary's bytes before the run, if any. */
      before?: string
      /** An `.aria2` control file beside the primary before the run. */
      control?: boolean
      /** The manifest's hash; the source's by default. */
      sha?: string
      status: number
      /** The primary's bytes after the run, or null for no file. */
      after: string | null
      lines: string[]
      absent?: string[]
    }
    // A redo resumes onto what is there, and an at-EOF resume of a complete wrong file is an unsatisfiable range (AUD-24):
    // so it deletes first, but only when the bytes on disk reach size_bytes and no aria2 transfer will resume them.
    const rows: Array<[string, DownloadRow]> = [
      [
        'a full-length wrong file is deleted before the re-download, which then verifies',
        {
          before: 'Y'.repeat(SOURCE.length),
          status: 0,
          after: SOURCE,
          lines: ['deleting before re-download', `ok     ${ID} (VERIFIED)`]
        }
      ],
      [
        'a full-length file beside an .aria2 control file is deleted too when curl downloads',
        {
          before: 'Y'.repeat(SOURCE.length),
          control: true,
          status: 0,
          after: SOURCE,
          lines: ['deleting before re-download', `ok     ${ID} (VERIFIED)`],
          absent: ['keeping']
        }
      ],
      [
        'a short partial survives and is resumed',
        {
          before: 'XXXXX',
          sha: sha256(`XXXXX${SOURCE.slice(5)}`),
          status: 0,
          after: `XXXXX${SOURCE.slice(5)}`,
          lines: [`ok     ${ID} (VERIFIED)`],
          absent: ['deleting']
        }
      ],
      [
        'a mismatch after the download deletes the file and its .aria2 (exit 1)',
        {
          control: true,
          sha: sha256('other bytes'),
          status: 1,
          after: null,
          lines: ['checksum mismatch']
        }
      ]
    ]

    it.each(rows)('%s', (_title, row) => {
      const before: Record<string, string> = row.before === undefined ? {} : { [PRIMARY]: row.before }
      const root = drive(manifest({ sha: row.sha ?? sha256(SOURCE), url: source(SOURCE), size: SOURCE.length }), before)
      if (row.control) writeDriveFile(root, `${PRIMARY}.aria2`, 'control')
      const r = fetchModels(root)
      const out = outputOf(r)
      expect(r.status, out).toBe(row.status)
      expect(bytesAt(root, PRIMARY), out).toBe(row.after)
      expect(existsSync(join(root, ...`${PRIMARY}.aria2`.split('/'))), out).toBe(false)
      for (const line of row.lines) expect(out).toContain(line)
      for (const line of row.absent ?? []) expect(out).not.toContain(line)
    })

    it('with aria2c the downloader, a full-length file beside its .aria2 is kept for aria2 to resume', () => {
      const stub = aria2Stub()
      const root = drive(manifest({ sha: sha256(SOURCE), url: source(SOURCE), size: SOURCE.length }), {
        [PRIMARY]: 'Y'.repeat(SOURCE.length),
        [`${PRIMARY}.aria2`]: 'control'
      })
      const r = fetchModels(root, downloadEnv(stub.dir))
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).toContain('keeping the resumable aria2 partial')
      expect(stub.calls(), out).toEqual([{ seen: SOURCE.length, control: true }])
      expect(bytesAt(root, PRIMARY)).toBe(SOURCE)
      expect(out).toContain(`ok     ${ID} (VERIFIED)`)
    })

    // The same delete for the other two file slots, each with the size from its own download block.
    it('a full-length wrong projector and files: member are each deleted before their re-download', () => {
      const projector = 'P'.repeat(10)
      const member = 'M'.repeat(12)
      const MMPROJ = `models/chat/${ID}-mm.gguf`
      const MEMBER = `models/chat/${ID}-2.gguf`
      const root = drive(
        manifest({
          sha: sha256(SOURCE),
          url: source(SOURCE),
          size: SOURCE.length,
          after: [
            'mmproj:',
            `  local_path: ${MMPROJ}`,
            `  sha256: ${sha256(projector)}`,
            '  download:',
            `    url: ${source(projector)}`,
            `    sha256: ${sha256(projector)}`,
            `    size_bytes: ${projector.length}`,
            'files:',
            `  - local_path: ${MEMBER}`,
            `    sha256: ${sha256(member)}`,
            '    download:',
            `      url: ${source(member)}`,
            `      sha256: ${sha256(member)}`,
            `      size_bytes: ${member.length}`
          ]
        }),
        { [PRIMARY]: SOURCE, [MMPROJ]: 'Y'.repeat(projector.length), [MEMBER]: 'Y'.repeat(member.length) }
      )
      const r = fetchModels(root)
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out.match(/deleting before re-download/g), out).toHaveLength(2)
      expect(bytesAt(root, MMPROJ)).toBe(projector)
      expect(bytesAt(root, MEMBER)).toBe(member)
    })

    // Read flat, the projector's size_bytes answered for a primary whose own download block had none, and a resumable
    // primary partial at least that long was deleted and fetched whole, which then failed its hash (#767).
    it("a projector's size_bytes never reaches the primary: a primary partial longer than it is resumed (#767)", () => {
      const partial = 'X'.repeat(12)
      const projector = 'projector'
      const root = drive(
        manifest({
          sha: sha256(partial + SOURCE.slice(partial.length)),
          url: source(SOURCE),
          after: [
            'mmproj:',
            `  local_path: models/chat/${ID}-mm.gguf`,
            `  sha256: ${sha256(projector)}`,
            '  download:',
            `    url: ${source(projector)}`,
            `    sha256: ${sha256(projector)}`,
            `    size_bytes: ${projector.length}`
          ]
        }),
        { [PRIMARY]: partial }
      )
      expect(partial.length).toBeGreaterThan(projector.length)
      const r = fetchModels(root)
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(out).not.toContain('deleting')
      expect(bytesAt(root, PRIMARY)).toBe(partial + SOURCE.slice(partial.length))
      expect(bytesAt(root, `models/chat/${ID}-mm.gguf`)).toBe(projector)
    })

    // The last-resort downloader when neither aria2c nor curl is on PATH. Invoke-WebRequest -OutFile has no literal form
    // in PowerShell 5.1 and failed on the `[` of the drive root (#767). The .sh twin falls back to wget instead.
    it.runIf(leg.ext === 'ps1')('with neither aria2c nor curl on PATH, the .NET fallback downloads into the bracketed root', () => {
      const { PATH = '', ...rest } = downloadEnv()
      const noCurl = PATH.split(delimiter).filter((dir) => !existsSync(join(dir, 'curl.exe')))
      const root = drive(manifest({ sha: sha256(SOURCE), url: source(SOURCE), size: SOURCE.length }), {})
      const r = fetchModels(root, { ...rest, PATH: noCurl.join(delimiter) })
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      expect(bytesAt(root, PRIMARY)).toBe(SOURCE)
      expect(out).toContain(`ok     ${ID} (VERIFIED)`)
    })

    // #769: the real flat parsers over the committed yaml, held to the app's own planner. The Git Bash leg on a Windows
    // desk takes ~40 s over 34 manifests, so it runs on the ubuntu and macOS legs of CI.
    it.skipIf(process.platform === 'win32' && leg.ext === 'sh')(
      'a dry run over the committed manifests plans what planModelDownloads plans, line for line (#769)',
      async () => {
        const root = scriptRoot('fetch-models-catalog-')
        cpSync(join(REPO_ROOT, 'model-manifests'), join(root, 'model-manifests'), { recursive: true })
        const r = fetchModels(root, {}, [f('DryRun'), f('AcceptLicense')])
        const out = outputOf(r)
        expect(r.status, out).toBe(0)

        const lines = out.split(/\r?\n/)
        const planned: string[] = []
        lines.forEach((line, i) => {
          const fetch = /^\s+fetch\s+(.+?)\s*$/.exec(line)
          if (fetch) planned.push(`fetch ${fetch[1]} ${lines[i + 1].trim()} ${lines[i + 2].trim()}`)
          const skip = /^\s+SKIP\s+(\S+):/.exec(line)
          if (skip) planned.push(`SKIP ${skip[1]}`)
        })

        const manifests = committedManifests()
        const tasks = await planModelDownloads(root, manifests, { acceptLicense: true })
        const byId = new Map<string, ModelManifest>(manifests.map((m) => [m.id, m]))
        const label = (m: ModelManifest, rel: string): string =>
          rel === m.localPath
            ? ''
            : rel === m.mmproj?.localPath
              ? ' (mmproj)'
              : ` (file ${(m.files ?? []).findIndex((x) => x.localPath === rel) + 2}/${1 + (m.files ?? []).length})`
        // The scripts skip a whole model when any file of it is withdrawn; the app plans each file on its own.
        const withdrawn = new Set(tasks.filter((t) => t.status === 'source-withdrawn').map((t) => t.id))
        const expected = [
          ...[...withdrawn].map((id) => `SKIP ${id}`),
          ...tasks
            .filter((t) => !withdrawn.has(t.id))
            .map((t) => `fetch ${t.id}${label(byId.get(t.id)!, t.relPath)} ${t.url} -> ${t.relPath}`)
        ]
        expect(tasks.every((t) => t.status === 'download' || t.status === 'source-withdrawn')).toBe(true)
        expect(withdrawn.size, 'the issue-196 manifests').toBeGreaterThan(0)
        expect(planned.sort()).toEqual(expected.sort())
      }
    )
  })
}
