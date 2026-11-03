import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { assertCommercialDrive, type CommercialAssertion } from '../services/commercial-drive'
import { discoverManifests } from '../services/models'
import {
  isKitPlatform,
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
// 0 sellable (or `--help`) · 1 not sellable · 2 usage error, an unknown platform included.

const USAGE =
  'usage: node assert-commercial-drive.mjs --target <drive-root> ' +
  '--platforms <win-x64,mac-arm64,linux-x64> --app-version <version> [--json]'

interface Args {
  target: string
  platforms: KitPlatform[]
  appVersion: string
  json: boolean
}

/** What a command line that runs no gate prints: the usage on stdout for `--help` (exit 0), a cause on stderr (exit 2). */
interface NoRun {
  exitCode: 0 | 2
  text: string
}

function parseArgs(argv: string[]): Args | NoRun {
  const usageError = (cause: string): NoRun => ({ exitCode: 2, text: `${cause}\n${USAGE}` })
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
      else if (a === '-h' || a === '--help') return { exitCode: 0, text: USAGE }
      else return usageError(`unknown argument: ${a}`)
    } catch (err) {
      return usageError(err instanceof Error ? err.message : String(err))
    }
  }
  if (!target) return usageError('--target is required')
  if (platforms.length === 0) return usageError(`--platforms is required (${KIT_PLATFORMS.join(', ')})`)
  // A typo in the label is the caller's error, not the drive's: no gate verdict for it (#769).
  const unknown = platforms.filter((p) => !isKitPlatform(p))
  if (unknown.length > 0) {
    return usageError(`unknown platform ${unknown.map((p) => `"${p}"`).join(', ')} (known: ${KIT_PLATFORMS.join(', ')})`)
  }
  if (!appVersion) return usageError('--app-version is required')
  return { target: resolve(target), platforms: platforms.filter(isKitPlatform), appVersion, json }
}

interface DriveInputs {
  manifests: ReturnType<typeof discoverManifests>['manifests']
  runtime: RuntimeSources | null
  whisper: RuntimeSources | null
  ocr: OcrSources | null
  /** The optional kiwix_tools family (#339 P8-1), passed through the gate's `families` option. */
  kiwix: RuntimeSources | null
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
  // #339 P8-1: the optional kiwix_tools family rides the gate's `families` option — the three
  // positionals above are frozen; every further family goes through the keyed map.
  let kiwix: RuntimeSources | null = null
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
        kiwix = res.families?.kiwix_tools ?? null
        summary.push(
          `runtime pin llama_cpp ${runtime.version}` +
            (whisper ? `, whisper_cpp ${whisper.version}` : ', no whisper_cpp block') +
            (ocr ? `, ocr ${ocr.version}` : ', no ocr block') +
            (kiwix ? `, kiwix_tools ${kiwix.version} (optional)` : ', no kiwix_tools block')
        )
      }
    }
  }
  return { manifests, runtime, whisper, ocr, kiwix, problems, summary }
}

async function main(argv: string[]): Promise<number> {
  const args = parseArgs(argv)
  if ('exitCode' in args) {
    if (args.exitCode === 0) console.log(args.text)
    else console.error(args.text)
    return args.exitCode
  }
  if (args.json) {
    // stdout carries the one JSON object. The services log through console.log (services/logging.ts), and hashing a
    // weight logs a line, which landed ahead of the object (#767): send every such line to stderr for this run.
    const toStderr = (...line: unknown[]): void => console.error(...line)
    console.log = toStderr
    console.info = toStderr
    console.debug = toStderr
  }
  const inputs = readDriveInputs(args.target)
  const result: CommercialAssertion = await assertCommercialDrive(
    args.target,
    inputs.manifests.map((m) => m.manifest),
    inputs.runtime,
    inputs.whisper,
    inputs.ocr,
    {
      platforms: args.platforms,
      appVersion: args.appVersion,
      families: { kiwix_tools: inputs.kiwix }
    }
  )
  const problems = [...inputs.problems, ...result.problems]
  const ok = problems.length === 0
  if (args.json) {
    process.stdout.write(`${JSON.stringify({ ok, problems, checks: result.checks })}\n`)
    return ok ? 0 : 1
  }
  console.log(`assert-commercial-drive: ${args.target}`)
  console.log(`  platforms: ${args.platforms.join(', ')} | app version: ${args.appVersion}`)
  for (const s of inputs.summary) console.log(`  ${s}`)
  for (const [name, value] of Object.entries(result.checks)) console.log(`  ${value ? 'ok  ' : 'FAIL'} ${name}`)
  if (ok) {
    console.log(`SELLABLE: every check passed (${Object.keys(result.checks).length} checks).`)
    return 0
  }
  console.log('NOT SELLABLE:')
  for (const p of problems) console.log(`  - ${p}`)
  return 1
}

process.exitCode = await main(process.argv.slice(2))
