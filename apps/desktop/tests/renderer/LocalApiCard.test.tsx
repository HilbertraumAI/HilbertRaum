// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { LocalApiCard } from '../../src/renderer/screens/settings/LocalApiCard'
import { I18nProvider } from '../../src/renderer/i18n'
import { localApiServerAddress } from '../../src/shared/local-api'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type LocalApiStatus,
  type PolicyStatus,
  type RuntimeStatus
} from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { appStatus, makePolicyStatus } from '../helpers/status'

// Local-API wave P4 — the Settings → Privacy card. This is the consent surface the whole
// feature rests on, so the pins here are about TRUTHFULNESS as much as behaviour: the
// policy ceiling disables the card with a reason instead of hiding it, nothing is written
// until the acknowledgement is ticked, the renderer never receives the full access key,
// the pasteable server address is exact and port-reactive, and the concurrent-use warning
// appears only while it is actually true.

function settings(over: Partial<AppSettings> = {}): AppSettings {
  return { ...DEFAULT_SETTINGS, ...over }
}

function apiStatus(over: Partial<LocalApiStatus> = {}): LocalApiStatus {
  return {
    running: true,
    port: 4980,
    tokenRequired: true,
    requestsServed: 0,
    rejectedCount: 0,
    lastError: null,
    externalActive: false,
    lastPreemptedAt: null,
    ...over
  }
}

function runtimeStatus(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    running: true,
    modelId: 'qwen3-4b-instruct-q4',
    port: 8080,
    healthy: true,
    message: 'ok',
    ...over
  }
}

interface StubOpts {
  policy?: PolicyStatus
  /** Render before the policy read resolves (`?? ` would swallow a null override). */
  policyPending?: boolean
  settings?: AppSettings
  localApi?: LocalApiStatus | null
  runtime?: RuntimeStatus
  maskedKey?: string | null
  port?: number
  updateSettings?: ReturnType<typeof vi.fn>
  copyLocalApiKey?: ReturnType<typeof vi.fn>
  regenerateLocalApiToken?: ReturnType<typeof vi.fn>
  copyToClipboard?: ReturnType<typeof vi.fn>
}

function renderCard(opts: StubOpts = {}): { current: AppSettings } {
  const current = opts.settings ?? settings()
  const port = opts.port ?? current.localApiPort
  stubApi({
    getAppStatus: vi.fn(async () =>
      appStatus({ localApi: opts.localApi === undefined ? apiStatus() : opts.localApi })
    ),
    getRuntimeStatus: vi.fn(async () => opts.runtime ?? runtimeStatus()),
    getLocalApiConnectionInfo: vi.fn(async () => ({
      serverAddress: localApiServerAddress(port),
      maskedKey: opts.maskedKey === undefined ? 'hr-…wxyz' : opts.maskedKey
    })),
    updateSettings: opts.updateSettings ?? vi.fn(async (p: Partial<AppSettings>) => ({ ...current, ...p })),
    copyToClipboard: opts.copyToClipboard ?? vi.fn(async () => true),
    copyLocalApiKey: opts.copyLocalApiKey ?? vi.fn(async () => true),
    regenerateLocalApiToken:
      opts.regenerateLocalApiToken ??
      vi.fn(async () => ({ serverAddress: localApiServerAddress(port), maskedKey: 'hr-…new1' }))
  })
  const state = { current }
  render(
    <I18nProvider>
      <LocalApiCard
        policy={opts.policyPending ? null : (opts.policy ?? makePolicyStatus())}
        settings={current}
        onSettingsChanged={(next) => {
          state.current = next
        }}
      />
    </I18nProvider>
  )
  return state
}

afterEach(cleanup)

describe('LocalApiCard — off + policy states', () => {
  it('is off by default: the switch is unchecked and no connect block is shown', () => {
    renderCard()
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.queryByText('Connect another app')).not.toBeInTheDocument()
  })

  it('under a policy that forbids it the card is shown DISABLED WITH A REASON, not hidden', () => {
    renderCard({
      policy: makePolicyStatus({ network: { allowLocalApi: false } }),
      // Even with the user setting on, the ceiling wins — and the card must say so.
      settings: settings({ localApiEnabled: true })
    })
    expect(screen.getByText('Local API')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.getByRole('switch')).not.toBeChecked()
    expect(screen.getByText("Turned off by your drive’s policy.")).toBeInTheDocument()
    // Policy off ∧ setting on ⇒ effectively off: no connection details anywhere.
    expect(screen.queryByText('Connect another app')).not.toBeInTheDocument()
  })

  it('says nothing about a drive policy while the policy read is still in flight', () => {
    // Deny-by-default is right for the CONTROL, but "Turned off by your drive's policy."
    // would be a false sentence on the many machines that have no such policy (review
    // 2026-08-18) — the card stays inert and silent until it knows.
    renderCard({ policyPending: true })
    expect(screen.getByRole('switch')).toBeDisabled()
    expect(screen.queryByText("Turned off by your drive’s policy.")).not.toBeInTheDocument()
  })
})

describe('LocalApiCard — the consent dialog', () => {
  it('writes NOTHING until the acknowledgement is ticked and the dialog confirmed', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    renderCard({ updateSettings })

    await user.click(screen.getByRole('switch'))
    expect(updateSettings).not.toHaveBeenCalled()

    const confirm = await screen.findByRole('button', { name: 'Turn on' })
    expect(confirm).toBeDisabled()

    await user.click(screen.getByLabelText('I understand what other apps will be able to do.'))
    expect(confirm).toBeEnabled()
    await user.click(confirm)
    expect(updateSettings).toHaveBeenCalledWith({ localApiEnabled: true })
  })

  it('names the three facts consent rests on: what apps can do, the boundary, and persistence', async () => {
    const user = userEvent.setup()
    renderCard()
    await user.click(screen.getByRole('switch'))
    expect(
      await screen.findByText(/send text to your AI model and read its answers/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/HilbertRaum can’t control what a connected program does/)
    ).toBeInTheDocument()
    expect(screen.getByText('This stays on until you turn it off.')).toBeInTheDocument()
    // The never-stored promise (privacy H-2) is part of the same decision.
    expect(screen.getByText(/answered and forgotten/)).toBeInTheDocument()
  })

  it('turning it OFF needs no confirmation', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    renderCard({ settings: settings({ localApiEnabled: true }), updateSettings })
    await user.click(screen.getByRole('switch', { name: /Allow other apps/ }))
    expect(updateSettings).toHaveBeenCalledWith({ localApiEnabled: false })
  })
})

describe('LocalApiCard — the connect block', () => {
  it('shows the exact pasteable server address, and it follows the port', async () => {
    renderCard({ settings: settings({ localApiEnabled: true }) })
    expect(await screen.findByText('http://127.0.0.1:4980/v1')).toBeInTheDocument()

    cleanup()
    renderCard({ settings: settings({ localApiEnabled: true, localApiPort: 4981 }) })
    expect(await screen.findByText('http://127.0.0.1:4981/v1')).toBeInTheDocument()
  })

  it('shows the access key MASKED and never receives the full value', async () => {
    const full = 'hr-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJ'
    renderCard({ settings: settings({ localApiEnabled: true }), maskedKey: 'hr-…IJKL' })
    expect(await screen.findByText('hr-…IJKL')).toBeInTheDocument()
    expect(document.body.textContent).not.toContain(full)
  })

  it('copies the key MAIN-side and warns that the clipboard may be synced', async () => {
    const user = userEvent.setup()
    const copyLocalApiKey = vi.fn(async () => true)
    renderCard({ settings: settings({ localApiEnabled: true }), copyLocalApiKey })
    await user.click(await screen.findByRole('button', { name: 'Copy the access key' }))
    expect(copyLocalApiKey).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/cleared automatically in a minute/)).toBeInTheDocument()
  })

  it('hides the key row and says why when the key requirement is off', async () => {
    renderCard({
      settings: settings({ localApiEnabled: true, localApiTokenRequired: false }),
      localApi: apiStatus({ tokenRequired: false })
    })
    expect(await screen.findByText('http://127.0.0.1:4980/v1')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Copy the access key' })).not.toBeInTheDocument()
    expect(
      screen.getByText('No access key is needed while the key requirement is off.')
    ).toBeInTheDocument()
  })
})

describe('LocalApiCard — live state', () => {
  it('says whether a model is actually running (the client-side 503 explained in advance)', async () => {
    renderCard({ settings: settings({ localApiEnabled: true }) })
    expect(
      await screen.findByText('A model is running — other apps can get answers.')
    ).toBeInTheDocument()

    cleanup()
    renderCard({
      settings: settings({ localApiEnabled: true }),
      runtime: runtimeStatus({ running: false, modelId: null })
    })
    expect(
      await screen.findByText(
        'No model is running — other apps will get an error until you start one.'
      )
    ).toBeInTheDocument()
  })

  it('the steady state is neutral — no warning banner while nothing is happening', async () => {
    renderCard({ settings: settings({ localApiEnabled: true }) })
    expect(await screen.findByText(/Listening on port 4980/)).toBeInTheDocument()
    expect(screen.queryByText(/An app is using your model right now/)).not.toBeInTheDocument()
  })

  it('warns at WARNING tone only while an external request is actually active (D5)', async () => {
    renderCard({
      settings: settings({ localApiEnabled: true }),
      localApi: apiStatus({ externalActive: true, requestsServed: 3 })
    })
    expect(await screen.findByText(/An app is using your model right now/)).toBeInTheDocument()
  })

  it('explains a pre-emption the user just caused, and forgets it once it is old', async () => {
    renderCard({
      settings: settings({ localApiEnabled: true }),
      localApi: apiStatus({ lastPreemptedAt: Date.now() - 1000 })
    })
    expect(await screen.findByText(/interrupted an app’s request a moment ago/)).toBeInTheDocument()

    cleanup()
    renderCard({
      settings: settings({ localApiEnabled: true }),
      // Older than the warning window: the collision is history, not a standing scold.
      localApi: apiStatus({ lastPreemptedAt: Date.now() - 10 * 60_000 })
    })
    expect(await screen.findByText(/Listening on port 4980/)).toBeInTheDocument()
    expect(screen.queryByText(/interrupted an app’s request/)).not.toBeInTheDocument()
  })

  it('a bind failure names the recovery AND the impersonation risk, and hides the connect block', async () => {
    renderCard({
      settings: settings({ localApiEnabled: true }),
      localApi: apiStatus({ running: false, port: null, lastError: 'port_in_use' })
    })
    const banner = await screen.findByText(/already using this number/)
    expect(banner.textContent).toContain('impersonating HilbertRaum')
    // The suggested alternative is the next port up from the configured one.
    expect(banner.textContent).toContain('4981')
    expect(screen.queryByText('Connect another app')).not.toBeInTheDocument()
  })
})

describe('LocalApiCard — key requirement + rotation', () => {
  it('turning the key requirement OFF is its own consent decision', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    renderCard({ settings: settings({ localApiEnabled: true }), updateSettings })
    await user.click(await screen.findByRole('switch', { name: 'Require an access key' }))
    expect(updateSettings).not.toHaveBeenCalled()
    expect(
      await screen.findByText(/any program on this computer can use your AI model without asking/)
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Turn it off' }))
    expect(updateSettings).toHaveBeenCalledWith({ localApiTokenRequired: false })
  })

  it('regenerating states the consequence, rotates main-side, and shows the new mask', async () => {
    const user = userEvent.setup()
    const regenerateLocalApiToken = vi.fn(async () => ({
      serverAddress: localApiServerAddress(4980),
      maskedKey: 'hr-…new1'
    }))
    renderCard({ settings: settings({ localApiEnabled: true }), regenerateLocalApiToken })
    await user.click(await screen.findByRole('button', { name: 'Create a new key' }))
    expect(
      await screen.findByText('Apps using the old key will stop working until you paste the new key into them.')
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Create new key' }))
    expect(regenerateLocalApiToken).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('hr-…new1')).toBeInTheDocument()
  })
})

describe('LocalApiCard — port', () => {
  it('suggests a port that is not the one that just failed, even at the top of the range', async () => {
    renderCard({
      settings: settings({ localApiEnabled: true, localApiPort: 65535 }),
      localApi: apiStatus({ running: false, port: null, lastError: 'port_in_use' })
    })
    const banner = await screen.findByText(/already using this number/)
    expect(banner.textContent).toContain('65534')
    expect(banner.textContent).not.toContain('65535')
  })


  it('refuses a port outside the shared clamp and applies a valid one', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (p: Partial<AppSettings>) => settings(p))
    renderCard({ settings: settings({ localApiEnabled: true }), updateSettings })

    const field = await screen.findByLabelText('Port number')
    const apply = screen.getByRole('button', { name: 'Apply' })
    // Unchanged value: nothing to apply.
    expect(apply).toBeDisabled()

    await user.clear(field)
    await user.type(field, '80')
    expect(apply).toBeDisabled()

    await user.clear(field)
    await user.type(field, '4981')
    expect(apply).toBeEnabled()
    await user.click(apply)
    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ localApiPort: 4981 }))
  })
})
