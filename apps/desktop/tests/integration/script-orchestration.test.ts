import { describe, it, expect, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
import { buildPolicyJson } from '../../src/main/services/drive'
import { REPO_ROOT, modelManifestDocs, repoText } from '../helpers/repo-files'
import { SCRIPT_LEGS, extractScriptArray, outputOf, scriptRoot } from '../helpers/script-legs'
import { writeDriveFile } from '../helpers/manifest-fixtures'
import { testBudgetMs } from '../helpers/hang-budget'

// What prepare-drive and build-commercial-drive hand their child scripts, in which order, and where they stop (#769).
// Every pipeline is a dry run on a `scriptRoot()` (a space and a `[` in its name, #767) seeded with committed manifests and
// the committed runtime pin, so the children read no repo file and nothing is downloaded. A pipeline still costs a second
// or two on PowerShell and Linux and ~25 s on Git Bash, hence a file of its own: vitest shards by file.

const HEAVY_MS = testBudgetMs(240_000)
vi.setConfig({ testTimeout: testBudgetMs(300_000) })

const APP_VERSION = (JSON.parse(repoText('apps', 'desktop', 'package.json')) as { version: string }).version
const MANIFEST_DOCS = modelManifestDocs()
const DEFAULT_IDS = extractScriptArray(repoText('scripts', 'prepare-drive.ps1'), '$DefaultModelIds = @(')
const approved = (doc: Record<string, unknown>): boolean =>
  (doc.license_review as { status?: string } | undefined)?.status === 'approved'
/** A committed model outside the default set: --with-assets must leave it alone. */
const OTHER_ID = String(MANIFEST_DOCS.find((d) => !DEFAULT_IDS.includes(String(d.doc.id)) && d.doc.download)!.doc.id)
/** One model of the Kit's bundled set (#766), so the builder's step 2 plans a fetch and passes. */
const BUNDLED_ID = String(MANIFEST_DOCS.find((d) => d.doc.bundled_on_preconfigured_drive === true && approved(d.doc))!.doc.id)

/** Copies committed manifests, each in its own folder, and the runtime pin onto `root`. */
function seed(root: string, ids: string[], edit: (id: string, text: string) => string = (_id, text) => text): void {
  for (const id of ids) {
    const doc = MANIFEST_DOCS.find((d) => d.doc.id === id)
    if (!doc) throw new Error(`no committed manifest for ${id}`)
    const rel = relative(join(REPO_ROOT, 'model-manifests'), doc.path).split(sep).join('/')
    writeDriveFile(root, `model-manifests/${rel}`, edit(id, doc.text))
  }
  writeDriveFile(root, 'model-manifests/runtime-sources.yaml', repoText('model-manifests', 'runtime-sources.yaml'))
}

/** Reopens the first default model's license review. */
function pendingFirst(id: string, text: string): string {
  if (id !== DEFAULT_IDS[0]) return text
  const pending = text.replace(/^(\s+status:\s*)approved\b/m, '$1pending')
  if (pending === text) throw new Error(`${id}: no approved review to reopen`)
  return pending
}

for (const leg of SCRIPT_LEGS) {
  describe.skipIf(leg.skip)(`prepare-drive — ${leg.name}`, () => {
    const preparer = `prepare-drive.${leg.ext}`
    const f = leg.flag

    it('a dry run on a fresh path creates nothing', () => {
      const parent = scriptRoot('orch-dry-')
      const r = leg.run(preparer, [f('Target'), join(parent, 'drive'), f('DryRun')])
      expect(r.status, outputOf(r)).toBe(0)
      expect(outputOf(r)).toContain('dry run')
      expect(readdirSync(parent)).toEqual([])
    })

    it('the dev flag writes the developer policy, buildPolicyJson({ dev: true })', () => {
      const root = scriptRoot('orch-dev-')
      const r = leg.run(preparer, [f('Target'), root, f('Dev')])
      expect(r.status, outputOf(r)).toBe(0)
      expect(JSON.parse(readFileSync(join(root, 'config', 'policy.json'), 'utf8'))).toEqual(buildPolicyJson({ dev: true }))
    })

    // M22: the .ps1 writes its config through .NET, which resolves a relative path against the PROCESS directory, and that
    // does not follow Set-Location. So the defect shows only from a shell whose location moved; the files tell, not the exit.
    // The command first sets 5.1's own module path, as SCRIPT_LEGS does for a -File run (a CI runner exports PowerShell 7's).
    it('a relative target lands under the shell location, config included (M22)', () => {
      const location = scriptRoot('orch-rel-')
      const elsewhere = mkdtempSync(join(tmpdir(), 'hilbertraum-orch-cwd-'))
      const modules = [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
      ].join(';')
      const r =
        leg.ext === 'ps1'
          ? spawnSync(
              'powershell.exe',
              [
                '-NoProfile',
                '-NonInteractive',
                '-ExecutionPolicy',
                'Bypass',
                '-Command',
                `$env:PSModulePath = '${modules}'; Set-Location -LiteralPath '${location}'; ` +
                  `& '${join(REPO_ROOT, 'scripts', preparer)}' -Target rel-drive`
              ],
              { encoding: 'utf8', cwd: elsewhere, windowsHide: true, timeout: testBudgetMs(60_000) }
            )
          : leg.run(preparer, [f('Target'), 'rel-drive'], { cwd: location })
      for (const rel of ['workspace', 'model-manifests/runtime-sources.yaml', 'config/drive.json', 'config/policy.json']) {
        expect(existsSync(join(location, 'rel-drive', ...rel.split('/'))), `${rel}\n${outputOf(r)}`).toBe(true)
      }
      expect(readdirSync(elsewhere)).toEqual([])
    })

    // F-05: the OCR files were once fetched by the builder only. The other model must stay out: one call per default id.
    it('--with-assets --dry-run fetches each default model by id, then llama.cpp, whisper.cpp and the OCR files (F-05)', () => {
      const root = scriptRoot('orch-assets-')
      seed(root, [...DEFAULT_IDS, OTHER_ID], pendingFirst)
      const r = leg.run(preparer, [f('Target'), root, f('WithAssets'), f('DryRun'), f('AcceptLicense')], { timeoutMs: HEAVY_MS })
      const out = outputOf(r)
      expect(r.status, out).toBe(0)
      // The license flag reached fetch-models: the reopened review is accepted, not blocked.
      expect(out).toContain(`note   ${DEFAULT_IDS[0]}:`)
      expect(out).not.toContain(`fetch  ${OTHER_ID}`)
      // stdout alone keeps the order: the .sh twins print their notes on stderr.
      const lines = r.stdout.replace(/\\/g, '/').split(/\r?\n/)
      const lineOf = (what: string, test: (line: string) => boolean): number => {
        const i = lines.findIndex(test)
        expect(i, `${what}\n${out}`).toBeGreaterThanOrEqual(0)
        return i
      }
      const order = [
        ...DEFAULT_IDS.map((id) => lineOf(`fetch ${id}`, (l) => l.trim().startsWith(`fetch  ${id}`))),
        lineOf('the llama.cpp build', (l) => /into:.*\/runtime\/llama\.cpp\//.test(l)),
        // Upstream builds whisper.cpp for Windows only: another host gets the note.
        lineOf('the whisper.cpp step', (l) => /into:.*\/runtime\/whisper\.cpp\//.test(l) || l.includes('whisper.cpp runtime not provisioned')),
        lineOf('the OCR files', (l) => l.includes('Fetch OCR language files'))
      ]
      expect(order).toEqual([...order].sort((a, b) => a - b))
      for (const dir of ['models', 'runtime', 'ocr']) expect(existsSync(join(root, dir)), dir).toBe(false)
    })

    it('a default model whose review is pending stops the run before any runtime: "fetch-models failed.", exit 1', () => {
      const root = scriptRoot('orch-pending-')
      seed(root, DEFAULT_IDS, pendingFirst)
      const r = leg.run(preparer, [f('Target'), root, f('WithAssets'), f('DryRun')], { timeoutMs: HEAVY_MS })
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain(`BLOCK  ${DEFAULT_IDS[0]}`)
      expect(out).toContain('fetch-models failed.')
      expect(out).not.toMatch(/Fetch (runtime|OCR)/)
    })
  })

  describe.skipIf(leg.skip)(`build-commercial-drive dry pipeline — ${leg.name}`, () => {
    const builder = `build-commercial-drive.${leg.ext}`
    const f = leg.flag
    const step = (n: number): RegExp => new RegExp(`^\\[${n}\\] `, 'm')
    /** A Kit target holding the committed runtime pin and one bundled model, so steps 1-3 stay small. */
    function kitTarget(prefix: string): string {
      const root = scriptRoot(prefix)
      seed(root, [BUNDLED_ID])
      return root
    }
    const dry = (root: string, extra: string[]) => leg.run(builder, [f('Target'), root, f('DryRun'), ...extra], { timeoutMs: HEAVY_MS })

    // A dry run's verdict on a drive with no app is NOT SELLABLE (exit 1); what matters is that the run got there.
    it('skipping the package step still reaches the final check [7], with no missing-app notice', () => {
      const r = dry(kitTarget('orch-skip-'), [f('SkipPackage')])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toMatch(step(7))
      expect(out).toContain(`${f('SkipPackage')} set: skipping packaging`)
      expect(out).not.toContain(`No ${f('AppArtifact')} supplied`)
    })

    // The artifact was checked only at step 4, after steps 1-3 had downloaded every weight and runtime.
    it('a missing app artifact is refused before step 1', () => {
      const artifact = join(mkdtempSync(join(tmpdir(), 'hilbertraum-orch-art-')), 'gone', `HilbertRaum-${APP_VERSION}-portable.exe`)
      const r = dry(kitTarget('orch-missing-'), [f('AppArtifact'), artifact])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain(`AppArtifact not found: ${artifact}`)
      expect(out).not.toMatch(step(1))
    })

    // The control of script-execution's refusal row: the incoming build's own name at the root is where it is copied to.
    it('an artifact of the same name at the root is no prior build: the run proceeds to the step-4 copy', () => {
      const root = kitTarget('orch-same-')
      const name = `HilbertRaum-${APP_VERSION}-portable.exe`
      writeFileSync(join(root, name), 'old')
      const artifact = join(mkdtempSync(join(tmpdir(), 'hilbertraum-orch-art-')), name)
      writeFileSync(artifact, 'new')
      const out = outputOf(dry(root, [f('AppArtifact'), artifact]))
      expect(out).not.toContain('Refusing to proceed')
      expect(out).toMatch(step(4))
      expect(out).toContain(`copy ${artifact} -> `)
    })

    // #339 P8-4, a copyleft duty: no kiwix-tools binary reaches a Kit without its corresponding source.
    it('a kiwix source dir without the archives is refused before any kiwix-tools fetch (exit 1)', () => {
      const r = dry(kitTarget('orch-kiwix-'), [f('KiwixSourceDir'), mkdtempSync(join(tmpdir(), 'hilbertraum-orch-kiwix-'))])
      const out = outputOf(r)
      expect(r.status, out).toBe(1)
      expect(out).toContain('missing source archive')
      expect(out).toContain('refusing to fetch kiwix-tools binaries without their source')
      expect(out.replace(/\\/g, '/')).not.toMatch(/into:.*\/runtime\/kiwix-tools\//)
      expect(out).not.toMatch(step(4))
    })
  })
}

// release.yml runs this on a tag build and appends its output to the release notes. The sh leg only, as the workflow does.
const shLeg = SCRIPT_LEGS.find((l) => l.ext === 'sh')!

describe.skipIf(shLeg.skip)('release-issues-section.sh against a stub gh (#769)', () => {
  // What gh's own -q filters would print, unsorted and with repeats: sha1 -> PR 10, sha2 -> PRs 9 and 10, sha3 -> PR 11.
  // PRs 10 and 11 both close issue 100.
  const stubDir = mkdtempSync(join(tmpdir(), 'hilbertraum-orch-gh-'))
  writeFileSync(
    join(stubDir, 'gh'),
    [
      '#!/bin/sh',
      'case "$1 $2" in',
      '  "release view") [ -n "${GH_STUB_PREV:-}" ] || exit 1; echo "$GH_STUB_PREV" ;;',
      "  \"api --paginate\") printf 'sha1\\nsha2\\nsha3\\n' ;;",
      '  "api repos/"*)',
      '    case "$2" in',
      '      */sha1/pulls) echo 10 ;;',
      "      */sha2/pulls) printf '9\\n10\\n' ;;",
      '      */sha3/pulls) [ -z "${GH_STUB_FAIL:-}" ] || exit 1; echo 11 ;;',
      '    esac ;;',
      '  "api graphql")',
      '    for a in "$@"; do',
      '      case "$a" in',
      "        pr=9) printf '99\\tNine\\n' ;;",
      "        pr=10) printf '100\\tTen\\n' ;;",
      "        pr=11) printf '100\\tTen\\n101\\tEleven\\n' ;;",
      '      esac',
      '    done ;;',
      '  *) echo "unexpected gh call: $*" >&2; exit 9 ;;',
      'esac',
      ''
    ].join('\n'),
    { mode: 0o755 }
  )
  const section = (env: NodeJS.ProcessEnv) =>
    shLeg.run('release-issues-section.sh', ['owner/repo', 'v2'], {
      env: { PATH: `${stubDir}${delimiter}${process.env.PATH ?? ''}`, GH_STUB_PREV: '', GH_STUB_FAIL: '', ...env }
    })

  it('lists each closed issue once, in numeric order (#99 before #100), however many PRs close it', () => {
    const r = section({ GH_STUB_PREV: 'v1' })
    expect(r.status, outputOf(r)).toBe(0)
    expect(r.stdout).toBe('## Issues resolved\n\n- #99 — Nine\n- #100 — Ten\n- #101 — Eleven\n\n')
  })

  it.each<[string, NodeJS.ProcessEnv]>([
    ['no published release', {}],
    ['a re-run after this tag published', { GH_STUB_PREV: 'v2' }]
  ])('%s: no section, exit 0', (_title, env) => {
    const r = section(env)
    expect(r.status, outputOf(r)).toBe(0)
    expect(r.stdout).toBe('')
  })

  // The workflow turns a non-zero exit into a warning. Only the LAST call of each loop reaches the exit status, so this
  // row fails the last one: an earlier failure is swallowed today, and the section comes out short.
  it('a failed PR lookup on the last commit ends the run with exit 1 and no section', () => {
    const r = section({ GH_STUB_PREV: 'v1', GH_STUB_FAIL: '1' })
    expect(r.status, outputOf(r)).toBe(1)
    expect(r.stdout).toBe('')
  })
})
