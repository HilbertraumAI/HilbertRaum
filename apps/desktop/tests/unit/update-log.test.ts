import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatUpdateLogLine,
  startFailedFields,
  startupFields,
  type TextRead
} from '../../src/main/services/updates/update-log'
import type { DriveReleaseRead } from '../../src/main/services/updates/drive-release'
import type { BackendStartFailure } from '../../src/shared/types'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// F-11 (app-update plan Appendix B, W-14, W-68; docs/app-updates.md 5.1, 5.3 table B.2, 8.2): the line grammar of
// `<drive>/updates/update.log`. Release 1 writes these lines on every Kit for ever, and the start files, the apply
// scripts and every later version append to the same file, so the rules are frozen. The expected lines are the
// golden's (tests/fixtures/readers/f11-update-log/), written by hand from the plan, the record and the T3.2 sheet,
// never from the writer's output. This file holds the pure rules: the fields of each event and the one formatter every
// line goes through. What the writer does on a real drive (the folder, links, the size cap) is
// tests/integration/update-log-drive.test.ts; the failed-start line in the start runner is
// tests/integration/backend-start-failure.test.ts.

type ReadInput = { kind: 'absent' } | { kind: 'unreadable' } | { kind: 'text'; text?: string; yaml?: string }
interface StartupInput {
  platform: string
  now: string
  version: unknown
  runtime_sources: ReadInput
  drive_release: DriveReleaseRead
  drive_json: ReadInput
  sqlite: unknown
}
interface ThrownInput {
  message: string
  props: Record<string, unknown>
  throwing_getter?: string
}
interface Parse {
  writer: string
  os: string
  event: string
  fields: Record<string, string>
  time: { kind: 't'; value: string } | { kind: 'd' } | { kind: 'none' }
}
interface Golden {
  accept: { vectors: Array<{ name: string; line?: string; bytes_b64?: string; parse: Parse | 'blank' | 'torn'; copied: string | null }> }
  emit: {
    startup: {
      yaml: Record<string, string>
      base: StartupInput
      vectors: Array<{ name: string; why: string; with: Partial<StartupInput>; line: string }>
    }
    start_failed: {
      base: { platform: string; now: string; version: unknown }
      vectors: Array<{
        name: string
        why: string
        platform?: string
        version?: unknown
        thrown: ThrownInput
        failure: BackendStartFailure
        never: string[]
        line: string
      }>
    }
    generic: {
      base: { platform: string; now: string }
      vectors: Array<{ name: string; why: string; event: string; fields: Array<[string, string]>; line: string | null }>
    }
  }
}

const GOLDEN = JSON.parse(
  readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors.json'), 'utf8')
) as Golden
const { startup, start_failed: startFailed, generic } = GOLDEN.emit

function readOf(input: ReadInput): TextRead {
  if (input.kind !== 'text') return { kind: input.kind }
  const text = input.yaml !== undefined ? startup.yaml[input.yaml] : input.text
  if (text === undefined) throw new Error(`the golden names no text for ${JSON.stringify(input)}`)
  return { kind: 'text', text }
}

function startupLine(input: StartupInput): string | null {
  const fields = startupFields({
    appVersion: input.version,
    runtimeSources: readOf(input.runtime_sources),
    driveRelease: input.drive_release,
    driveJson: readOf(input.drive_json),
    sqlite: input.sqlite
  })
  return formatUpdateLogLine('startup', fields, { platform: input.platform, now: new Date(input.now) })
}

/** What the start threw, as the vector describes it: an Error with its own properties, or a getter that throws. */
function thrownOf(t: ThrownInput): Error {
  const err = Object.assign(new Error(t.message), t.props)
  if (t.throwing_getter !== undefined) {
    Object.defineProperty(err, t.throwing_getter, {
      get() {
        throw new Error('no value for you')
      }
    })
  }
  return err
}

/** Every byte of an emitted line is printable ASCII (0x21-0x7E) or a single space between tokens. */
function expectAsciiFrame(line: string): void {
  const bytes = Buffer.from(line, 'utf8')
  expect(bytes.every((b) => b >= 0x20 && b <= 0x7e)).toBe(true)
  expect(line).not.toMatch(/^ | $| {2}/)
  expect(bytes.length).toBeLessThanOrEqual(256)
}

/**
 * The record's reading of one update.log line (5.1 G0, 5.3), written from its text and not from the writer: one CR
 * before the line end removed, spaces and TABs trimmed, the byte rule and the split stopping at ` d="`, fields split at
 * the first `=`, a token without `=` or with an empty key ignored, the first of two equal keys kept, a last `t=` the time.
 */
function readLine(bytes: Buffer): { parse: Parse | 'blank' | 'torn'; copied: string | null } {
  let b = bytes
  if (b.length > 0 && b[b.length - 1] === 0x0a) b = b.subarray(0, -1)
  if (b.length > 0 && b[b.length - 1] === 0x0d) b = b.subarray(0, -1)
  let start = 0
  let end = b.length
  while (start < end && (b[start] === 0x20 || b[start] === 0x09)) start++
  while (end > start && (b[end - 1] === 0x20 || b[end - 1] === 0x09)) end--
  b = b.subarray(start, end)
  if (b.length === 0) return { parse: 'blank', copied: null }
  const copied = [...b].map((x) => (x >= 0x20 && x <= 0x7e ? String.fromCharCode(x) : '?')).join('')
  const opaque = b.indexOf(' d="')
  const head = opaque < 0 ? b : b.subarray(0, opaque)
  if (!head.every((x) => x === 0x09 || (x >= 0x20 && x <= 0x7e))) return { parse: 'torn', copied }
  const tokens = head.toString('latin1').split(/[ \t]+/)
  const [writer = '', os = '', event = '', ...rest] = tokens
  let time: Parse['time'] = opaque < 0 ? { kind: 'none' } : { kind: 'd' }
  if (opaque < 0 && rest.length > 0 && rest[rest.length - 1].startsWith('t=')) time = { kind: 't', value: rest.pop()!.slice(2) }
  const fields: Record<string, string> = {}
  for (const token of rest) {
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const key = token.slice(0, eq)
    if (!Object.hasOwn(fields, key)) fields[key] = token.slice(eq + 1)
  }
  return { parse: { writer, os, event, fields, time }, copied }
}

describe('F-11 golden: the startup line (W-14, W-68)', () => {
  it.each(startup.vectors)('$name: $why', (v) => {
    const line = startupLine({ ...startup.base, ...v.with })
    expect(line).toBe(v.line)
    expectAsciiFrame(line!)
  })
})

describe('F-11 golden: the failed-start line (W-14, W-82; decision row 3: the code and the bare system call only)', () => {
  it.each(startFailed.vectors)('$name: $why', (v) => {
    const fields = startFailedFields({
      appVersion: v.version !== undefined ? v.version : startFailed.base.version,
      failure: v.failure,
      thrown: thrownOf(v.thrown)
    })
    const line = formatUpdateLogLine('start-failed', fields, {
      platform: v.platform ?? startFailed.base.platform,
      now: new Date(startFailed.base.now)
    })
    expect(line).toBe(v.line)
    expectAsciiFrame(line!)
    // Content-free by grammar: nothing of the message, the path or the drive root reaches the line.
    for (const text of v.never) expect(line, text).not.toContain(text)
  })
})

describe('F-11 golden: the one formatter every app line goes through (the P6 and P7 events reuse it)', () => {
  it.each(generic.vectors)('$name: $why', (v) => {
    const line = formatUpdateLogLine(v.event, v.fields, { platform: generic.base.platform, now: new Date(generic.base.now) })
    expect(line).toBe(v.line)
    if (line !== null) expectAsciiFrame(line)
  })
})

describe('F-11 golden: what a reader accepts, read as the record says', () => {
  it.each(GOLDEN.accept.vectors)('$name', (v) => {
    const bytes = v.bytes_b64 !== undefined ? Buffer.from(v.bytes_b64, 'base64') : Buffer.from(v.line ?? '', 'utf8')
    expect(readLine(bytes)).toEqual({ parse: v.parse, copied: v.copied })
  })

  it('every line the HEAD writer emits reads back as written: writer r1-app, no token ignored, no key twice', () => {
    const emitted = [
      ...startup.vectors.map((v) => v.line),
      ...startFailed.vectors.map((v) => v.line),
      ...generic.vectors.flatMap((v) => (v.line === null ? [] : [v.line]))
    ]
    for (const line of emitted) {
      const { parse, copied } = readLine(Buffer.from(line, 'utf8'))
      expect(copied, line).toBe(line)
      if (typeof parse === 'string') throw new Error(`${line} reads as ${parse}`)
      expect(parse.writer).toBe('r1-app')
      const tokens = line.split(' ')
      const timed = parse.time.kind === 't' ? 1 : 0
      expect(Object.keys(parse.fields).length + 3 + timed, line).toBe(tokens.length)
    }
  })
})
