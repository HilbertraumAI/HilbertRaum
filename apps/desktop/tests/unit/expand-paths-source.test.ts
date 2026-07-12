import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { expandPathsWithSource } from '../../src/main/services/ingestion'

// full-audit 2026-07-12 CODE-1 — `source_relative_path` is persisted DISPLAY metadata (never
// parsed back into a host path), so it must be separator-normalized like every other persisted
// key (`driveRelKey`, `markerBinaryKey`): a Windows-populated workspace opened on macOS/Linux
// must not show `sub\folder\file.pdf` breadcrumbs.

describe('expandPathsWithSource — separator normalization (full-audit 2026-07-12 CODE-1)', () => {
  it('sourceRelativePath uses forward slashes regardless of the host separator', () => {
    const root = mkdtempSync(join(tmpdir(), 'hilbertraum-expand-src-'))
    const sub = join(root, 'sub')
    mkdirSync(sub)
    writeFileSync(join(sub, 'nested.txt'), 'x')
    writeFileSync(join(root, 'top.txt'), 'x')

    const files = expandPathsWithSource([root])
    const nested = files.find((f) => f.path.endsWith('nested.txt'))
    // Red on Windows pre-fix: `relative()` returned `sub\nested.txt` and was persisted as-is.
    expect(nested?.sourceRelativePath).toBe('sub/nested.txt')
    expect(nested?.sourceRelativePath).not.toContain('\\')
    expect(nested?.sourceFolderLabel).toBe(basename(root))

    // A root-level file stays a bare name; the label attribution is unchanged.
    const top = files.find((f) => f.path.endsWith('top.txt'))
    expect(top?.sourceRelativePath).toBe('top.txt')
    expect(top?.sourceFolderLabel).toBe(basename(root))
  })
})
