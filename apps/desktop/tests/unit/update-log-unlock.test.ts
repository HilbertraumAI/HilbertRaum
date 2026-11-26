import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  formatRegisteredLine,
  unlockFields,
  UPDATE_LOG_EVENTS,
  type UnlockFacts,
  type UpdateLogField
} from '../../src/main/services/updates/update-log'
import {
  VaultDamagedError,
  VaultDescriptorMissingError,
  VaultDescriptorUnreadableError,
  VaultMissingError,
  VaultNewerError,
  VaultOpenFailedError,
  VaultRecoveryBlockedError,
  VaultSchemaUnreadableError,
  WrongPasswordError,
  type OpenFacts
} from '../../src/main/services/workspace-vault'
import { parseLastWriter, WorkspaceNewerError } from '../../src/main/services/db'
import { UNLOCK_FAILURE_KEYS } from '../../src/shared/workspace-failure-keys'
import { DESKTOP_ROOT } from '../helpers/repo-files'

// F-11's unlock line (app-update plan W-14, T3.10, CF-23; docs/app-updates.md 8.2, 7.4): after every unlock attempt, a
// success and every refusal, one `r1-app <os> unlock ...` line, through the same typed appender as the startup line
// (UPDATE_LOG_EVENTS, Δ-66). The expected lines are the golden's (tests/fixtures/readers/f11-update-log/
// vectors-unlock.json), written by hand from the T3.10 sheet's part (a) and T3.2's token rules, never from the writer.
// This file holds the pure rules: which fields each result carries and how each value is read. Where the facts come
// from (the vault's header read and stamp) is tests/integration/workspace-vault.test.ts; the line on a real drive, one
// per attempt, through the unlock handler, is tests/integration/workspace-ipc.test.ts.

type ThrownSpec =
  | null
  | { class: 'string'; value: string }
  | { class: 'Error'; message: string; props: Record<string, unknown>; throwing_getters?: string[] }
  | { class: Exclude<keyof typeof ERRORS, 'Error'>; args: unknown[] }
interface Vector {
  name: string
  why: string
  platform?: string
  result: unknown
  open: { user_version: number | null; previous?: string | null } | null
  thrown: ThrownSpec
  never?: string[]
  line: string
}
interface Golden {
  tokens: Record<string, string>
  fields: { order: string[]; per_result: Record<string, string[]> }
  emit: { base: { platform: string; now: string }; vectors: Vector[] }
}

const DIR = join(DESKTOP_ROOT, 'tests', 'fixtures', 'readers', 'f11-update-log')
const GOLDEN = JSON.parse(readFileSync(join(DIR, 'vectors-unlock.json'), 'utf8')) as Golden
/** T3.2's golden, whose `tokens` name the rules V, P, I, S, E, C (this file's adds N and A). */
const F11 = JSON.parse(readFileSync(join(DIR, 'vectors.json'), 'utf8')) as { tokens: Record<string, string> }
const { base, vectors } = GOLDEN.emit

/** The errors a vector may name, constructed for real (their own constructors fill their content-free fields). */
const ERRORS = {
  Error,
  WrongPasswordError,
  VaultDamagedError,
  VaultOpenFailedError,
  VaultSchemaUnreadableError,
  VaultMissingError,
  VaultDescriptorMissingError,
  VaultDescriptorUnreadableError,
  VaultRecoveryBlockedError,
  VaultNewerError,
  WorkspaceNewerError
} as const

function thrownOf(spec: ThrownSpec): unknown {
  if (spec === null) return undefined
  if (spec.class === 'string') return spec.value
  if (spec.class === 'Error') {
    const err = Object.assign(new Error(spec.message), spec.props)
    for (const name of spec.throwing_getters ?? []) {
      Object.defineProperty(err, name, {
        get() {
          throw new Error('no value for you')
        }
      })
    }
    return err
  }
  const make = ERRORS[spec.class] as unknown as new (...args: unknown[]) => Error
  return new make(...spec.args)
}

/** What the vault hands out for the vector's `open`: the raw stamp parsed by F-10's reader, as the vault parses it
 *  (none stays null; absent means the open never got as far as the stamp). */
function openOf(open: Vector['open']): OpenFacts | null {
  if (open === null) return null
  if (!('previous' in open)) return { userVersion: open.user_version }
  return { userVersion: open.user_version, lastWriter: open.previous === null ? null : parseLastWriter(open.previous) }
}

function lineOf(facts: UnlockFacts, platform = base.platform): string | null {
  return formatRegisteredLine('unlock', unlockFields(facts), { platform, now: new Date(base.now) })
}

/** Every byte of an emitted line is printable ASCII (0x21-0x7E) or a single space between tokens. */
function expectAsciiFrame(line: string): void {
  const bytes = Buffer.from(line, 'utf8')
  expect(bytes.every((b) => b >= 0x20 && b <= 0x7e)).toBe(true)
  expect(line).not.toMatch(/^ | $| {2}/)
  expect(bytes.length).toBeLessThanOrEqual(256)
}

describe('F-11 golden: the unlock line (T3.10; W-14, CF-23)', () => {
  it.each(vectors)('$name: $why', (v) => {
    const line = lineOf({ result: v.result, open: openOf(v.open), thrown: thrownOf(v.thrown) }, v.platform)
    expect(line).toBe(v.line)
    expectAsciiFrame(line!)
    for (const text of v.never ?? []) expect(line, text).not.toContain(text)
  })

  // B2 (the sheet's 1B): the line's `result` is `ok` or the answer's reason, so every reason the unlock sends becomes a
  // log token for ever. Each has its own token (never `error`) and a golden line.
  it('every reason the unlock sends, and ok, is its own result token with a golden line', () => {
    const sent = Object.entries(UNLOCK_FAILURE_KEYS).flatMap(([reason, key]) => (key === null ? [] : [reason]))
    for (const result of ['ok', ...sent]) {
      expect(lineOf({ result, open: null, thrown: undefined }), result).toMatch(new RegExp(`^r1-app win32 unlock result=${result} `))
      expect(vectors.some((v) => v.result === result && v.line.includes(` result=${result} `)), result).toBe(true)
    }
    expect(Object.keys(GOLDEN.fields.per_result).sort()).toEqual(['ok', ...sent].sort())
  })

  // The fields are chosen per result: all nine keys at their caps would be over the frame's 256 bytes, and the writer
  // would skip the line. So each result is checked here with every input at its F-11 cap; the longest is golden u61.
  it('each result with every input at its cap still makes a line within 256 bytes; the longest is u61', () => {
    const open: OpenFacts = {
      userVersion: -2147483648,
      lastWriter: { appVersion: '100.200.300-rc.123456789', appliedThrough: 'a'.repeat(16) }
    }
    const thrown = Object.assign(new Error('x'), {
      code: `ERR_${'A'.repeat(36)}`,
      syscall: 'abcdefghijklmnop',
      damage: 'failed-authentication',
      found: 999999, // no `what`: a newer database, whose line also carries user_version
      failure: { kind: 'Error', code: `ERR_${'A'.repeat(36)}`, sqliteCode: null, sqlite: null }
    })
    let longest = 0
    for (const result of Object.keys(GOLDEN.fields.per_result)) {
      const line = lineOf({ result, open, thrown }, 'abcdefgh')
      expect(line, result).not.toBeNull()
      const keys = line!.split(' ').slice(4, -1).map((field) => field.slice(0, field.indexOf('=')))
      expect(keys, result).toEqual(GOLDEN.fields.order.filter((key) => GOLDEN.fields.per_result[result]!.includes(key)))
      longest = Math.max(longest, line!.length)
    }
    expect(longest).toBe(vectors.find((v) => v.name === 'u61')!.line.length)
  })

  // T3.2 review 1, recheck N-3: a new token rule is a golden change. The rules in use across every registered event are
  // the single-letter rules the goldens' `tokens` name (T3.2's six, this file's N and A).
  it('the token rules in use across the registered events are the goldens’ (a new rule is a golden change)', () => {
    const inUse = new Set<string>()
    for (const schema of Object.values(UPDATE_LOG_EVENTS)) for (const spec of schema) if ('rule' in spec) inUse.add(spec.rule)
    const named = [...Object.keys(F11.tokens), ...Object.keys(GOLDEN.tokens)].filter((name) => /^[A-Z]$/.test(name))
    expect([...inUse].sort()).toEqual([...new Set(named)].sort())
  })

  // [key, value, admitted]: the unlock's own rules (N, A), the sentinels `writer` admits and no other, and its closed
  // lists, each through the registered event alone. Every refused value passes the frame's value rule.
  it.each<[string, string, boolean]>([
    // N: a signed integer, at most ten digits; no sentinel
    ['user_version', '-2147483648', true],
    ['user_version', '2147483647', true],
    ['user_version', '0', true],
    ['user_version', '12345678901', false],
    ['user_version', '+1', false],
    ['user_version', '1e3', false],
    ['user_version', '--1', false],
    ['user_version', 'unknown', false],
    // V with `none` and `unreadable`
    ['writer', '0.1.66', true],
    ['writer', 'none', true],
    ['writer', 'unreadable', true],
    ['writer', 'absent', false],
    ['writer', 'unknown', false],
    ['writer', 'v0.1.66', false],
    // A: [0-9A-Za-z._-], 1 to 16 bytes; no sentinel of its own
    ['applied', 'interim', true],
    ['applied', 'a'.repeat(16), true],
    ['applied', 'a'.repeat(17), false],
    ['applied', 'p10+7', false],
    // I
    ['found', '999999', true],
    ['found', '-1', false],
    // the closed lists
    ['result', 'workspace_schema_unreadable', true],
    ['result', 'refused', false],
    ['result', 'workspace_exists', false],
    ['damage', 'not-a-database', true],
    ['damage', 'damaged', false],
    ['what', 'database', true],
    ['what', 'schema', false],
    // E and C
    ['err', 'SQLITE_1811', true],
    ['err', 'ebusy', false],
    ['syscall', 'rename', true],
    ['syscall', 'Rename', false]
  ])('unlock %s=%s admitted: %s', (key, value, admitted) => {
    const T = 't=2026-11-25T10:00:00Z'
    const fields: UpdateLogField[] = [[key, value]]
    expect(formatRegisteredLine('unlock', fields, { platform: 'win32', now: new Date(base.now) })).toBe(
      admitted ? `r1-app win32 unlock ${key}=${value} ${T}` : `r1-app win32 unlock ${T}`
    )
  })

  // The handler hands the formatter whatever the attempt threw; a value whose every property read throws still makes a
  // line (the result and the open's facts), never an exception into the unlock's answer.
  it('a thrown value whose every property read throws still gives each result its line', () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('no value for you')
        },
        has() {
          throw new Error('no value for you')
        },
        getPrototypeOf() {
          throw new Error('no value for you')
        }
      }
    )
    const open: OpenFacts = { userVersion: 1, lastWriter: null }
    for (const result of Object.keys(GOLDEN.fields.per_result)) {
      const line = lineOf({ result, open, thrown: hostile })
      expect(line, result).toMatch(new RegExp(`^r1-app win32 unlock result=${result}( |$)`))
    }
    expect(lineOf({ result: 'error', open, thrown: hostile })).toBe('r1-app win32 unlock result=error user_version=1 writer=none t=2026-11-25T10:00:00Z')
  })
})
