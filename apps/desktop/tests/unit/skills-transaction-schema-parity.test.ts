import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TRANSACTION_ROW_SCHEMA } from '../../src/main/services/skills/tools/bank-statement'
import type { JsonSchema } from '../../src/shared/types'

// SK-6 (skills-audit-2026-07-07): the packaged `schemas/transaction.schema.json` ships inside every
// bank-statement skill export and is the only machine-readable row contract a recipient sees. Its live
// source of truth is `TRANSACTION_ROW_SCHEMA` in `tools/bank-statement.ts` (what `extract_transactions`
// actually validates against). Nothing loaded the JSON, so the two could silently drift. This test pins
// the packaged JSON structurally to the TS export — STRUCTURE, not prose: property-name set, per-property
// `type`/`pattern`/`minimum`/`minLength`, `required`, and `additionalProperties`. Descriptions may differ.
//
// Path resolved from the repo root via `resolve(__dirname, ...)` — POSIX/Win32-safe, no hardcoded absolute
// path (CLAUDE.md hard rule). __dirname = apps/desktop/tests/unit → ../../../../ = repo root.
const ROOT = resolve(__dirname, '../../../..')
const JSON_PATH = resolve(ROOT, 'app-skills/bank-statement/schemas/transaction.schema.json')

const packaged = JSON.parse(readFileSync(JSON_PATH, 'utf8')) as JsonSchema & {
  $schema?: string
  $id?: string
  title?: string
}

/** The validation keywords we pin (everything a validator enforces); `description`/`$id`/`title` are prose. */
const CONSTRAINT_KEYS = ['type', 'pattern', 'minimum', 'maximum', 'minLength', 'maxLength'] as const

/** Project a property schema down to just its enforced constraints, so prose differences don't matter. */
function constraintsOf(schema: JsonSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const key of CONSTRAINT_KEYS) {
    const value = (schema as Record<string, unknown>)[key]
    if (value !== undefined) out[key] = value
  }
  return out
}

describe('bank-statement transaction.schema.json ↔ TRANSACTION_ROW_SCHEMA parity', () => {
  const tsProps = TRANSACTION_ROW_SCHEMA.properties ?? {}
  const jsonProps = packaged.properties ?? {}

  it('object-level shape matches (type, additionalProperties, required set)', () => {
    expect(packaged.type).toBe(TRANSACTION_ROW_SCHEMA.type)
    expect(packaged.additionalProperties).toBe(TRANSACTION_ROW_SCHEMA.additionalProperties)
    expect([...(packaged.required ?? [])].sort()).toEqual([...(TRANSACTION_ROW_SCHEMA.required ?? [])].sort())
  })

  it('property-name sets are identical', () => {
    expect(Object.keys(jsonProps).sort()).toEqual(Object.keys(tsProps).sort())
  })

  it('every property enforces the same constraints (type/pattern/minimum/minLength/…)', () => {
    for (const name of Object.keys(tsProps)) {
      expect(constraintsOf(jsonProps[name] ?? {}), `property "${name}" drifted`).toEqual(
        constraintsOf(tsProps[name])
      )
    }
  })

  // Intentional-delta ledger (encode by name so an UNEXPLAINED new difference still fails above).
  // There is currently NO structural delta — the two schemas are field-for-field identical. `category`
  // is the one field worth a named note: it is present in BOTH schemas as an optional `string`/minLength 1,
  // even though `extract_transactions` never emits it — it is a persisted label a categorize run attaches
  // and that then rides the row through the downstream tools/export (D61). If a future change makes it
  // file-only (drop it from the TS schema) or input-only in a new way, update this ledger deliberately.
  it('category is present in both schemas as an optional string label (input/persist-only, never extracted)', () => {
    expect(TRANSACTION_ROW_SCHEMA.required ?? []).not.toContain('category')
    expect(packaged.required ?? []).not.toContain('category')
    expect(tsProps.category).toEqual({ type: 'string', minLength: 1 })
    expect(constraintsOf(jsonProps.category ?? {})).toEqual({ type: 'string', minLength: 1 })
  })
})
