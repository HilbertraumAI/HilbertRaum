import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

// Source-hygiene guard for the ONE in-scope-documents query (audit §4.6 / X-1). Before R4 two private
// copies of the "indexed, answerable documents in a resolved scope" projection lived beside the shared
// helper (`registerRagIpc.ts` documentsInScope, `analysis/redaction.ts` inScopeDocuments) — one with NO
// ORDER BY, which is what let the what-changed compare pair arrive in undefined SQL row order and be
// asserted to the model as an exact old→new direction (audit §5.1). R4 deleted both. This test fails if
// a future private copy is re-introduced, so drift stays impossible.
//
// The projection is fingerprinted by ALL THREE of: the id projection `d.id AS id`, `FROM documents d`,
// and `status = 'indexed'`. The plan (§R4) names the `FROM documents d` + `status = 'indexed'` pair,
// but that pair alone also appears in legitimately-separate queries this phase does NOT touch — the
// Library-seed backfill (db.ts), the reindex-needed COUNT (rag/index.ts), and the fully-chunked COUNT
// (registerRagIpc.ts). Those are COUNT(*)/`SELECT d.id,` queries, never the `d.id AS id` PROJECTION, so
// requiring `d.id AS id` too pins exactly the duplicated query without false-flagging them.

const MAIN_SRC = join(__dirname, '..', '..', 'src', 'main')
const CANONICAL = join('services', 'skills', 'scope-documents.ts')

function tsFilesUnder(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...tsFilesUnder(full))
    else if (entry.isFile() && entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

/** A file's source carries the in-scope-documents PROJECTION query (not a COUNT/seed of the same table). */
function hasInScopeProjection(source: string): boolean {
  return (
    source.includes('d.id AS id') &&
    source.includes('FROM documents d') &&
    source.includes("status = 'indexed'")
  )
}

describe('scope-documents single source (audit §4.6 / §5.1)', () => {
  const files = tsFilesUnder(MAIN_SRC)

  it('finds source files to scan (guards against a broken walker)', () => {
    expect(files.length).toBeGreaterThan(50)
  })

  it('the in-scope-documents projection query lives ONLY in scope-documents.ts', () => {
    const offenders = files
      .filter((f) => hasInScopeProjection(readFileSync(f, 'utf8')))
      .map((f) => relative(MAIN_SRC, f).split(sep).join('/'))
    expect(offenders).toEqual([CANONICAL.split(sep).join('/')])
  })

  it('the canonical helper still carries the fingerprint (the guard is not a silent no-op)', () => {
    const canonical = readFileSync(join(MAIN_SRC, CANONICAL), 'utf8')
    expect(hasInScopeProjection(canonical)).toBe(true)
  })
})
