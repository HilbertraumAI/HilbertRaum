// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PacksPanel } from '../../src/renderer/screens/documents/PacksPanel'
import { I18nProvider } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components'
import { t as tr } from '../../src/shared/i18n'
import type { EngineDownloadJob, EngineOptionalFamily, EngineStatus, PolicyStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'
import { makePolicyStatus } from '../helpers/status'
import { hangBudgetMs } from '../helpers/hang-budget'

// The Knowledge-packs panel's install action for the optional kiwix-tools family (#339 P8-2):
// the consent dialog's facts, the download gate, and a done or a failed install job.

/** #339 P8-2: a `kiwix_tools` `EngineOptionalFamily` fixture — the pinned facts the consent
 *  dialog states. `sizeBytes: 18301924` is the exact figure the dialog's Size row must round
 *  to "17 MB" (18301924 / 1024 / 1024 ≈ 17.45). */
function engineOptionalFamily(over: Partial<EngineOptionalFamily> = {}): EngineOptionalFamily {
  return {
    family: 'kiwix_tools',
    version: '3.8.1',
    sizeBytes: 18301924,
    url: 'https://download.kiwix.org/release/kiwix-tools/kiwix-tools_win-i686-3.8.1.zip',
    license: 'GPL-3.0-or-later',
    installed: false,
    ...over
  }
}

/** An `EngineStatus` naming `kiwix_tools` as missing-but-fetchable, everything else installed. */
function engineStatusWithMissingTools(over: Partial<EngineStatus> = {}): EngineStatus {
  return {
    installed: true,
    available: true,
    version: '1.0.0',
    backend: 'cpu',
    missingFamilies: [],
    missingOptionalFamilies: ['kiwix_tools'],
    optionalFamilies: [engineOptionalFamily()],
    ...over
  }
}

/** A `PolicyStatus` that allows downloads outright (the SAME shape ModelsScreen's own tests use). */
function allowedPolicy(): PolicyStatus {
  return makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: true })
}

afterEach(cleanup)

// Keep this order: the hook's job is module state (per file under pool: 'forks'); a failed job hides Install.
describe('PacksPanel — knowledge-pack tools install (#339 P8-2)', () => {
  // #339 P8-2 (the owner's ruling, 2026-09-06): the tools-missing notice's own install action —
  // the SAME consent dialog shape as a model download, stating facts from `EngineOptionalFamily`
  // (never from copy), confirming calls `downloadEngine({ families: ['kiwix_tools'] })`, and a
  // completed job toasts + refetches (`refresh()` directly, ahead of the `packs:changed` broadcast).
  it('#339 P8-2: the tools-missing notice offers an Install action; the consent dialog states the pinned facts and confirming installs, then a done job toasts and refetches', async () => {
    const user = userEvent.setup()
    let toolsInstalled = false
    const downloadEngine = vi.fn(
      async (): Promise<EngineDownloadJob> => ({
        jobId: 'k1',
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: 100,
        unverified: false,
        binaryPath: null,
        error: null
      })
    )
    let pollCount = 0
    const getEngineJob = vi.fn(async (): Promise<EngineDownloadJob> => {
      pollCount++
      return pollCount === 1
        ? {
            jobId: 'k1',
            status: 'downloading',
            receivedBytes: 50,
            totalBytes: 100,
            unverified: false,
            binaryPath: null,
            error: null
          }
        : {
            jobId: 'k1',
            status: 'done',
            receivedBytes: 100,
            totalBytes: 100,
            unverified: false,
            binaryPath: '/drive/runtime/kiwix-tools/kiwix-manage',
            error: null
          }
    })
    stubApi({
      getKnowledgePackStatus: vi.fn(async () => ({ toolsInstalled, refreshing: false, revision: 0 })),
      listKnowledgePacks: vi.fn(async () => []),
      getEngineStatus: vi.fn(async () => engineStatusWithMissingTools()),
      getPolicy: vi.fn(async () => allowedPolicy()),
      downloadEngine,
      getEngineJob
    })
    render(
      <I18nProvider>
        <ToastProvider>
          <PacksPanel />
        </ToastProvider>
      </I18nProvider>
    )
    expect(await screen.findByText(/kiwix-tools binaries are not installed/)).toBeInTheDocument()
    await user.click(await screen.findByRole('button', { name: 'Install the knowledge-pack tools…' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Install the knowledge-pack tools?')).toBeInTheDocument()

    // Size / License / From — every fact comes from the fixture's `EngineOptionalFamily`.
    expect(within(dialog).getByText('17 MB')).toBeInTheDocument()
    const licenseDt = within(dialog).getByText('License')
    expect(licenseDt.nextElementSibling?.textContent).toContain('GPL-3.0-or-later')
    const licenseLink = within(dialog).getByRole('link', { name: 'read the license' })
    expect(licenseLink).toHaveAttribute('href', 'https://www.gnu.org/licenses/gpl-3.0.html')
    expect(within(dialog).getByText('www.gnu.org')).toBeInTheDocument()
    const fromDt = within(dialog).getByText('From')
    expect(fromDt.nextElementSibling?.textContent).toContain('download.kiwix.org')

    const confirmBtn = within(dialog).getByRole('button', { name: 'Start download' })
    expect(confirmBtn).toBeDisabled()
    await user.click(within(dialog).getByRole('checkbox'))
    expect(confirmBtn).toBeEnabled()
    await user.click(confirmBtn)
    expect(downloadEngine).toHaveBeenCalledWith({ families: ['kiwix_tools'] })

    expect(
      await screen.findByText('Installing the knowledge-pack tools… 50 %', undefined, { timeout: hangBudgetMs(5_000) })
    ).toBeInTheDocument()
    toolsInstalled = true
    expect(
      await screen.findByText('Knowledge-pack tools installed', undefined, { timeout: hangBudgetMs(5_000) })
    ).toBeInTheDocument()
    // The refetch on `done`: the tools-missing notice goes without waiting for a packs:changed broadcast.
    await waitFor(() => expect(screen.queryByText(/kiwix-tools binaries are not installed/)).toBeNull())
  })

  // The two gate-off cases share the SAME copy ModelsScreen's own download gate uses
  // (`lib/downloadGate.ts`) — a policy denial and a Settings toggle off never diverge.
  it.each([
    [
      'the drive policy denies downloads',
      makePolicyStatus({ network: { allowModelDownloads: false }, allowNetworkSetting: true }),
      'models.downloads.blockedByPolicy'
    ],
    [
      'the Settings toggle is off',
      makePolicyStatus({ network: { allowModelDownloads: true }, allowNetworkSetting: false }),
      'models.downloads.enableInSettings'
    ]
  ] as const)(
    '#339 P8-2: the gate off (%s) disables the acknowledgement box and the confirm, and shows the same reason text as ModelsScreen',
    async (_label, policy, reasonKey) => {
      const user = userEvent.setup()
      stubApi({
        getKnowledgePackStatus: async () => ({ toolsInstalled: false, refreshing: false, revision: 0 }),
        listKnowledgePacks: async () => [],
        getEngineStatus: async () => engineStatusWithMissingTools(),
        getPolicy: async () => policy
      })
      render(
        <I18nProvider>
          <PacksPanel />
        </I18nProvider>
      )
      await user.click(await screen.findByRole('button', { name: 'Install the knowledge-pack tools…' }))
      const dialog = await screen.findByRole('dialog')
      const checkbox = within(dialog).getByRole('checkbox')
      expect(checkbox).toBeDisabled()
      await user.click(checkbox) // no-op: the box is disabled, ticking it must not change anything
      const confirmBtn = within(dialog).getByRole('button', { name: 'Start download' })
      expect(confirmBtn).toBeDisabled()
      expect(within(dialog).getByText(tr('en', reasonKey))).toBeInTheDocument()
    }
  )

  it('#339 P8-2: a failed install shows the error and Try again', async () => {
    const user = userEvent.setup()
    const downloadEngine = vi.fn(
      async (): Promise<EngineDownloadJob> => ({
        jobId: 'kf',
        status: 'downloading',
        receivedBytes: 0,
        totalBytes: 100,
        unverified: false,
        binaryPath: null,
        error: null
      })
    )
    const getEngineJob = vi.fn(
      async (): Promise<EngineDownloadJob> => ({
        jobId: 'kf',
        status: 'failed',
        receivedBytes: 0,
        totalBytes: 100,
        unverified: false,
        binaryPath: null,
        error: 'kiwix-tools archive checksum mismatch'
      })
    )
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: false, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [],
      getEngineStatus: async () => engineStatusWithMissingTools(),
      getPolicy: async () => allowedPolicy(),
      downloadEngine,
      getEngineJob
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Install the knowledge-pack tools…' }))
    const dialog = await screen.findByRole('dialog')
    await user.click(within(dialog).getByRole('checkbox'))
    await user.click(within(dialog).getByRole('button', { name: 'Start download' }))
    expect(
      await screen.findByText('Installing the knowledge-pack tools failed.', undefined, { timeout: hangBudgetMs(5_000) })
    ).toBeInTheDocument()
    expect(screen.getByText('kiwix-tools archive checksum mismatch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })
})
