import { describe, it, expect } from 'vitest'
import { friendlyIpcError } from '../../src/renderer/lib/errors'

// friendlyIpcError strips Electron's IPC transport wrapper AND any leading Error-class
// name so the user sees only the (already-friendly) message — never "ChatRequestError: …".

describe('friendlyIpcError', () => {
  it('strips the Electron remote-method wrapper and a plain "Error:" prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'askDocuments': Error: This is too large for the current model's context window."
    )
    expect(friendlyIpcError(wrapped)).toBe(
      "This is too large for the current model's context window."
    )
  })

  it('strips a custom Error SUBCLASS name (the leaked "ChatRequestError:" prefix)', () => {
    const wrapped = new Error(
      "Error invoking remote method 'askDocuments': ChatRequestError: Chat request failed: HTTP 400 — request (9600 tokens) exceeds the available context size (8192 tokens)"
    )
    expect(friendlyIpcError(wrapped)).toBe(
      'Chat request failed: HTTP 400 — request (9600 tokens) exceeds the available context size (8192 tokens)'
    )
  })

  it('passes an already-clean friendly message through unchanged', () => {
    expect(friendlyIpcError(new Error('No AI model is running.'))).toBe('No AI model is running.')
  })

  it('handles a non-Error value', () => {
    expect(friendlyIpcError('plain string')).toBe('plain string')
  })
})
