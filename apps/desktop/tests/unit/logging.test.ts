import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initLogging, log, readLogTail } from '../../src/main/services/logging'

// L17 (audit-2026-06-13): logging.ts sits on every error path but had zero tests.
// Cover the two behaviours that matter when something is already going wrong: the
// ~1 MB rotation, and never throwing on un-serialisable (circular) meta.

describe('logging service (L17)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'paid-log-'))
    // The console echo is just dev noise here; silence it so a passing run stays quiet.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  it('rotates app.log → app.1.log once it grows past MAX_BYTES', () => {
    initLogging(dir)
    const logFile = join(dir, 'app.log')
    const rotated = join(dir, 'app.1.log')

    // Pre-seed the live log just over the ~1 MB rotation threshold. The next write
    // must rename the oversized file aside and start a fresh app.log.
    writeFileSync(logFile, 'x'.repeat(1_000_001))
    expect(existsSync(rotated)).toBe(false)

    log.info('first line after the file is oversized')

    expect(existsSync(rotated)).toBe(true)
    // The rotated copy keeps the old bytes; the fresh app.log holds only the new line.
    expect(statSync(rotated).size).toBe(1_000_001)
    const fresh = readFileSync(logFile, 'utf8')
    expect(fresh).toContain('first line after the file is oversized')
    expect(fresh.length).toBeLessThan(1_000)
  })

  it('does not rotate while the log is under MAX_BYTES', () => {
    initLogging(dir)
    log.info('small')
    log.warn('also small')
    expect(existsSync(join(dir, 'app.1.log'))).toBe(false)
    expect(readLogTail()).toHaveLength(2)
  })

  it('never throws on circular meta — falls back to String(v)', () => {
    initLogging(dir)
    const circular: Record<string, unknown> = { a: 1 }
    circular.self = circular // JSON.stringify would throw on this

    expect(() => log.error('boom', circular)).not.toThrow()

    const tail = readLogTail()
    expect(tail).toHaveLength(1)
    expect(tail[0]).toContain('[ERROR] boom')
    // safeJson swallowed the TypeError and wrote the String() form instead of crashing.
    expect(tail[0]).toContain('[object Object]')
  })

  it('readLogTail returns the last N lines and survives a missing file', () => {
    // Point logging at a fresh dir whose app.log does not exist yet → empty, not a throw.
    initLogging(dir)
    expect(readLogTail()).toEqual([])

    for (let i = 0; i < 5; i++) log.info(`line ${i}`)
    const tail = readLogTail(3)
    expect(tail).toHaveLength(3)
    expect(tail[2]).toContain('line 4')
  })
})
