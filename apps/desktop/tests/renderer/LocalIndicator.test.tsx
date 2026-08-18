// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  LocalIndicator,
  localIndicatorLabel,
  localIndicatorShortLabel,
  localIndicatorDetail
} from '../../src/renderer/components/LocalIndicator'
import type { PolicyStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { makePolicyStatus } from '../helpers/status'

// Phase 27 ambient trust signal (guidelines §7): the quiet "Local · Offline" status,
// its honest downloads-allowed variant, the hover/focus reassurance tooltip, and the
// click-through to Settings → Privacy & data (the Phase-26 settings:privacy route).

afterEach(cleanup)

function policy(offlineMode: boolean): PolicyStatus {
  return makePolicyStatus({
    network: { allowModelDownloads: !offlineMode },
    allowNetworkSetting: !offlineMode,
    policyFilePresent: false,
    driveFilePresent: false
  })
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

  it('says so in BOTH label and tooltip while the local API is on (D1 — never pretend)', () => {
    // The network state is unchanged (a loopback endpoint is not an internet connection),
    // but "everything stays on this drive" would be the wrong reassurance: answers now
    // also go to another program on this machine.
    expect(localIndicatorLabel(true, undefined, true)).toBe('Local · Offline · API on')
    expect(localIndicatorShortLabel(true, undefined, true)).toBe('Offline · API on')
    expect(localIndicatorDetail(true, undefined, true)).toBe(
      'Other apps on this computer can use your model. Nothing leaves this computer.'
    )
    // Off ⇒ byte-identical to the pre-API copy.
    expect(localIndicatorDetail(true, undefined, false)).toBe(
      'Everything stays on this drive. No internet connection is used.'
    )
  })

  it('uses a short, rail-width label for the sidebar variant', () => {
    // The full "Local · …" form is too wide for the 100px rail (§12.1 #2): the rail shows
    // the effective state in one word, the tooltip carries the full reassurance.
    expect(localIndicatorShortLabel(true)).toBe('Offline')
    expect(localIndicatorShortLabel(false)).toBe('Downloads on')
  })
})

describe('LocalIndicator', () => {
  it('shows the short "Offline" label when offline (rail-foot sidebar variant)', () => {
    stubApi({})
    render(<LocalIndicator variant="sidebar" offline onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Offline' })).toBeInTheDocument()
  })

  it('shows the honest "Downloads on" label on the rail while downloads are enabled', () => {
    stubApi({})
    render(<LocalIndicator variant="sidebar" offline={false} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Downloads on' })).toBeInTheDocument()
  })

  it('shows the full label for the header variant while downloads are enabled', () => {
    stubApi({})
    render(<LocalIndicator offline={false} onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Local · Downloads allowed' })).toBeInTheDocument()
  })

  it('renders the API-on state on the rail', () => {
    stubApi({})
    render(<LocalIndicator variant="sidebar" offline localApiOn onNavigate={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'Offline · API on' })).toBeInTheDocument()
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
