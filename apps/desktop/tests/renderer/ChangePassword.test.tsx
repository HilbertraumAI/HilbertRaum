// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type WorkspaceActionResult
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 32: the Settings → General "Change password" card. Reuses the Phase-27
// password components (strength meter, show toggle) from components/PasswordField;
// hidden entirely in plaintext_dev mode (nothing to change). The card mirrors the
// WorkspaceGate gating rules: 8-character floor + confirm match, advisory-only meter.

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, workspaceMode: 'encrypted', ...over }
}

function stubSettings(opts: {
  settings?: AppSettings
  changeWorkspacePassword?: ReturnType<typeof vi.fn>
}): ReturnType<typeof vi.fn> {
  const change =
    opts.changeWorkspacePassword ??
    vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: true,
        state: {
          state: 'unlocked',
          mode: 'encrypted',
          plaintextAllowed: false,
          encryptionRequired: true
        }
      })
    )
  stubApi({
    getSettings: vi.fn(async () => opts.settings ?? settings()),
    updateSettings: vi.fn(async (p: Partial<AppSettings>) => settings(p)) as never,
    changeWorkspacePassword: change as never
  })
  return change
}

async function fillCard(
  user: ReturnType<typeof userEvent.setup>,
  current: string,
  next: string,
  confirm: string
): Promise<void> {
  await user.type(screen.getByLabelText('Current password'), current)
  await user.type(screen.getByLabelText('New password'), next)
  await user.type(screen.getByLabelText('Confirm new password'), confirm)
}

afterEach(cleanup)

describe('Settings → Change password (Phase 32)', () => {
  it('shows the card on an encrypted workspace with the three password fields', async () => {
    stubSettings({})
    render(<SettingsScreen tab="general" />)
    expect(await screen.findByRole('heading', { name: /change password/i })).toBeInTheDocument()
    expect(screen.getByLabelText('Current password')).toBeInTheDocument()
    expect(screen.getByLabelText('New password')).toBeInTheDocument()
    expect(screen.getByLabelText('Confirm new password')).toBeInTheDocument()
  })

  it('is hidden ENTIRELY in plaintext_dev mode (nothing to change)', async () => {
    stubSettings({ settings: settings({ workspaceMode: 'plaintext_dev' }) })
    render(<SettingsScreen tab="general" />)
    await screen.findByText(/plaintext developer workspace/i)
    expect(screen.queryByRole('heading', { name: /change password/i })).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument()
  })

  it('gates submission on the 8-char floor + confirm match, then calls the IPC', async () => {
    const change = stubSettings({})
    const user = userEvent.setup()
    render(<SettingsScreen tab="general" />)
    const button = await screen.findByRole('button', { name: /change password/i })
    expect(button).toBeDisabled()

    // Short new password → still disabled; mismatch → still disabled.
    await fillCard(user, 'old-password', 'short', 'short')
    expect(button).toBeDisabled()
    await user.clear(screen.getByLabelText('New password'))
    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('New password'), 'long-enough-pw')
    await user.type(screen.getByLabelText('Confirm new password'), 'long-enough-XX')
    expect(screen.getByText(/don't match/i)).toBeInTheDocument()
    expect(button).toBeDisabled()

    // Fix the confirm → submit calls the preload mirror with (current, next).
    await user.clear(screen.getByLabelText('Confirm new password'))
    await user.type(screen.getByLabelText('Confirm new password'), 'long-enough-pw')
    expect(button).toBeEnabled()
    await user.click(button)
    expect(change).toHaveBeenCalledWith('old-password', 'long-enough-pw')

    // Success clears every field (no passwords linger in the DOM).
    await waitFor(() =>
      expect((screen.getByLabelText('Current password') as HTMLInputElement).value).toBe('')
    )
    expect((screen.getByLabelText('New password') as HTMLInputElement).value).toBe('')
    expect((screen.getByLabelText('Confirm new password') as HTMLInputElement).value).toBe('')
  })

  it('shows the strength meter on the new password (advisory only)', async () => {
    stubSettings({})
    const user = userEvent.setup()
    render(<SettingsScreen tab="general" />)
    await screen.findByRole('heading', { name: /change password/i })
    await user.type(screen.getByLabelText('New password'), 'C0rrect-horse-battery!')
    expect(screen.getByText('Very strong')).toBeInTheDocument()
  })

  it('surfaces a wrong-current-password failure as the friendly message, keeping the fields', async () => {
    const change = vi.fn(
      async (): Promise<WorkspaceActionResult> => ({
        ok: false,
        reason: 'wrong_password',
        message: "That doesn't match your current password. Check it and try again."
      })
    )
    stubSettings({ changeWorkspacePassword: change })
    const user = userEvent.setup()
    render(<SettingsScreen tab="general" />)
    await screen.findByRole('heading', { name: /change password/i })
    await fillCard(user, 'wrong-current', 'long-enough-pw', 'long-enough-pw')
    await user.click(screen.getByRole('button', { name: /change password/i }))
    expect(
      await screen.findByText(/doesn't match your current password/i)
    ).toBeInTheDocument()
  })
})
