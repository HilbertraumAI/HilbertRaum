import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  initLogging,
  log,
  readLogTail,
  usesPlaintextLog,
  attachVaultKey,
  detachVaultKey,
  rekeyVaultLog
} from '../../src/main/services/logging'
import { randomBytes } from 'node:crypto'
import { deserializeBlob, decrypt } from '../../src/main/services/security/crypto'

// L17 (audit-2026-06-13): logging.ts sits on every error path but had zero tests.
// Cover the two behaviours that matter when something is already going wrong: the
// ~1 MB rotation, and never throwing on un-serialisable (circular) meta.
//
// Encryption follow-up (2026-06-13): app.log is encrypted at rest on an encrypted
// workspace. Logging now starts in a `buffering` mode (no disk writes pre-unlock); the
// workspace resolves it to `plaintext` (plaintext_dev → plain app.log) or `encrypted`
// (vault unlock → app.log.enc). These tests cover all three.

describe('logging service (L17)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hilbertraum-log-'))
    // The console echo is just dev noise here; silence it so a passing run stays quiet.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  describe('plaintext_dev mode', () => {
    it('rotates app.log → app.1.log once it grows past MAX_BYTES', () => {
      initLogging(dir)
      usesPlaintextLog()
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
      usesPlaintextLog()
      log.info('small')
      log.warn('also small')
      expect(existsSync(join(dir, 'app.1.log'))).toBe(false)
      expect(readLogTail()).toHaveLength(2)
    })

    it('flushes pre-unlock buffered lines into the plain file', () => {
      initLogging(dir)
      // Buffered before the workspace resolves — nothing on disk yet.
      log.info('booting')
      expect(existsSync(join(dir, 'app.log'))).toBe(false)
      usesPlaintextLog()
      const tail = readLogTail()
      expect(tail).toHaveLength(1)
      expect(tail[0]).toContain('booting')
    })

    it('never throws on circular meta — falls back to String(v)', () => {
      initLogging(dir)
      usesPlaintextLog()
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
      initLogging(dir)
      usesPlaintextLog()
      expect(readLogTail()).toEqual([])

      for (let i = 0; i < 5; i++) log.info(`line ${i}`)
      const tail = readLogTail(3)
      expect(tail).toHaveLength(3)
      expect(tail[2]).toContain('line 4')
    })
  })

  describe('encrypted mode', () => {
    it('writes no plaintext app.log; persists an encrypted app.log.enc decryptable by the key', () => {
      const key = randomBytes(32)
      initLogging(dir)
      log.info('before unlock') // buffered in memory only
      expect(existsSync(join(dir, 'app.log'))).toBe(false)

      attachVaultKey(key)
      // attach flushes; an error also flushes immediately.
      log.error('something failed')

      const encPath = join(dir, 'app.log.enc')
      expect(existsSync(encPath)).toBe(true)
      // The plaintext file is NEVER written in encrypted mode.
      expect(existsSync(join(dir, 'app.log'))).toBe(false)

      // The on-disk bytes are ciphertext (the message must not appear in cleartext).
      const raw = readFileSync(encPath)
      expect(raw.includes(Buffer.from('something failed'))).toBe(false)

      // Decrypts back to the full log, including the pre-unlock buffered line.
      const text = decrypt(key, deserializeBlob(raw)).toString('utf8')
      expect(text).toContain('before unlock')
      expect(text).toContain('something failed')
    })

    it('readLogTail reads the in-memory buffer (not the encrypted file) while unlocked', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key)
      log.info('one')
      log.info('two')
      const tail = readLogTail()
      expect(tail).toHaveLength(2)
      expect(tail[1]).toContain('two')
    })

    it('a re-unlock continues the same log (folds prior history in)', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key)
      log.error('first session') // flushed to disk (error)
      detachVaultKey() // lock: final flush, drop key

      // Simulate a fresh process: re-init, then unlock again with the same key.
      initLogging(dir)
      attachVaultKey(key)
      log.error('second session')

      const text = decrypt(key, deserializeBlob(readFileSync(join(dir, 'app.log.enc')))).toString('utf8')
      expect(text).toContain('first session')
      expect(text).toContain('second session')
    })

    it('shreds a stale plaintext app.log left by an older build on first encrypted attach', () => {
      const key = randomBytes(32)
      initLogging(dir)
      // Simulate the pre-encryption build's leftover plaintext logs on an encrypted drive.
      writeFileSync(join(dir, 'app.log'), 'old plaintext diagnostics\n')
      writeFileSync(join(dir, 'app.1.log'), 'older rotated diagnostics\n')

      attachVaultKey(key)

      expect(existsSync(join(dir, 'app.log'))).toBe(false)
      expect(existsSync(join(dir, 'app.1.log'))).toBe(false)
    })

    it('rotates the encrypted log to app.1.log.enc once it grows past MAX_BYTES', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key)
      // One ~1.1 MB line tips the buffer past the 1 MB rotation threshold on the next write.
      log.info('x'.repeat(1_100_000))
      log.error('after rotation') // error flushes the post-rotation buffer to app.log.enc

      const rotated = join(dir, 'app.1.log.enc')
      expect(existsSync(rotated)).toBe(true)
      // The rotated generation decrypts to the big line; the live log holds the new one.
      const old = decrypt(key, deserializeBlob(readFileSync(rotated))).toString('utf8')
      expect(old).toContain('x'.repeat(1000))
      const live = decrypt(key, deserializeBlob(readFileSync(join(dir, 'app.log.enc')))).toString('utf8')
      expect(live).toContain('after rotation')
      expect(live).not.toContain('x'.repeat(1000))
    })

    it('detachVaultKey flushes buffered info lines that had not been persisted yet', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key) // flushes empty buffer
      log.info('quiet line') // info does NOT flush on its own
      detachVaultKey() // lock/quit flush

      const text = decrypt(key, deserializeBlob(readFileSync(join(dir, 'app.log.enc')))).toString('utf8')
      expect(text).toContain('quiet line')
    })

    it('rekeyVaultLog (v2 password change, key unchanged) re-seals without doubling history', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key)
      log.info('only once please')
      // v2 keeps the SAME data key — re-seal under it. Must NOT re-load from disk and
      // prepend the persisted history onto the in-memory buffer (that would double it).
      rekeyVaultLog(key)

      const text = decrypt(key, deserializeBlob(readFileSync(join(dir, 'app.log.enc')))).toString('utf8')
      const hits = text.split('only once please').length - 1
      expect(hits).toBe(1)
    })

    it('rekeyVaultLog (v1 password change, rotated key) preserves history under the new key', () => {
      const oldKey = randomBytes(32)
      const newKey = randomBytes(32)
      initLogging(dir)
      attachVaultKey(oldKey)
      log.info('history before change')
      // v1→v2 regenerates the data key; the log must carry across, re-sealed under newKey.
      rekeyVaultLog(newKey)

      const text = decrypt(newKey, deserializeBlob(readFileSync(join(dir, 'app.log.enc')))).toString('utf8')
      expect(text).toContain('history before change')
    })

    it('trims the buffer on a line boundary by UTF-8 byte length (multibyte content)', () => {
      const key = randomBytes(32)
      initLogging(dir)
      attachVaultKey(key)
      // Each line is multibyte ('ü' is 2 UTF-8 bytes). Push well past the 2 MB cap so the
      // oldest lines are dropped; the surviving buffer must start at a clean line boundary.
      const chunk = 'ü'.repeat(50_000) // ~100 KB per line
      for (let i = 0; i < 40; i++) log.info(`line ${i} ${chunk}`)
      const lines = readLogTail(1000)
      // No surviving line is a fragment: every one carries its 'line N' prefix.
      for (const l of lines) expect(l).toMatch(/\[INFO\] line \d+ /)
    })
  })
})
