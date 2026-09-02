import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { assertCommercialDrive, type CommercialAssertion } from '../services/commercial-drive'
import { discoverManifests } from '../services/models'
import {
  KIT_PLATFORMS,
  validateRuntimeSources,
  type KitPlatform,
  type OcrSources,
  type RuntimeSources
} from '../../shared/runtime-sources'

// The one commercial gate, runnable from a shell (#233, #234). Built by
// `vite.tools.config.ts` into `out/tools/assert-commercial-drive.mjs` and called by
// `scripts/build-commercial-drive.{ps1,sh}` with plain `node`: the scripts print
// SELLABLE only from this verdict. Reads only the drive (no network). Exit codes:
// 0 sellable · 1 not sellable · 2 usage error.

const USAGE =
  'usage: node assert-commercial-drive.mjs --target <drive-root> ' +
  '--platforms <win-x64,mac-arm64,linux-x64> --app-version <version> [--json]'

interface Args {
  target: string
  platforms: string[]
  appVersion: string
  json: boolean
}

function parseArgs(argv: string[]): Args | string {
  let target = ''
  let platforms: string[] = []
  let appVersion = ''
  let json = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => {
      const v = argv[i + 1]
      if (v === undefined) throw new Error(`${a} needs a value`)
      i++
      return v
    }
    try {
      if (a === '--target') target = next()
      else if (a === '--platforms')
        platforms = next()
          .split(',')
          .map((p) => p.trim())
          .filter((p) => p.length > 0)
      else if (a === '--app-version') appVersion = next()
      else if (a === '--json') json = true
      else if (a === '-h' || a === '--help') return USAGE
      else return `unknown argument: ${a}\n${USAGE}`
    } catch (err) {
      return `${err instanceof Error ? err.message : String(err)}\n${USAGE}`
    }
  }
  if (!target) return `--target is required\n${USAGE}`
  if (platforms.length === 0) return `--platforms is required (${KIT_PLATFORMS.join(', ')})\n${USAGE}`
  if (!appVersion) return `--app-version is required\n${USAGE}`
  return { target: resolve(target), platforms, appVersion, json }
}

interface DriveInputs {
  manifests: ReturnType<typeof discoverManifests>['manifests']
  runtime: RuntimeSources | null
  whisper: RuntimeSources | null
  ocr: OcrSources | null
  problems: string[]
  summary: string[]
}

/** The drive's own manifests + runtime pin — what the app itself reads at launch. */
function readDriveInputs(root: string): DriveInputs {
  const problems: string[] = []
  const summary: string[] = []
  const manifestsDir = join(root, 'model-manifests')
  let manifests: DriveInputs['manifests'] = []
  if (!existsSync(manifestsDir)) {
    problems.push('model-manifests/ missing on the drive — run prepare-drive')
  } else {
    const discovered = discoverManifests(manifestsDir)
    manifests = discovered.manifests
    for (const e of discovered.errors) problems.push(`model manifest invalid: ${e}`)
    summary.push(`${manifests.length} model manifest(s)`)
  }
  let runtime: RuntimeSources | null = null
  let whisper: RuntimeSources | null = null
  let ocr: OcrSources | null = null
  const pin = join(manifestsDir, 'runtime-sources.yaml')
  if (!existsSync(pin)) {
    problems.push('model-manifests/runtime-sources.yaml missing on the drive — run prepare-drive')
  } else {
    let raw: unknown
    try {
      raw = parseYaml(readFileSync(pin, 'utf8'))
    } catch (err) {
      problems.push(`runtime-sources.yaml: YAML parse error — ${String(err)}`)
    }
    if (raw !== undefined) {
      const res = validateRuntimeSources(raw)
      if (!res.ok || !res.sources) {
        problems.push(`runtime-sources.yaml invalid: ${res.errors.join('; ')}`)
      } else {
        runtime = res.sources
        whisper = res.whisper ?? null
        ocr = res.ocr ?? null
        summary.push(
          `runtime pin llama_cpp ${runtime.version}` +
            (whisper ? `, whisper_cpp ${whisper.version}` : ', no whisper_cpp block') +
            (ocr ? `, ocr ${ocr.version}` : ', no ocr block')
        )
      }
    }
  }
  return { manifests, runtime, whisper, ocr, problems, summary }
}

export async function main(argv: string[], out: (line: string) => void = console.log): Promise<number> {
  const args = parseArgs(argv)
  if (typeof args === 'string') {
    console.error(args)
    return 2
  }
  const inputs = readDriveInputs(args.target)
  const result: CommercialAssertion = await assertCommercialDrive(
    args.target,
    inputs.manifests.map((m) => m.manifest),
    inputs.runtime,
    inputs.whisper,
    inputs.ocr,
    { platforms: args.platforms as KitPlatform[], appVersion: args.appVersion }
  )
  const problems = [...inputs.problems, ...result.problems]
  const ok = problems.length === 0
  if (args.json) {
    out(JSON.stringify({ ok, problems, checks: result.checks }))
    return ok ? 0 : 1
  }
  out(`assert-commercial-drive: ${args.target}`)
  out(`  platforms: ${args.platforms.join(', ')} | app version: ${args.appVersion}`)
  for (const s of inputs.summary) out(`  ${s}`)
  for (const [name, value] of Object.entries(result.checks)) out(`  ${value ? 'ok  ' : 'FAIL'} ${name}`)
  if (ok) {
    out(`SELLABLE: every check passed (${Object.keys(result.checks).length} checks).`)
    return 0
  }
  out('NOT SELLABLE:')
  for (const p of problems) out(`  - ${p}`)
  return 1
}

process.exitCode = await main(process.argv.slice(2))
