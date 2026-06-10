// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  LocalIndicator,
  localIndicatorLabel,
  localIndicatorDetail
} from '../../src/renderer/components/LocalIndicator'
import type { PolicyStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 27 ambient trust signal (guidelines §7): the quiet "Local · Offline" status,
// its honest downloads-allowed variant, the hover/focus reassurance tooltip, and the
// click-through to Settings → Privacy & data (the Phase-26 settings:privacy route).

afterEach(cleanup)

function policy(offlineMode: boolean): PolicyStatus {
  return {
    policy: {
      network: { allowModelDownloads: !offlineMode, allowUpdateChecks: false, allowTelemetry: false },
      workspace: { encryptionRequired: false, allowPlaintextDevMode: true },
      models: { allowUnverifiedModels: true, requireManifest: true, requireSha256Match: false }
    },
    policyFilePresent: false,
    driveFilePresent: false,
    allowNetworkSetting: !offlineMode,
    networkAllowedByPolicy: !offlineMode,
    networkAllowed: !offlineMode,
    offlineMode,
    telemetryAllowed: false
  } as PolicyStatus
}

describe('localIndicator copy (pure)', () => {
  it('is honest about both states', () => {
    expect(localIndicatorLabel(true)).toBe('Local · Offline')
    expect(localIndicatorDetail(true)).toBe(
      'Everything stays on this drive. No internet connection is used.'
    )
    expect(localIndicatorLabel(false)).toBe('Local · Downloads allowed')
    expect(localIndicatorDetail(false)).toBe('Downloads allowed — chats and documents stay local.')
  })
})

describe('LocalIndicator', () => {
  it('shows "Local · Offline" when offline (controlled, sidebar variant)', () => {
    stubApi({})
    render(<LocalIndicator variant="sidebar" offline onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Local · Offline' })).toBeInTheDocument()
  })

  it('shows the honest variant while downloads are enabled', () => {
    stubApi({})
    render(<LocalIndicator offline={false} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Local · Downloads allowed' })).toBeInTheDocument()
  })

  it('fetches the policy itself when uncontrolled (the chat-header placement)', async () => {
    stubApi({ getPolicy: vi.fn(async () => policy(false)) })
    render(<LocalIndicator onNavigate={vi.fn()} />)
    // Deny-by-default until the policy answers…
    expect(screen.getByRole('button', { name: 'Local · Offline' })).toBeInTheDocument()
    // …then the honest downloads-allowed state.
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Local · Downloads allowed' })).toBeInTheDocument()
    )
  })

  it('reveals the reassurance line on keyboard focus (tooltip)', async () => {
    stubApi({})
    render(<LocalIndicator offline onNavigate={vi.fn()} />)
    fireEvent.focus(screen.getByRole('button', { name: 'Local · Offline' }))
    const copies = await screen.findAllByText(
      'Everything stays on this drive. No internet connection is used.'
    )
    expect(copies.length).toBeGreaterThan(0)
  })

  it('opens Settings → Privacy & data on click (settings:privacy route survives)', async () => {
    const user = userEvent.setup()
    const onNavigate = vi.fn()
    stubApi({})
    render(<LocalIndicator offline onNavigate={onNavigate} />)
    await user.click(screen.getByRole('button', { name: 'Local · Offline' }))
    expect(onNavigate).toHaveBeenCalledWith('settings:privacy')
  })
})
