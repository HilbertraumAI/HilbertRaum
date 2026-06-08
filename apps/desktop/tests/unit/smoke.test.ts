import { describe, it, expect } from 'vitest'
import { DEFAULT_SETTINGS } from '../../src/shared/types'
import { IPC } from '../../src/shared/ipc'

// Phase 0 sanity: shared contracts import cleanly and have sane defaults.
describe('shared contracts', () => {
  it('defaults to offline / no network', () => {
    expect(DEFAULT_SETTINGS.allowNetwork).toBe(false)
  })

  it('exposes a stable IPC channel registry', () => {
    expect(IPC.getAppStatus).toBe('app:getAppStatus')
    expect(Object.values(IPC).every((v) => typeof v === 'string')).toBe(true)
  })
})
