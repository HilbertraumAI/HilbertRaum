// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { DEFAULT_SETTINGS, type AppSettings } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Step 4-5 (ruling (c), B1 — scoped Opus review of step 4-4): the `ragRerankWideScope` switch on
// Settings → General → Performance must render ONLY while the `cpu-hi` profile it controls is
// actually reachable (`Number.isFinite(CPU_HI_MIN_THREADS)`). Run L froze the constant at
// `Infinity` (a miss at both measured thread counts — `rerank-rules.ts`'s own doc comment), so in
// production today the switch must be ABSENT — showing it would tell the user something false
// about their machine (a setting exists here that does something). Both directions are pinned,
// per the brief: absent at the real (Infinity) constant, present — checked per the setting, and
// still wired to `onChange` — at a finite one.
//
// The constant lives in `shared/rerank-rules.ts` (not `rerank-profile.ts` itself) precisely so
// the renderer can import it without pulling `main/services/models.ts`'s `node:fs` et al. into
// the browser bundle (see that module's own doc comment) — this file mocks the SAME `@shared/
// rerank-rules` specifier `SettingsScreen.tsx` imports, via `vi.doMock` + a fresh dynamic
// import per test (module-level `vi.mock` would apply to every test in the file at once, but
// the "absent" case needs the REAL frozen value and the "present" case needs a finite one).

function settings(overrides: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...overrides }
}

afterEach(() => {
  cleanup()
  vi.doUnmock('@shared/rerank-rules')
  vi.resetModules()
})

describe('Settings → General — "Rerank more knowledge-pack passages" switch (step 4-5, ruling (c), B1)', () => {
  it('is ABSENT from the rendered performance card while CPU_HI_MIN_THREADS is Infinity (the real, frozen value)', async () => {
    vi.resetModules()
    const { SettingsScreen } = await import('../../src/renderer/screens/SettingsScreen')
    stubApi({
      getSettings: vi.fn(async () => settings()),
      updateSettings: vi.fn(async (p: Partial<AppSettings>) => settings(p))
    })
    render(<SettingsScreen />)
    // Wait for the card to finish its first settings load (a sibling control on the same card)
    // before asserting absence, so this cannot pass merely because nothing has rendered yet.
    await screen.findByLabelText(/use gpu acceleration/i)
    expect(screen.queryByRole('switch', { name: 'Rerank more knowledge-pack passages' })).not.toBeInTheDocument()
    expect(screen.queryByText(/rerank more knowledge-pack passages/i)).not.toBeInTheDocument()
  })

  it('is PRESENT, checked per the setting, and onChange still patches ragRerankWideScope, once CPU_HI_MIN_THREADS is finite', async () => {
    vi.resetModules()
    vi.doMock('@shared/rerank-rules', () => ({ CPU_HI_MIN_THREADS: 8 }))
    const { SettingsScreen } = await import('../../src/renderer/screens/SettingsScreen')
    const update = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    stubApi({
      getSettings: vi.fn(async () => settings({ ragRerankWideScope: true })),
      updateSettings: update
    })
    render(<SettingsScreen />)
    const toggle = (await screen.findByRole('switch', {
      name: 'Rerank more knowledge-pack passages'
    })) as HTMLInputElement
    expect(toggle.checked).toBe(true) // reflects the setting

    await userEvent.click(toggle)
    expect(update).toHaveBeenCalledWith({ ragRerankWideScope: false }) // onChange still wired

    // The setting key, its write gate and the switch itself are otherwise unchanged — a second
    // machine with the opt-in off renders it unchecked.
    cleanup()
    vi.resetModules()
    vi.doMock('@shared/rerank-rules', () => ({ CPU_HI_MIN_THREADS: 8 }))
    const { SettingsScreen: SettingsScreenAgain } = await import('../../src/renderer/screens/SettingsScreen')
    stubApi({
      getSettings: vi.fn(async () => settings({ ragRerankWideScope: false })),
      updateSettings: vi.fn(async (p: Partial<AppSettings>) => settings(p))
    })
    render(<SettingsScreenAgain />)
    const offToggle = (await screen.findByRole('switch', {
      name: 'Rerank more knowledge-pack passages'
    })) as HTMLInputElement
    expect(offToggle.checked).toBe(false)
  })
})
