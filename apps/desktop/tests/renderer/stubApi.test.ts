// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'

// TS-4 (full-audit 2026-07-10): the stubApi auto-stub must hand out ONE stable spy per
// accessed name. The old Proxy minted a fresh `vi.fn()` per property access, so an
// unmocked call rendered as success-with-`undefined` and a later lookup asserted against
// a spy that had never been called — a vacuous pass. These tests pin the fixed contract:
// stable identity, warn-once on unmocked calls, and the opt-in assert helper's teeth.

type AnyApi = Record<string, (...args: unknown[]) => unknown>
const api = (): AnyApi => (window as unknown as { api: AnyApi }).api

afterEach(() => {
  vi.restoreAllMocks()
})

describe('stubApi auto-stub (TS-4)', () => {
  it('returns the SAME spy on repeated lookups, so call assertions are no longer vacuous', () => {
    stubApi({})
    const first = api().getSettings
    expect(api().getSettings).toBe(first) // stable identity
    first('arg')
    // The repeat lookup sees the call — exactly what the fresh-per-access Proxy lost.
    expect(api().getSettings).toHaveBeenCalledWith('arg')
  })

  it('overrides pass through untouched and are not counted as unexpected', () => {
    const mine = vi.fn(async () => 'value')
    stubApi({ getSettings: mine } as never)
    expect(api().getSettings).toBe(mine)
    void api().getSettings()
    expect(mine).toHaveBeenCalledTimes(1)
    expect(() => assertNoUnexpectedApiCalls()).not.toThrow()
  })

  it('warns ONCE per unmocked name when it is called — lookups alone stay silent', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({})
    void api().listDocuments // lookup only — no warning
    expect(warn).not.toHaveBeenCalled()
    void api().listDocuments()
    void api().listDocuments()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('window.api.listDocuments')
    void api().deleteDocument()
    expect(warn).toHaveBeenCalledTimes(2) // a second NAME warns again, repeats don't
  })

  it('assertNoUnexpectedApiCalls throws with the offending names and counts', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({})
    void api().listDocuments()
    void api().listDocuments()
    expect(() => assertNoUnexpectedApiCalls()).toThrow(/listDocuments \(2 calls\)/)
  })

  it('a fresh stubApi() resets the unexpected-call record (per-test bookkeeping)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    stubApi({})
    void api().listDocuments()
    stubApi({})
    expect(() => assertNoUnexpectedApiCalls()).not.toThrow()
  })
})
