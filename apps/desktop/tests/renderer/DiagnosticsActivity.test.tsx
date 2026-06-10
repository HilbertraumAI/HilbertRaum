// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SettingsScreen } from '../../src/renderer/screens/SettingsScreen'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type AuditEvent, type RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase 19: the "Activity" panel over the audit log — on-demand load, the client-side
// type filter, the load-more cursor, and the export action. Friendly §11.4 copy; the
// panel itself states the local-only guarantee. Since Phase 26 it lives on
// Settings → "Diagnostics (advanced)".

const runtimeStatus: RuntimeStatus = {
  running: false,
  modelId: null,
  port: null,
  healthy: false,
  message: 'Stopped'
}

function event(n: number, type: AuditEvent['type'], message: string): AuditEvent {
  return {
    id: `ev-${n}`,
    type,
    message,
    metadata: null,
    createdAt: new Date(Date.UTC(2026, 5, 10, 12, 0, 0, n)).toISOString()
  }
}

function stubDiagnostics(overrides: Record<string, ReturnType<typeof vi.fn>>): void {
  stubApi({
    getAppStatus: vi.fn(async () => ({}) as never),
    getDriveStatus: vi.fn(async () => ({}) as never),
    getRuntimeStatus: vi.fn(async () => runtimeStatus),
    getRuntimeInstall: vi.fn(async () => null),
    getSettings: vi.fn(async () => DEFAULT_SETTINGS),
    ...overrides
  } as never)
}

afterEach(cleanup)

describe('Settings → Diagnostics (advanced) — Activity panel (Phase 19)', () => {
  it('loads activity on demand and filters by type', async () => {
    const events = [
      event(2, 'document_imported', 'Document imported: meeting-notes'),
      event(1, 'model_selected', 'Model selected: qwen3-4b')
    ]
    const getAuditEvents = vi.fn(async () => events)
    stubDiagnostics({ getAuditEvents })
    render(<SettingsScreen tab="diagnostics" />)

    // Friendly local-only copy is always visible on the card.
    expect(screen.getByText(/never contains chat text or document contents/i)).toBeInTheDocument()
    expect(getAuditEvents).not.toHaveBeenCalled() // on demand, not on mount

    await userEvent.click(screen.getByRole('button', { name: /show activity/i }))
    expect(await screen.findByText(/Document imported: meeting-notes/)).toBeInTheDocument()
    expect(screen.getByText(/Model selected: qwen3-4b/)).toBeInTheDocument()
    expect(getAuditEvents).toHaveBeenCalledWith(50)

    // The type filter narrows the list client-side.
    await userEvent.selectOptions(screen.getByRole('combobox'), 'model_selected')
    expect(screen.queryByText(/Document imported: meeting-notes/)).not.toBeInTheDocument()
    expect(screen.getByText(/Model selected: qwen3-4b/)).toBeInTheDocument()
  })

  it('shows a friendly empty state when nothing is recorded yet', async () => {
    stubDiagnostics({ getAuditEvents: vi.fn(async () => []) })
    render(<SettingsScreen tab="diagnostics" />)
    await userEvent.click(screen.getByRole('button', { name: /show activity/i }))
    expect(await screen.findByText(/Nothing recorded yet/i)).toBeInTheDocument()
  })

  it('loads earlier activity using the oldest loaded event as the cursor', async () => {
    // A full page (50) signals more may be available.
    const fullPage = Array.from({ length: 50 }, (_, i) =>
      event(100 - i, 'model_selected', `event ${100 - i}`)
    )
    const olderPage = [event(1, 'model_selected', 'the very first event')]
    const getAuditEvents = vi
      .fn()
      .mockResolvedValueOnce(fullPage)
      .mockResolvedValueOnce(olderPage)
    stubDiagnostics({ getAuditEvents })
    render(<SettingsScreen tab="diagnostics" />)

    await userEvent.click(screen.getByRole('button', { name: /show activity/i }))
    const more = await screen.findByRole('button', { name: /show earlier activity/i })
    await userEvent.click(more)

    await waitFor(() => expect(getAuditEvents).toHaveBeenCalledTimes(2))
    expect(getAuditEvents).toHaveBeenLastCalledWith(50, 'ev-51') // the oldest loaded id
    expect(await screen.findByText(/the very first event/)).toBeInTheDocument()
  })

  it('exports the log and confirms where it was saved (Phase 24: as a toast)', async () => {
    const exportAuditLog = vi.fn(async () => 'D:\\exports\\activity-log.json')
    stubDiagnostics({
      getAuditEvents: vi.fn(async () => [event(1, 'workspace_unlocked', 'Workspace unlocked')]),
      exportAuditLog
    })
    // The toast host lives in App.tsx; tests supply it via the provider.
    render(
      <ToastProvider>
        <SettingsScreen tab="diagnostics" />
      </ToastProvider>
    )

    await userEvent.click(screen.getByRole('button', { name: /show activity/i }))
    await userEvent.click(await screen.findByRole('button', { name: /export to file/i }))
    expect(exportAuditLog).toHaveBeenCalled()
    expect(
      await screen.findByText(/Activity log saved to D:\\exports\\activity-log\.json/)
    ).toBeInTheDocument()
  })
})
