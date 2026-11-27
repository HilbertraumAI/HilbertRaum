import { describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendUpdateLogLine,
  formatRegisteredLine,
  formatUpdateLogLine,
  startFailedFields,
  startupFields,
  UPDATE_LOG_EVENTS,
  type TextRead,
  type UpdateLogEvent,
  type UpdateLogField
} from '../../src/main/services/updates/update-log'
import type { DriveReleaseRead } from '../../src/main/services/updates/drive-release'
import { logVersion } from '../../src/main/services/updates/staging'
import type { BackendStartFailure } from '../../src/shared/types'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// F-11 (app-update plan Appendix B, W-14, W-68; docs/app-updates.md 5.1, 5.3 table B.2, 8.2): the line grammar of
// `<drive>/updates/update.log`. Release 1 writes these lines on every Kit for ever, and the start files, the apply
// scripts and every later version append to the same file, so the rules are frozen. The expected lines are the
// golden's (tests/fixtures/readers/f11-update-log/), written by hand from the plan, the record and the T3.2 sheet,
// never from the writer's output. This file holds the pure rules: the fields of each event, the registered events and
// their typed fields (Δ-66: the appender writes only those, each field only by its key's rule), and the frame every
// line goes through last, and the appender's answer (whether it wrote; its rows, at the end, write to a scratch root).
// What the writer does on a real drive (the folder, links, the size cap) is
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
  accept: { vectors: Array<{ name: string; line?: string; bytes_b64?: string; parse: Parse | 'blank' | 'torn' | 'long'; copied: string | null }> }
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
  return formatRegisteredLine('startup', fields, { platform: input.platform, now: new Date(input.now) })
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
 * Any writer, OS and event token is read as it stands. A line over 1,024 bytes after the trimming is kept as the fixed
 * placeholder with its length, never its bytes (5.3, 5.9: T3.7's fix round settled CF-34; P6's copy reader is built
 * against golden `a11`).
 */
function readLine(bytes: Buffer): { parse: Parse | 'blank' | 'torn' | 'long'; copied: string | null } {
  let b = bytes
  if (b.length > 0 && b[b.length - 1] === 0x0a) b = b.subarray(0, -1)
  if (b.length > 0 && b[b.length - 1] === 0x0d) b = b.subarray(0, -1)
  let start = 0
  let end = b.length
  while (start < end && (b[start] === 0x20 || b[start] === 0x09)) start++
  while (end > start && (b[end - 1] === 0x20 || b[end - 1] === 0x09)) end--
  b = b.subarray(start, end)
  if (b.length === 0) return { parse: 'blank', copied: null }
  if (b.length > 1024) return { parse: 'long', copied: `[line of ${b.length} bytes not shown]` }
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
    const line = formatRegisteredLine('start-failed', fields, {
      platform: v.platform ?? startFailed.base.platform,
      now: new Date(startFailed.base.now)
    })
    expect(line).toBe(v.line)
    expectAsciiFrame(line!)
    // Content-free by the event's typed fields: nothing of the message, the path or the drive root reaches the line.
    for (const text of v.never) expect(line, text).not.toContain(text)
  })
})

describe('F-11 golden: the frame every app line goes through last (each later registration must fit it)', () => {
  it.each(generic.vectors)('$name: $why', (v) => {
    const line = formatUpdateLogLine(v.event, v.fields, { platform: generic.base.platform, now: new Date(generic.base.now) })
    expect(line).toBe(v.line)
    if (line !== null) expectAsciiFrame(line)
  })
})

// Δ-66 (T3.2 review 1, M-2): the value rule alone lets a one-word file, host or account name through, so the app's
// lines are content-free by each event's typed fields: the appender writes only registered events (`UPDATE_LOG_EVENTS`,
// where T3.10 adds `unlock` and P6/P7 their events, as data), and a field only by the rule its key names there. What
// each rule admits is written here by hand from F-11's token rules (the golden's `tokens`), never read from the table.
// Every refused value below passes the frame's value rule, so only the typed layer can refuse it.
describe('F-11 typed events (Δ-66): only registered events are lines, and a field only by its key’s rule', () => {
  const AT = { platform: 'win32', now: new Date('2026-11-25T10:00:00.123Z') }
  const T = 't=2026-11-25T10:00:00Z'
  const goldenLine = (name: string): string =>
    [...startup.vectors, ...startFailed.vectors].find((v) => v.name === name)!.line
  /** Golden f01's fields and s01's, by hand. */
  const F01: UpdateLogField[] = [['version', '0.1.66'], ['cause', 'other'], ['err', 'EEXIST'], ['syscall', 'mkdir']]
  const S01: UpdateLogField[] = [
    ['version', '0.1.66'], ['llama', 'b12110'], ['whisper', 'v1.8.6'], ['kiwix', '3.8.1'], ['release', '0.1.66'],
    ['release_format', '1'], ['drive_format', '1'], ['sqlite', '3.50.4']
  ]
  /** The review's probes: a file name, a host name and two account names of one ASCII word each; (recheck N-1) and an
   *  account name in a version's shape (V) and one in an error code's (E). */
  const PROBES = ['Steuer_2026.xlsx', 'DESKTOPDIT', 'peter', 'peters-mbp.local', '1.0.0-peter', 'EMMA']

  // Golden g10's and g05's events, and the one name every object has that the frame takes (the table is looked up by
  // its own keys only).
  it.each(['x', 'eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'constructor'])(
    'an event nobody registered is no line, though the frame takes it: %s',
    (event) => {
      expect(formatUpdateLogLine(event, [['code', 'UPD-UPDATED']], AT)).not.toBeNull() // the frame alone would write it
      expect(formatRegisteredLine(event as UpdateLogEvent, [['code', 'UPD-UPDATED']], AT)).toBeNull()
    }
  )

  it('a key the event’s schema does not name never reaches the line, whatever its value', () => {
    const extras: UpdateLogField[] = [
      ['file', 'Steuer_2026.xlsx'], ['host', 'DESKTOPDIT'], ['user', 'peter'], ['code', 'UPD-UPDATED'], ['n', '3'],
      ['t', '2020-01-01T00:00:00Z']
    ]
    expect(formatRegisteredLine('start-failed', [...extras, ...F01, ...extras], AT)).toBe(goldenLine('f01'))
    expect(formatRegisteredLine('startup', [...extras, ...S01, ...extras], AT)).toBe(goldenLine('s01'))
  })

  // The review's probes against every key of every registered event, so a later registration is probed too. A pin
  // (P) and a system call (C) are word-shaped, a version (V) and an error code (E) in their own shapes, the stamp's
  // applied-through token (A, T3.10) outright: a key naming one takes its value from its own source (the app's version,
  // its bundled yaml, a thrown error's code and syscall) or is data-fed and named so in update-log.ts's header. The keys
  // that admit a probe are named here, by hand.
  it('the review’s file, host and account names reach no key whose rule refuses them (every word-shaped key named)', () => {
    const admitsAProbe: Record<string, string[]> = {
      // own source: the app's version, its bundled yaml's pins, a thrown error's code and system call
      'startup.version': ['1.0.0-peter'],
      'startup.llama': ['Steuer_2026.xlsx', '1.0.0-peter'],
      'startup.whisper': ['Steuer_2026.xlsx', '1.0.0-peter'],
      'startup.kiwix': ['Steuer_2026.xlsx', '1.0.0-peter'],
      'start-failed.version': ['1.0.0-peter'],
      'start-failed.err': ['EMMA'],
      'start-failed.syscall': ['peter'],
      'unlock.err': ['EMMA'],
      'unlock.syscall': ['peter'],
      // data-fed (update-log.ts's header names them): config/drive-release.json; the workspace's last_writer stamp
      'startup.release': ['1.0.0-peter'],
      'unlock.writer': ['1.0.0-peter'],
      'unlock.applied': ['Steuer_2026.xlsx', 'DESKTOPDIT', 'peter', 'peters-mbp.local', '1.0.0-peter', 'EMMA'],
      // P6's import events (T6.2): a run's own verified payload's version, a thrown error's code and system call
      'import-refused.version': ['1.0.0-peter'],
      'import-refused.err': ['EMMA'],
      'import-refused.syscall': ['peter'],
      'import-staged.version': ['1.0.0-peter'],
      'import-cancelled.version': ['1.0.0-peter'],
      // data-fed (update-log.ts's header names it): the discarded folder's staged.json, which release 1 does not verify again
      'staging-discarded.version': ['1.0.0-peter']
    }
    const admitted: Record<string, string[]> = {}
    for (const [event, schema] of Object.entries(UPDATE_LOG_EVENTS) as Array<[UpdateLogEvent, ReadonlyArray<{ key: string }>]>) {
      for (const { key } of schema) {
        const passing = PROBES.filter((probe) => formatRegisteredLine(event, [[key, probe]], AT)!.includes(`=${probe}`))
        if (passing.length > 0) admitted[`${event}.${key}`] = passing
      }
    }
    expect(admitted).toEqual(admitsAProbe)
  })

  // [event, key, value, admitted]: each token rule (F-11) through a key that names it, with the sentinels that key
  // admits and no other.
  it.each<[UpdateLogEvent, string, string, boolean]>([
    // V: SemVer 2.0.0, at most 24 bytes; `version` admits `unknown`, `release` `absent` and `unreadable`
    ['start-failed', 'version', '100.200.300-rc.123456789', true],
    ['start-failed', 'version', '1.2.3-aaaaaaaaaaaaaaaaaaa', false],
    ['start-failed', 'version', 'v0.1.66', false],
    ['start-failed', 'version', 'unknown', true],
    ['start-failed', 'version', 'absent', false],
    ['startup', 'release', 'unreadable', true],
    ['startup', 'release', 'unknown', false],
    // P: at most 16 bytes, holding a digit; a pin admits `absent` and `unreadable`
    ['startup', 'llama', 'b123456789012345', true],
    ['startup', 'llama', 'b1234567890123456', false],
    ['startup', 'whisper', 'none', false],
    ['startup', 'kiwix', 'absent', true],
    ['startup', 'kiwix', 'unknown', false],
    // I: at most six digits; `release_format` admits no sentinel, `drive_format` `absent` and `unreadable`
    ['startup', 'release_format', '999999', true],
    ['startup', 'release_format', '1000000', false],
    ['startup', 'release_format', '-1', false],
    ['startup', 'release_format', 'absent', false],
    ['startup', 'drive_format', 'unreadable', true],
    ['startup', 'drive_format', 'none', false],
    // S: three or four parts of at most three digits; `sqlite` admits `unknown`
    ['startup', 'sqlite', '3.50.4.1', true],
    ['startup', 'sqlite', '3.50', false],
    ['startup', 'sqlite', '1234.1.1', false],
    ['startup', 'sqlite', 'unknown', true],
    // E: an errno, Node or SQLite code of at most 40 bytes, or libuv's literal UNKNOWN (m-6); no sentinel
    ['start-failed', 'err', 'EPERM', true],
    ['start-failed', 'err', 'UNKNOWN', true],
    ['start-failed', 'err', 'ERR_SQLITE_ERROR', true],
    ['start-failed', 'err', 'SQLITE_26', true],
    ['start-failed', 'err', 'EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', false],
    ['start-failed', 'err', 'UNKNOWN2', false],
    ['start-failed', 'err', 'unknown', false],
    // C: a bare system call of at most 16 bytes
    ['start-failed', 'syscall', 'abcdefghijklmnop', true],
    ['start-failed', 'syscall', 'abcdefghijklmnopq', false],
    ['start-failed', 'syscall', 'Mkdir', false],
    // the closed list of causes
    ['start-failed', 'cause', 'drive_full', true],
    ['start-failed', 'cause', 'drive_on_fire', false],
    ['start-failed', 'cause', 'unknown', false]
  ])('%s %s=%s admitted: %s', (event, key, value, admitted) => {
    expect(formatUpdateLogLine(event, [[key, value]], AT)).toBe(`r1-app win32 ${event} ${key}=${value} ${T}`) // the frame takes it
    expect(formatRegisteredLine(event, [[key, value]], AT)).toBe(
      admitted ? `r1-app win32 ${event} ${key}=${value} ${T}` : `r1-app win32 ${event} ${T}`
    )
  })

  it('the fields follow the schema’s order, and of one key the first value its rule admits is kept', () => {
    const shuffled: UpdateLogField[] = [['syscall', 'mkdir'], ['err', 'eexist'], ['err', 'EEXIST'], ['err', 'EIO'], ['cause', 'other'], ['version', '0.1.66']]
    expect(formatRegisteredLine('start-failed', shuffled, AT)).toBe(goldenLine('f01'))
  })

  // The table is data a later task extends (T3.10's unlock, P6's and P7's events): every name the frame can write, the
  // longest line it allows within the 256-byte cap, and no change at run time. The longest value of each rule is its
  // cap in F-11 (V 24, P 16, I 6, S 15, E 40, C 16 bytes; T3.10's N 11, A 16), so the longest startup and failed-start
  // lines are the golden's worst cases, s46 and f14 (T3.2 review 1, m-1). The unlock line's fields are chosen per result
  // (all nine keys at their caps would exceed the cap), so its bound is checked per result over vectors-unlock.json's
  // `per_result`, with that result's own token; the longest is its golden u61.
  it('the table: names the frame can write, a longest line within 256 bytes (the golden’s s46 and f14), frozen', () => {
    const LONGEST = { V: 24, P: 16, I: 6, S: 15, E: 40, C: 16, N: 11, A: 16 } as const
    const UNLOCK = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors-unlock.json'), 'utf8')) as {
      fields: { per_result: Record<string, string[]> }
      emit: { vectors: Array<{ name: string; line: string }> }
    }
    const SENTINELS = ['unknown', 'absent', 'unreadable', 'none']
    const longestLine: Record<string, number> = {}
    for (const [event, schema] of Object.entries(UPDATE_LOG_EVENTS)) {
      expect(event).toMatch(/^[a-z][a-z0-9-]{0,31}$/)
      const keys = schema.map((spec) => spec.key)
      expect(new Set(keys).size, event).toBe(keys.length)
      const frame = 'r1-app abcdefgh '.length + event.length + ` ${T}`.length
      const longestOf = (spec: (typeof schema)[number]): number => {
        const words: readonly string[] = 'oneOf' in spec ? spec.oneOf : (spec.sentinels ?? [])
        return Math.max(...words.map((w) => w.length), 'oneOf' in spec ? 0 : LONGEST[spec.rule])
      }
      let bytes = frame
      for (const spec of schema) {
        expect(spec.key).toMatch(/^[a-z][a-z0-9_]{0,31}$/)
        expect(spec.key).not.toBe('t')
        const words: readonly string[] = 'oneOf' in spec ? spec.oneOf : (spec.sentinels ?? [])
        for (const word of words) expect(word).toMatch(/^[0-9A-Za-z._+-]{1,64}$/)
        if (!('oneOf' in spec)) for (const word of words) expect(SENTINELS).toContain(word)
        bytes += 1 + spec.key.length + 1 + longestOf(spec)
      }
      if (event === 'unlock') {
        // per result: `result=<that token>`, then only that result's fields at their caps
        bytes = 0
        for (const [result, keys] of Object.entries(UNLOCK.fields.per_result)) {
          let line = frame + ' result='.length + result.length
          for (const spec of schema) if (keys.includes(spec.key)) line += 1 + spec.key.length + 1 + longestOf(spec)
          expect(line, `unlock ${result}`).toBeLessThanOrEqual(256)
          bytes = Math.max(bytes, line)
        }
        expect(bytes).toBe(UNLOCK.emit.vectors.find((v) => v.name === 'u61')!.line.length)
      } else expect(bytes, event).toBeLessThanOrEqual(256)
      longestLine[event] = bytes
    }
    expect(longestLine.startup).toBe(goldenLine('s46').length)
    expect(longestLine['start-failed']).toBe(goldenLine('f14').length)
    expect(Object.isFrozen(UPDATE_LOG_EVENTS)).toBe(true)
    for (const schema of Object.values(UPDATE_LOG_EVENTS)) {
      expect(Object.isFrozen(schema)).toBe(true)
      for (const spec of schema) {
        expect(Object.isFrozen(spec)).toBe(true)
        if ('oneOf' in spec) expect(Object.isFrozen(spec.oneOf)).toBe(true)
        else if (spec.sentinels !== undefined) expect(Object.isFrozen(spec.sentinels)).toBe(true)
      }
    }
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

// P6's five import events (app-update T6.2; record §4.5 "update.log events of the import", §5.3; T6.0b's golden
// tests/fixtures/readers/f11-update-log/vectors-import.json, written from the record before the events were registered):
// each vector's fields as the service hands them to the formatter (a count as its decimal text), the exact line written,
// and, where the vector has `run`, the caller's own step: a valid version of 25 to 64 bytes becomes the sentinel `unknown`
// before the formatter sees it (logVersion, the service's and the sweep's helper).
interface ImportVector {
  name: string
  why: string
  event: UpdateLogEvent
  platform?: string
  run?: { version: string }
  fields: Record<string, unknown>
  line: string
}
const IMPORT = JSON.parse(readFileSync(join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log', 'vectors-import.json'), 'utf8')) as {
  events: Record<string, { order: string[]; rules: Record<string, string> }>
  emit: { base: { platform: string; now: string }; vectors: ImportVector[] }
}

describe('F-11 golden: the import events (vectors-import.json; record §4.5 "update.log events of the import")', () => {
  it.each(IMPORT.emit.vectors.map((v) => [v.name, v] as const))('%s', (_name, v) => {
    const fields = Object.entries(v.fields) as unknown as UpdateLogField[] // a count given as a number stays a number (i96, i102)
    const line = formatRegisteredLine(v.event, fields, { platform: v.platform ?? IMPORT.emit.base.platform, now: new Date(IMPORT.emit.base.now) })
    expect(line).toBe(v.line)
    expectAsciiFrame(line!)
    if (v.run !== undefined) expect(logVersion(v.run.version)).toBe(v.fields.version)
  })

  it('the caller passes a version of at most 24 bytes as it is, and `unknown` for one of 25 to 64 bytes', () => {
    expect(logVersion('100.200.300-rc.123456789')).toBe('100.200.300-rc.123456789') // 24 bytes
    expect(logVersion('100.200.300-rc.1234567890')).toBe('unknown') // 25 bytes
    expect(logVersion(`1.0.0-${'a'.repeat(58)}`)).toBe('unknown') // 64 bytes
  })

  // The five events as the golden's `events` states them, by hand from record §4.5: each key in its order, and each key's
  // closed list or token rule. The registration is data (F-11): a key added, dropped, moved or given another rule is a
  // golden change, which turns this row red.
  it('the registered schemas are the golden\u{2019}s: keys in order, each closed list and each token rule', () => {
    const closedList = (rule: string): string[] => rule.slice(rule.lastIndexOf(': ') + 2).split(';')[0]!.split(', ')
    for (const [event, { order, rules }] of Object.entries(IMPORT.events)) {
      const schema = UPDATE_LOG_EVENTS[event as UpdateLogEvent]
      expect(schema, event).toBeDefined()
      expect(schema.map((spec) => spec.key), event).toEqual(order)
      for (const spec of schema) {
        const rule = rules[spec.key]!.startsWith('as import-refused') ? IMPORT.events['import-refused']!.rules.version! : rules[spec.key]!
        if (rule.startsWith('closed:')) {
          expect('oneOf' in spec && [...spec.oneOf].sort(), `${event}.${spec.key}`).toEqual(closedList(rule).sort())
        } else {
          expect('rule' in spec && spec.rule, `${event}.${spec.key}`).toBe(rule[0])
          expect('rule' in spec && (spec.sentinels ?? []), `${event}.${spec.key}`).toEqual(spec.key === 'version' ? ['unknown'] : [])
        }
      }
    }
    expect(IMPORT.events['import-refused']!.rules.code!.split(': ').pop()!.split(', ')).toHaveLength(26)
  })
})

// The appender's answer (T6.2 review B m-1; impl/p6/T6.2/review-disposition.md F7): whether the line reached the file,
// which the update service's repeated-refusal rule counts (record §4.5's events: "the last import line this process
// wrote"). Unlike the rest of this file these rows write: each to a scratch drive root of its own. What the writer does
// on a drive beyond its answer is tests/integration/update-log-drive.test.ts's.
describe('appendUpdateLogLine answers whether it appended the line (record §4.5 N-7; §5.3)', () => {
  const FIELDS: UpdateLogField[] = [['code', 'UPD-POLICY-MANAGED']]
  function scratchRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'hr-update-log-answer-'))
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'config', 'drive.json'), '{}')
    return root
  }

  it('true when the line was appended to updates/update.log', () => {
    const root = scratchRoot()
    expect(appendUpdateLogLine({ rootPath: root, isPreparedDrive: true }, 'import-refused', FIELDS)).toBe(true)
    expect(readFileSync(join(root, 'updates', 'update.log'), 'latin1')).toMatch(/^\nr1-app [a-z0-9]+ import-refused code=UPD-POLICY-MANAGED t=\S+\n$/)
  })

  it.each([
    ['off a prepared drive', false, 'import-refused', false],
    ['an event nobody registered', true, 'not-registered', false],
    ['updates is a plain file (no real folder: the appender skips it, §5.3)', true, 'import-refused', true]
  ] as const)('false when no line was appended: %s', (_label, prepared, event, plainUpdates) => {
    const root = scratchRoot()
    if (plainUpdates) writeFileSync(join(root, 'updates'), 'x')
    expect(appendUpdateLogLine({ rootPath: root, isPreparedDrive: prepared }, event as UpdateLogEvent, FIELDS)).toBe(false)
    expect(existsSync(join(root, 'updates', 'update.log'))).toBe(false)
  })
})
