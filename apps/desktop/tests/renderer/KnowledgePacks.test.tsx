// @vitest-environment jsdom
import { describe, it, expect, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { PacksPanel } from '../../src/renderer/screens/documents/PacksPanel'
import { ArticleModal, type ArticleTarget } from '../../src/renderer/chat/ArticleModal'
import { PackOutcomesNotice } from '../../src/renderer/chat/PackOutcomesNotice'
import { ScopePopover } from '../../src/renderer/chat/ScopePopover'
import { SourcesDisclosure } from '../../src/renderer/chat/SourcesDisclosure'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components'
import { __resetKnowledgePackToolsInstallForTests } from '../../src/renderer/lib/useKnowledgePackToolsInstall'
import { t as tr, tCount as trCount, type UiLanguage } from '../../src/shared/i18n'
import type {
  Citation,
  Collection,
  Conversation,
  DocumentInfo,
  DocumentScope,
  EngineDownloadJob,
  EngineOptionalFamily,
  EngineStatus,
  KnowledgePack,
  KnowledgePackOutcome,
  KnowledgePackOutcomeReason,
  KnowledgePacksChangedEvent,
  PolicyStatus,
  RuntimeStatus
} from '../../src/shared/types'
import { MAX_SELECTED_PACKS } from '../../src/shared/types'
import { stubApi, assertNoUnexpectedApiCalls } from '../helpers/renderer'
import { makePolicyStatus } from '../helpers/status'

// Knowledge packs (ZIM wave) renderer surfaces: the PacksPanel management list, the
// ScopePopover pack sources (incl. packIds preservation on unrelated toggles), and the
// offline ArticleModal's honest states.

/** A controllable `onKnowledgePacksChanged` stand-in (#301 P3b, finding L7): the test holds
 *  `emit` and calls it whenever the "main process" would broadcast the event. */
function packsEventEmitter(): {
  onKnowledgePacksChanged: (cb: (event: KnowledgePacksChangedEvent) => void) => () => void
  emit: (event: KnowledgePacksChangedEvent) => void
} {
  let cb: ((event: KnowledgePacksChangedEvent) => void) | null = null
  return {
    onKnowledgePacksChanged: (fn) => {
      cb = fn
      return () => {
        cb = null
      }
    },
    emit: (event) => cb?.(event)
  }
}

function pack(over: Partial<KnowledgePack> = {}): KnowledgePack {
  return {
    id: 'uuid-climate',
    title: 'Klimawandel von Wikipedia',
    description: 'Offline-Auszug',
    language: 'deu',
    zimDate: '2026-07-01',
    articleCount: 4102,
    sizeBytes: 27 * 1024 * 1024,
    leaf: 'wikipedia_de_climate.zim',
    enabled: true,
    available: true,
    // #301 P3b (M5): additive and NON-optional on `KnowledgePack` — null whenever the pack is
    // available; 'missing' / 'identity-mismatch' say WHY it is not. P6 owns the badge copy.
    unavailableReason: null,
    addedAt: '2026-09-01T00:00:00Z',
    ...over
  }
}

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

beforeAll(() => {
  // T18-a leg (f) mounts the real ChatScreen, whose transcript scrolls on mount.
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

beforeEach(() => {
  // #339 P8-2: the tools-install hook's remembered job is MODULE state (like ModelsScreen's own
  // rememberedEngineJob) so it survives a remount mid-install — tests must start from a known
  // (no job) state instead of inheriting whatever the previous case left behind.
  __resetKnowledgePackToolsInstallForTests()
})

afterEach(() => {
  cleanup()
  window.localStorage.clear()
})

describe('PacksPanel', () => {
  it('lists packs with state badges and meta; missing file shows the honest badge', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack(),
        pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false, enabled: true })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByText('File missing')).toBeInTheDocument()
    expect(screen.getAllByText(/4102 articles/).length).toBeGreaterThan(0)
    // #340 nit: the ISO 639-3 code is shown as a language NAME in the UI language, never raw.
    expect(screen.getAllByText(/German · 4102 articles/).length).toBe(2)
    expect(screen.queryByText(/\bdeu\b/)).toBeNull()
    // #340 nit: an unavailable pack can be disabled, not only removed.
    expect(screen.getByRole('button', { name: 'Disable Chemie von Wikipedia' })).toBeEnabled()
  })

  // #340 nits: a row's buttons disable only while THAT row is busy — another row's toggle or
  // remove is an independent operation — and the meta line's language name follows the UI
  // language, with the raw code kept only when the platform cannot name it.
  it('#340 nits: only the busy row disables, an unavailable pack can be disabled, the language is named in German too and an unknown code stays raw', async () => {
    let release!: () => void
    const parked = new Promise<void>((r) => (release = r))
    const setKnowledgePackEnabled = vi.fn(async () => {
      await parked
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack(),
        pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false, enabled: true, language: 'zzz' })
      ],
      setKnowledgePackEnabled
    })
    const user = userEvent.setup()
    const first = render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    // The unknown code echoes back as itself — no invented name.
    expect(screen.getByText(/^zzz · 4102 articles/)).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'Disable Klimawandel von Wikipedia' }))
    await waitFor(() => expect(setKnowledgePackEnabled).toHaveBeenCalledWith('uuid-climate', false))
    // This row is working; the other row's buttons are untouched.
    expect(screen.getByRole('button', { name: 'Disable Klimawandel von Wikipedia' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Remove Klimawandel von Wikipedia' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Disable Chemie von Wikipedia' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Remove Chemie von Wikipedia' })).toBeEnabled()
    release()
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Disable Klimawandel von Wikipedia' })).toBeEnabled()
    )
    // …and the unavailable pack's Disable really reaches the bridge.
    await user.click(screen.getByRole('button', { name: 'Disable Chemie von Wikipedia' }))
    await waitFor(() => expect(setKnowledgePackEnabled).toHaveBeenCalledWith('uuid-gone', false))
    first.unmount()

    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(screen.getByText(/^Deutsch · 4102 Artikel/)).toBeInTheDocument()
  })

  // #340 (rag-design D-Z16): the served library's collision losers ride `packs:status.excluded`
  // — a served-library fact, so it is a badge + a visible reason line on the LOSER's row that
  // names the winner, never a row field; a status without the field (an older main) or with
  // `null` (nothing computed yet) shows nothing.
  it('a serving-name collision loser gets a "Not served" badge naming the winner; null / absent status shows none', async () => {
    const winner = pack({ id: 'uuid-aaaa', title: 'Klimawandel von Wikipedia' })
    const loser = pack({ id: 'uuid-bbbb', title: 'Klimawandel (Kopie)', leaf: 'wikipedia_de_climate.zim' })
    stubApi({
      getKnowledgePackStatus: async () => ({
        toolsInstalled: true,
        refreshing: false,
        revision: 0,
        excluded: [{ packId: 'uuid-bbbb', collidesWith: 'uuid-aaaa' }]
      }),
      listKnowledgePacks: async () => [winner, loser]
    })
    const { unmount } = render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel (Kopie)')).toBeInTheDocument()
    // The loser's row: the badge and the visible line naming the winner (guidelines §7 — the
    // reason is reachable without a mouse). The winner's row carries neither.
    expect(screen.getByText('Not served')).toBeInTheDocument()
    expect(
      screen.getByText(/clashes with “Klimawandel von Wikipedia”, so only that pack is served/)
    ).toBeInTheDocument()
    const loserCard = screen.getByText('Klimawandel (Kopie)').closest('li')
    const winnerCard = screen.getByText('Klimawandel von Wikipedia').closest('li')
    expect(loserCard).not.toBeNull()
    expect(loserCard!.textContent).toContain('Not served')
    expect(winnerCard!.textContent).not.toContain('Not served')
    // Both stay Enabled: a collision is not a row state.
    expect(screen.getAllByText('Enabled')).toHaveLength(2)
    unmount()

    // A winner the list no longer knows (a stale list): the generic line, still a badge.
    stubApi({
      getKnowledgePackStatus: async () => ({
        toolsInstalled: true,
        refreshing: false,
        revision: 0,
        excluded: [{ packId: 'uuid-bbbb', collidesWith: 'uuid-gone' }]
      }),
      listKnowledgePacks: async () => [loser]
    })
    const second = render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Not served')).toBeInTheDocument()
    expect(screen.getByText(/clashes with another pack’s/)).toBeInTheDocument()
    second.unmount()

    // `null` (nothing computed yet) and an ABSENT field (an older main): no badge at all.
    for (const status of [
      { toolsInstalled: true, refreshing: false, revision: 0, excluded: null },
      { toolsInstalled: true, refreshing: false, revision: 0 }
    ]) {
      stubApi({
        getKnowledgePackStatus: async () => status,
        listKnowledgePacks: async () => [winner, loser]
      })
      const r = render(
        <I18nProvider>
          <PacksPanel />
        </I18nProvider>
      )
      expect(await screen.findByText('Klimawandel (Kopie)')).toBeInTheDocument()
      expect(screen.queryByText('Not served')).toBeNull()
      r.unmount()
    }
  })

  it('shows the tools-missing hint and disables adding when kiwix-tools is absent', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: false, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => []
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText(/kiwix-tools binaries are not installed/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add packs…' })).toBeDisabled()
  })

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
      await screen.findByText('Installing the knowledge-pack tools… 50 %', undefined, { timeout: 5000 })
    ).toBeInTheDocument()
    toolsInstalled = true
    expect(
      await screen.findByText('Knowledge-pack tools installed', undefined, { timeout: 5000 })
    ).toBeInTheDocument()
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
    '#339 P8-2: the gate off (%s) keeps confirm disabled even when ticked and shows the same reason text as ModelsScreen',
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
      await screen.findByText('Installing the knowledge-pack tools failed.', undefined, { timeout: 5000 })
    ).toBeInTheDocument()
    expect(screen.getByText('kiwix-tools archive checksum mismatch')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument()
  })

  it('#339 P8-2: never calls getEngineStatus or getPolicy while the tools are already installed', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack()],
      onKnowledgePacksChanged: () => () => {}
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(screen.queryByText(/kiwix-tools binaries are not installed/)).toBeNull()
    assertNoUnexpectedApiCalls()
  })

  it('add flow calls the main-side dialog channel and refreshes on success', async () => {
    let added = false
    const addKnowledgePacks = vi.fn(async () => {
      added = true
      return { outcome: 'success' as const, added: [pack()], failed: 0, failureReason: null }
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => (added ? [pack()] : []),
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ToastProvider>
          <PacksPanel />
        </ToastProvider>
      </I18nProvider>
    )
    expect(await screen.findByText('No knowledge packs yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs…' }))
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(addKnowledgePacks).toHaveBeenCalledTimes(1)
    expect(await screen.findByText('Knowledge pack added')).toBeInTheDocument()
  })

  // #301 P5, finding L1 (plan §9.19 (c)3): the typed add-result DTO's four outcomes, asserted
  // through the RENDERED copy — the generic mixed-add string for 'partial', the mapped
  // reason-specific string for 'failure', nothing for 'cancelled'.
  it('add flow: cancelled shows nothing and never refreshes', async () => {
    const addKnowledgePacks = vi.fn(async () => ({
      outcome: 'cancelled' as const,
      added: [],
      failed: 0,
      failureReason: null
    }))
    const listKnowledgePacks = vi.fn(async () => [])
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks,
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('No knowledge packs yet')).toBeInTheDocument()
    const callsBefore = listKnowledgePacks.mock.calls.length
    await user.click(screen.getByRole('button', { name: 'Add packs…' }))
    await waitFor(() => expect(addKnowledgePacks).toHaveBeenCalledTimes(1))
    // No refresh, no toast, no banner — 'cancelled' does nothing (§9.19 (c)3).
    expect(listKnowledgePacks.mock.calls.length).toBe(callsBefore)
    expect(screen.queryByText('Knowledge pack added')).not.toBeInTheDocument()
  })

  it('add flow: partial shows the toast for the added count AND the generic mixed-add banner', async () => {
    let added = false
    const addKnowledgePacks = vi.fn(async () => {
      added = true
      return { outcome: 'partial' as const, added: [pack()], failed: 1, failureReason: 'manager' as const }
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => (added ? [pack()] : []),
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ToastProvider>
          <PacksPanel />
        </ToastProvider>
      </I18nProvider>
    )
    expect(await screen.findByText('No knowledge packs yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs…' }))
    expect(await screen.findByText('Knowledge pack added')).toBeInTheDocument()
    // The generic banner — a `failureReason` never renders anything but this mapped copy.
    expect(await screen.findByText('1 of 2 archives could not be added.')).toBeInTheDocument()
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
  })

  it.each([
    ['not-a-zim', 'The chosen file is not a readable ZIM archive.'],
    ['tools-missing', /kiwix-tools binaries are not installed/],
    ['manager', 'The archive could not be read by kiwix-manage. Check that the file is complete and try again.'],
    ['path-unsupported', /kiwix-manage cannot read an archive whose folder or file name contains/],
    ['other', 'The archive could not be added.']
  ] as const)('add flow: failure (%s) shows the reason’s banner text, never a different one', async (reason, expected) => {
    const addKnowledgePacks = vi.fn(async () => ({
      outcome: 'failure' as const,
      added: [],
      failed: 1,
      failureReason: reason
    }))
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [],
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('No knowledge packs yet')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Add packs…' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
    expect(screen.queryByText('Knowledge pack added')).not.toBeInTheDocument()
  })

  // #301 P6 (plan §9.23, task 6(e)): the same four failure reasons in German — the DE catalog
  // carries its own mapped banner text, never a raw reason code or manager detail.
  it.each([
    ['not-a-zim', 'Die gewählte Datei ist kein lesbares ZIM-Archiv.'],
    ['tools-missing', /kiwix-tools-Programme sind auf diesem Laufwerk nicht installiert/],
    [
      'manager',
      'Das Archiv konnte nicht von kiwix-manage gelesen werden. Prüfe, ob die Datei vollständig ist, und versuch es noch einmal.'
    ],
    ['path-unsupported', /kiwix-manage kein Archiv lesen, dessen Ordner- oder Dateiname/],
    ['other', 'Das Archiv konnte nicht hinzugefügt werden.']
  ] as const)('add flow (DE): failure (%s) shows the German reason banner', async (reason, expected) => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    const addKnowledgePacks = vi.fn(async () => ({
      outcome: 'failure' as const,
      added: [],
      failed: 1,
      failureReason: reason
    }))
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [],
      addKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Noch keine Wissenspakete')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pakete hinzufügen…' }))
    expect(await screen.findByText(expected)).toBeInTheDocument()
  })

  it('remove asks for confirmation and says the file is untouched', async () => {
    const removeKnowledgePack = vi.fn(async () => undefined)
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack()],
      removeKnowledgePack
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    // #301 P6 (plan §9.23 (b)6): the button's accessible name now includes the pack title
    // (`packs.removeNamed`) — the visible text is still the plain "Remove".
    await user.click(await screen.findByRole('button', { name: 'Remove Klimawandel von Wikipedia' }))
    expect(await screen.findByText(/archive file on disk is not touched/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Remove pack' }))
    await waitFor(() => expect(removeKnowledgePack).toHaveBeenCalledWith('uuid-climate'))
  })

  // #301 P3b, finding L7: DB-only list, live refresh state, and the pack-update event.
  it('shows the refreshing line while status.refreshing, and a reconcile-end event clears it and refetches', async () => {
    const emitter = packsEventEmitter()
    let listCalls = 0
    const listKnowledgePacks = vi.fn(async () => {
      listCalls++
      return listCalls === 1 ? [] : [pack()]
    })
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: true, revision: 0 }),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Checking the drive for packs…')).toBeInTheDocument()
    act(() => emitter.emit({ epoch: 1, revision: 1, refreshing: false, reason: 'reconcile-end' }))
    await waitFor(() =>
      expect(screen.queryByText('Checking the drive for packs…')).not.toBeInTheDocument()
    )
    expect(await screen.findByText('Klimawandel von Wikipedia')).toBeInTheDocument()
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
  })

  it('Refresh calls packs:refresh', async () => {
    const refreshKnowledgePacks = vi.fn(async () => ({ started: true }))
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack()],
      refreshKnowledgePacks
    })
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await user.click(await screen.findByRole('button', { name: 'Refresh' }))
    expect(refreshKnowledgePacks).toHaveBeenCalledTimes(1)
  })

  it('ignores a packs:changed event whose epoch is below the last one seen', async () => {
    const emitter = packsEventEmitter()
    const listKnowledgePacks = vi.fn(async () => [pack()])
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks,
      onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await screen.findByText('Klimawandel von Wikipedia')
    expect(listKnowledgePacks).toHaveBeenCalledTimes(1)
    // A newer epoch first advances what counts as "last seen"…
    act(() => emitter.emit({ epoch: 5, revision: 2, refreshing: false, reason: 'mutation' }))
    await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
    // …then an OLDER epoch (an old session's late announcement) must change nothing: no
    // refetch, and the refreshing line never appears from a stale reconcile-start.
    act(() => emitter.emit({ epoch: 3, revision: 3, refreshing: true, reason: 'reconcile-start' }))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(listKnowledgePacks).toHaveBeenCalledTimes(2)
    expect(screen.queryByText('Checking the drive for packs…')).not.toBeInTheDocument()
  })

  it('shows the identity-mismatch badge for a pack replaced by a different archive', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ available: false, unavailableReason: 'identity-mismatch' })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Different archive')).toBeInTheDocument()
  })

  // #301 P6 (plan §9.23 (a) rows 5/6, (c)5): the NEW no-full-text-index badge shows BESIDE
  // the enabled/disabled badge (a pack can be both), never for unknown/yes/undefined.
  it('shows the no-full-text-index badge and its reason line beside the enabled badge; absent for unknown/yes/undefined', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ id: 'p-no', title: 'No-index pack', searchable: 'no' }),
        pack({ id: 'p-unknown', title: 'Unknown pack', searchable: 'unknown' }),
        pack({ id: 'p-yes', title: 'Yes pack', searchable: 'yes' }),
        pack({ id: 'p-undef', title: 'Undefined pack', searchable: undefined })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('No-index pack')).toBeInTheDocument()
    // Exactly ONE pack (searchable: 'no') carries the badge and its visible reason line.
    expect(screen.getAllByText('No full-text index')).toHaveLength(1)
    expect(
      screen.getByText(
        'This archive has no full-text search index. It is skipped when asking, but its articles stay readable.'
      )
    ).toBeInTheDocument()
    // Every pack still carries its enabled badge — the two badges sit BESIDE each other.
    expect(screen.getAllByText('Enabled')).toHaveLength(4)
  })

  it('shows the no-full-text-index badge and reason line in German', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack({ id: 'p-no', title: 'Paket ohne Index', searchable: 'no' })]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText('Kein Volltextindex')).toBeInTheDocument()
    expect(
      screen.getByText(
        'Dieses Archiv hat keinen Volltextindex. Beim Fragen wird es übersprungen, seine Artikel bleiben aber lesbar.'
      )
    ).toBeInTheDocument()
  })

  // #301 P6 (plan §9.23 (b)3/7): the panel's reason text for missing / identity-mismatch is
  // reachable WITHOUT a mouse — a visible line under the title row, not only a Badge tooltip.
  it('renders the missing/identity-mismatch reason text visibly (EN + DE), not only in a Badge tooltip', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ id: 'p-missing', title: 'Missing pack', available: false, unavailableReason: 'missing' }),
        pack({
          id: 'p-mismatch',
          title: 'Mismatch pack',
          available: false,
          unavailableReason: 'identity-mismatch'
        })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText(/archive file could not be found/)).toBeInTheDocument()
    expect(screen.getByText(/is a different archive/)).toBeInTheDocument()
  })

  it('renders the missing/identity-mismatch reason text visibly in German', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ id: 'p-missing', title: 'Fehlendes Paket', available: false, unavailableReason: 'missing' }),
        pack({
          id: 'p-mismatch',
          title: 'Abweichendes Paket',
          available: false,
          unavailableReason: 'identity-mismatch'
        })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    expect(await screen.findByText(/Archivdatei wurde nicht gefunden/)).toBeInTheDocument()
    expect(screen.getByText(/ist ein anderes Archiv/)).toBeInTheDocument()
  })

  // #301 P6 (plan §9.23 (b)7): `.packs-list` is an ARIA list — one listitem per pack.
  it('renders the packs list with list/listitem roles, one listitem per pack', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [pack(), pack({ id: 'p2', title: 'Second pack' })]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    const list = await screen.findByRole('list', { name: 'Knowledge packs' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  // #301 P6 (plan §9.23 (b)6): the per-row Enable/Disable/Remove buttons get an accessible
  // name that includes the pack title — the VISIBLE text stays the plain verb.
  it('names the per-row Enable/Disable/Remove buttons with the pack title', async () => {
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ enabled: true }),
        pack({ id: 'p-off', title: 'Off pack', enabled: false })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await screen.findByText('Klimawandel von Wikipedia')
    expect(screen.getByRole('button', { name: 'Disable Klimawandel von Wikipedia' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Enable Off pack' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Klimawandel von Wikipedia' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Remove Off pack' })).toBeInTheDocument()
    // Visible text is unchanged — still the plain verb, never the pack title inline.
    expect(screen.getAllByText('Remove')).toHaveLength(2)
  })

  it('names the per-row Enable/Disable/Remove buttons with the pack title in German', async () => {
    window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
    stubApi({
      getKnowledgePackStatus: async () => ({ toolsInstalled: true, refreshing: false, revision: 0 }),
      listKnowledgePacks: async () => [
        pack({ enabled: true }),
        pack({ id: 'p-off', title: 'Anderes Paket', enabled: false })
      ]
    })
    render(
      <I18nProvider>
        <PacksPanel />
      </I18nProvider>
    )
    await screen.findByText('Klimawandel von Wikipedia')
    expect(
      screen.getByRole('button', { name: 'Klimawandel von Wikipedia deaktivieren' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Anderes Paket aktivieren' })).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: 'Klimawandel von Wikipedia entfernen' })
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Anderes Paket entfernen' })).toBeInTheDocument()
  })
})

describe('ScopePopover — knowledge packs', () => {
  const collections: Collection[] = [
    {
      id: 'lib',
      name: 'Library',
      type: 'library',
      description: null,
      builtin: true,
      color: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      archivedAt: null
    } as Collection
  ]
  const doc = {
    id: 'd1',
    title: 'contract.pdf',
    status: 'indexed',
    chunkCount: 1
  } as DocumentInfo

  it('renders the packs section, toggles a pack, and an unavailable pack is not tickable', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack(), pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false })]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findByText('Knowledge packs')).toBeInTheDocument()
    const packBox = screen.getByRole('checkbox', { name: /Klimawandel von Wikipedia/ })
    const goneBox = screen.getByRole('checkbox', { name: /Chemie von Wikipedia/ })
    expect(goneBox).toBeDisabled()
    await user.click(packBox)
    expect(emitted.at(-1)).toEqual({
      collectionIds: [],
      documentIds: [],
      packIds: ['uuid-climate']
    })
  })

  it('keeps the picker for a pack-only corpus (no documents imported yet)', async () => {
    // Regression: the empty-corpus early return used to collapse the picker into the
    // "Add documents" jump, making the packs section unreachable in a fresh workspace
    // with an offline Wikipedia added but nothing imported (found in the live demo).
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('checkbox', { name: /Klimawandel von Wikipedia/ }))
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-climate'])
  })

  // ---- Documents toggle (#301 P4, finding M10, ruling D4) --------------------------------
  // The explicit "answer from the ticked packs, not from my documents" control. It exists only
  // where the packs section exists, the flag is never derived from an empty selection, and the
  // chip says what the ask will really do (the resolved-scope half is T10-a in
  // tests/integration/zim-regressions.test.ts).

  it('unticking Documents emits the flag with cleared document sources, keeping the ticked packs', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: ['lib'], documentIds: ['d1'], packIds: ['uuid-climate'] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    const documentsBox = await screen.findByRole('checkbox', { name: /Search my documents/ })
    expect(documentsBox).toBeChecked()
    await user.click(documentsBox)
    expect(emitted.at(-1)).toEqual({
      collectionIds: [],
      documentIds: [],
      packIds: ['uuid-climate'],
      documentsOff: true
    })
  })

  it('ticking a collection while documents are off clears the flag (an emit never carries it with a document source)', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-climate'], documentsOff: true }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findByRole('checkbox', { name: /Search my documents/ })).not.toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: /Library/ }))
    expect(emitted.at(-1)).toEqual({
      collectionIds: ['lib'],
      documentIds: [],
      packIds: ['uuid-climate']
    })
    // Ticking the Documents row itself is the other way back: the legacy empty scope.
    await user.click(screen.getByRole('checkbox', { name: /Search my documents/ }))
    expect(emitted.at(-1)).toEqual({ collectionIds: [], documentIds: [], packIds: ['uuid-climate'] })
    // Toggling a PACK while documents are off preserves the flag (spread-preservation).
    await user.click(screen.getByRole('checkbox', { name: /Klimawandel von Wikipedia/ }))
    expect(emitted.at(-1)).toEqual({ collectionIds: [], documentIds: [], documentsOff: true })
  })

  // #340 nit (the T18-b observation): a ticked pack that was disabled or went missing afterwards
  // is still named by the chip — WITH its state, in the popover row's own words — so the
  // "Answering from:" readout never claims a source the ask will skip.
  it('the chip names a ticked pack that is disabled or unavailable with its state', () => {
    stubApi({})
    const scope = { collectionIds: [], documentIds: [], packIds: ['uuid-climate'] }
    const disabled = render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack({ enabled: false })]}
          scope={scope}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button')).toHaveTextContent('Pack: Klimawandel von Wikipedia (disabled)')
    disabled.unmount()
    const missing = render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack({ available: false, unavailableReason: 'missing' })]}
          scope={scope}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button')).toHaveTextContent('Pack: Klimawandel von Wikipedia (not available)')
    missing.unmount()
    render(
      <I18nProvider>
        <ScopePopover docs={[doc]} collections={collections} packs={[pack()]} scope={scope} onChangeScope={() => {}} />
      </I18nProvider>
    )
    expect(screen.getByRole('button')).toHaveTextContent('Pack: Klimawandel von Wikipedia')
    expect(screen.getByRole('button')).not.toHaveTextContent('(')
  })

  it('the chip says "documents off" beside the packs phrase, the hint names what stays on, and the reset clears the flag', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-climate'], documentsOff: true }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    const trigger = screen.getByRole('button')
    expect(trigger).toHaveTextContent('Pack: Klimawandel von Wikipedia · documents off')
    await user.click(trigger)
    expect(await screen.findByText(/Files attached to this chat are still used/)).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /All documents/ }))
    expect(emitted.at(-1)).toEqual({ collectionIds: [], documentIds: [] })
  })

  it('with documents off and no pack ticked the chip names the state, not a corpus', () => {
    stubApi({})
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], documentsOff: true }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    expect(screen.getByRole('button')).toHaveTextContent(
      'no sources — turn documents on or tick a knowledge pack'
    )
  })

  it('renders no Documents toggle when no pack is registered (the popover stays byte-identical)', async () => {
    stubApi({})
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={() => {}}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    expect(await screen.findByRole('checkbox', { name: /Library/ })).toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: /Search my documents/ })).toBeNull()
  })

  it('preserves packIds when an unrelated source is toggled (spread-preservation)', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-climate'] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    await user.click(await screen.findByRole('checkbox', { name: /Library/ }))
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-climate'])
    expect(emitted.at(-1)?.collectionIds).toEqual(['lib'])
  })

  // ---- D6 + the selection cap (#301 P4, ruling §7; plan §9.21 (c)6 / (e)8) ------------------
  // The rule these pin: a pack the user TICKED stays untickable-able whatever state it is in — a
  // greyed box on a selection that is silently contributing nothing is a trap. Ineligibility is
  // SHOWN, never hidden, and the 13th tick is refused where the user can see why.

  it('refuses the 13th tick, disables every unticked pack at the cap, and shows the limit line once', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    const many = Array.from({ length: MAX_SELECTED_PACKS + 1 }, (_, i) =>
      pack({ id: `uuid-${i}`, title: `Pack ${String(i).padStart(2, '0')}` })
    )
    const selected = many.slice(0, MAX_SELECTED_PACKS).map((k) => k.id)
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={many}
          scope={{ collectionIds: [], documentIds: [], packIds: selected }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    const limitLine = `Up to ${MAX_SELECTED_PACKS} knowledge packs per chat`
    expect(await screen.findByText(limitLine)).toBeInTheDocument()
    expect(screen.getAllByText(limitLine)).toHaveLength(1) // once under the title, not per row
    const thirteenth = screen.getByRole('checkbox', { name: /Pack 12/ })
    expect(thirteenth).toBeDisabled()
    await user.click(thirteenth)
    expect(emitted).toEqual([]) // REFUSED — not accepted and silently trimmed downstream
    // …and a SELECTED pack is still deselectable, which is how the user gets back under the cap.
    await user.click(screen.getByRole('checkbox', { name: /Pack 00/ }))
    expect(emitted.at(-1)?.packIds).toEqual(selected.filter((id) => id !== 'uuid-0'))
  })

  it('keeps a SELECTED unavailable or disabled pack deselectable and shows its reason', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[
            pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false, unavailableReason: 'missing' }),
            pack({ id: 'uuid-off', title: 'Biologie von Wikipedia', enabled: false })
          ]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-gone', 'uuid-off'] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    const gone = await screen.findByRole('checkbox', { name: /Chemie von Wikipedia/ })
    const off = screen.getByRole('checkbox', { name: /Biologie von Wikipedia/ })
    expect(gone).toBeChecked()
    expect(gone).toBeEnabled()
    expect(off).toBeChecked()
    expect(off).toBeEnabled()
    // #301 P6 (plan §9.23 (c)5): the hint names the RECORDED reason, not a generic
    // "not available" — the row now says what the per-answer outcome will say.
    expect(screen.getByText('file missing')).toBeInTheDocument()
    expect(screen.queryByText('not available')).not.toBeInTheDocument()
    expect(screen.getByText('disabled')).toBeInTheDocument()
    await user.click(gone)
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-off'])
  })

  it('renders a persisted id with no pack row as a ticked "Removed pack" that can be unticked', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack()]}
          scope={{ collectionIds: [], documentIds: [], packIds: ['uuid-climate', 'uuid-vanished'] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    const removed = await screen.findByRole('checkbox', { name: /Removed pack/ })
    expect(removed).toBeChecked()
    expect(removed).toBeEnabled()
    await user.click(removed)
    expect(emitted.at(-1)?.packIds).toEqual(['uuid-climate'])
  })

  it('leaves an UNSELECTED ineligible pack unticked and not tickable', async () => {
    stubApi({})
    const emitted: DocumentScope[] = []
    const user = userEvent.setup()
    render(
      <I18nProvider>
        <ScopePopover
          docs={[doc]}
          collections={collections}
          packs={[pack({ id: 'uuid-gone', title: 'Chemie von Wikipedia', available: false })]}
          scope={{ collectionIds: [], documentIds: [] }}
          onChangeScope={(next) => emitted.push(next)}
        />
      </I18nProvider>
    )
    await user.click(screen.getByRole('button'))
    const gone = await screen.findByRole('checkbox', { name: /Chemie von Wikipedia/ })
    expect(gone).not.toBeChecked()
    expect(gone).toBeDisabled()
    await user.click(gone)
    expect(emitted).toEqual([])
  })
})

describe('ArticleModal', () => {
  it('renders the article sections from the main-resolved plain text', async () => {
    stubApi({
      getPackArticle: async () => ({
        title: 'Treibhausgas',
        sections: [
          { label: null, text: 'Treibhausgase sind Spurengase.' },
          { label: 'Landwirtschaft', text: 'Methan entsteht in der Landwirtschaft.' }
        ],
        partial: false
      })
    })
    render(
      <I18nProvider>
        <ArticleModal
          target={{ packId: 'uuid-climate', articlePath: 'Treibhausgas', archiveTitle: 'Klimawandel von Wikipedia' }}
          onClose={() => {}}
        />
      </I18nProvider>
    )
    expect(await screen.findByText('Treibhausgase sind Spurengase.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Landwirtschaft' })).toBeInTheDocument()
    expect(screen.getByText(/From Klimawandel von Wikipedia/)).toBeInTheDocument()
  })

  it('warns that only the first part is shown when the conversion was partial (H1 truncation)', async () => {
    stubApi({
      getPackArticle: async () => ({
        title: 'Treibhausgas',
        sections: [{ label: null, text: 'Treibhausgase sind Spurengase.' }],
        partial: true
      })
    })
    render(
      <I18nProvider>
        <ArticleModal
          target={{ packId: 'uuid-climate', articlePath: 'Treibhausgas' }}
          onClose={() => {}}
        />
      </I18nProvider>
    )
    expect(await screen.findByText(/Only the first part of this article could be shown/)).toBeInTheDocument()
    // The partial text itself is still shown — a partial extraction beats an empty viewer.
    expect(screen.getByText('Treibhausgase sind Spurengase.')).toBeInTheDocument()
  })

  it('shows the honest unavailable state on a null article', async () => {
    stubApi({ getPackArticle: async () => null })
    render(
      <I18nProvider>
        <ArticleModal target={{ packId: 'x', articlePath: 'Gone' }} onClose={() => {}} />
      </I18nProvider>
    )
    expect(await screen.findByText(/not available right now/)).toBeInTheDocument()
  })
})

// =========================================================================================
// T18-a (#301 P6) — the AUTOMATED half of the T18 acceptance row, per plan §9.23. One test
// with lettered legs (the T16-a pattern), each asserting by ROLE / accessible NAME /
// announced STATE — never by class, never by snapshot. The visual half (T18-b: both themes,
// a 900 px window, 200 % zoom, real screenshots) is the owner's and is recorded separately;
// nothing below claims appearance a token test already holds.
// =========================================================================================

/** Regex-escape, so a 200-character non-ASCII title can be used inside a name matcher. */
function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The accessible name a pack row composes: the title, plus its short reason hint when it has
 * one (§9.23 (b)4 — the pack's own reason deliberately stays INSIDE the label, so "…, checkbox,
 * not checked, dimmed" is never announced without its cause).
 */
function rowName(title: string, hint?: string): RegExp {
  return new RegExp(`^${esc(title)}\\s*${hint ? esc(hint) : ''}$`)
}

/** A 200-character non-ASCII title (§9.23 (d)): German compounds + CJK, deliberately no emoji. */
const LONG_TITLE = ((): string => {
  const chunk = 'Überwachungsverordnungsdurchführungsbestimmung-気候変動に関する政府間パネルの報告書-'
  let out = ''
  while (out.length < 200) out += chunk
  return out.slice(0, 200)
})()

/** Every reason code in `KnowledgePackOutcomeReason` — leg (g) renders EN copy for all 14. */
const ALL_REASONS: readonly KnowledgePackOutcomeReason[] = [
  'selection-limit',
  'removed',
  'disabled',
  'file-missing',
  'identity-mismatch',
  'not-served',
  'not-searchable',
  'tools-missing',
  'mode',
  'search-failed',
  'read-failed',
  'timeout',
  'deadline',
  'server-restarted'
]

const T18_COLLECTIONS: Collection[] = [
  {
    id: 'lib',
    name: 'Library',
    type: 'library',
    description: null,
    builtin: true,
    color: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    archivedAt: null
  } as Collection
]

function t18Doc(over: Partial<DocumentInfo> = {}): DocumentInfo {
  return {
    id: 'd1',
    title: 'contract.pdf',
    originalPath: null,
    mimeType: 'application/pdf',
    sizeBytes: 10,
    status: 'indexed',
    errorMessage: null,
    chunkCount: 1,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over
  } as DocumentInfo
}

/** The archive citation the "Open article" legs open. */
const T18_CITATION: Citation = {
  label: 'S1',
  sourceTitle: 'Treibhausgas',
  pageNumber: null,
  section: 'Landwirtschaft',
  snippet: 'Methan entsteht in der Landwirtschaft.',
  sourceKind: 'archive',
  packId: 'uuid-climate',
  archiveTitle: 'Klimawandel von Wikipedia',
  articlePath: 'A/Treibhausgas'
}

/** Citation card + the shared viewer, wired the way `ChatScreen` wires them (leg (d)). */
function ArticleHarness({ citation = T18_CITATION }: { citation?: Citation }): JSX.Element {
  const [target, setTarget] = useState<ArticleTarget | null>(null)
  return (
    <I18nProvider>
      <SourcesDisclosure
        citations={[citation]}
        onOpenArticle={(c) =>
          setTarget({ packId: c.packId!, articlePath: c.articlePath!, archiveTitle: c.archiveTitle })
        }
      />
      <ArticleModal target={target} onClose={() => setTarget(null)} />
    </I18nProvider>
  )
}

/** A live scope beside a PERSISTED outcome set (leg (g), inventory row 34). */
function NoticeHarness({ outcomes }: { outcomes: KnowledgePackOutcome[] }): JSX.Element {
  const [scope, setScope] = useState<DocumentScope>({ collectionIds: [], documentIds: [] })
  return (
    <I18nProvider>
      <ScopePopover
        docs={[t18Doc()]}
        collections={T18_COLLECTIONS}
        packs={[pack()]}
        scope={scope}
        onChangeScope={setScope}
      />
      <PackOutcomesNotice outcomes={outcomes} />
    </I18nProvider>
  )
}

function t18Conversation(): Conversation {
  return {
    id: 'c1',
    title: 'Doc Q&A',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    modelId: null,
    mode: 'documents',
    scopeDocumentIds: null,
    collectionId: null,
    scope: { collectionIds: [], documentIds: [] }
  } as Conversation
}

const T18_RUNTIME: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

describe('T18 — knowledge-pack UI acceptance (#301 P6, plan §9.23)', () => {
  it(
    'T18 every pack state in both languages, empty source set, long labels, keyboard-only modal / popover (focus trap, Escape, focus restoration), disabled controls not selectable, live refresh and per-answer notices',
    async () => {
      // ---- (a) every pack state, EN and DE (inventory rows 16, 20-24) ---------------------
      for (const lang of ['en', 'de'] as UiLanguage[]) {
        const T = (k: Parameters<typeof tr>[1]): string => tr(lang, k)
        window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, lang)
        stubApi({})
        const user = userEvent.setup()
        render(
          <I18nProvider>
            <ScopePopover
              docs={[t18Doc()]}
              collections={T18_COLLECTIONS}
              packs={[
                pack({ id: 'p-ok', title: 'Pack tickable' }),
                pack({ id: 'p-off', title: 'Pack disabled', enabled: false }),
                pack({
                  id: 'p-missing',
                  title: 'Pack missing',
                  available: false,
                  unavailableReason: 'missing'
                }),
                pack({
                  id: 'p-mismatch',
                  title: 'Pack mismatch',
                  available: false,
                  unavailableReason: 'identity-mismatch'
                }),
                // The pre-P3b generic state: unavailable with NO recorded reason.
                pack({
                  id: 'p-generic',
                  title: 'Pack generic',
                  available: false,
                  unavailableReason: null
                }),
                pack({ id: 'p-noindex', title: 'Pack noindex', searchable: 'no' }),
                // Searchability the probe has not settled is searched like yes — no hint.
                pack({ id: 'p-unknown', title: 'Pack unknown', searchable: 'unknown' }),
                pack({ id: 'p-sel-off', title: 'Pack selected disabled', enabled: false })
              ]}
              scope={{ collectionIds: [], documentIds: [], packIds: ['p-sel-off', 'p-vanished'] }}
              onChangeScope={() => {}}
            />
          </I18nProvider>
        )
        await user.click(screen.getByRole('button'))
        // Group semantics (§9.23 (b)3): both blocks are labelled groups, not bare checkbox runs.
        expect(
          await screen.findByRole('group', { name: T('chat.scope.packsTitle') })
        ).toBeInTheDocument()
        expect(screen.getByRole('group', { name: T('chat.scope.sourcesTitle') })).toBeInTheDocument()
        // The Documents toggle: NAME is the short label, the caveat is the DESCRIPTION (b)4.
        const docsBox = screen.getByRole('checkbox', { name: T('chat.scope.documentsToggle') })
        expect(docsBox).toHaveAccessibleName(T('chat.scope.documentsToggle'))
        expect(docsBox).toHaveAccessibleDescription(T('chat.scope.documentsToggleHint'))
        expect(docsBox).toBeChecked()
        // Tickable, and searchability-unknown is tickable too (absence of a hint is pinned).
        for (const title of ['Pack tickable', 'Pack unknown']) {
          const box = screen.getByRole('checkbox', { name: rowName(title) })
          expect(box, title).toBeEnabled()
          expect(box, title).not.toBeChecked()
        }
        // Every ineligible reason, announced in the name and disabled while unselected (D6).
        const reasons: Array<[string, string]> = [
          ['Pack disabled', T('chat.scope.packDisabled')],
          ['Pack missing', T('chat.scope.packMissing')],
          ['Pack mismatch', T('chat.scope.packMismatch')],
          ['Pack generic', T('chat.scope.packUnavailable')],
          ['Pack noindex', T('chat.scope.packNotSearchable')]
        ]
        for (const [title, hint] of reasons) {
          const box = screen.getByRole('checkbox', { name: rowName(title, hint) })
          expect(box, `${title} / ${lang}`).toBeDisabled()
          expect(box, `${title} / ${lang}`).not.toBeChecked()
        }
        // A SELECTED ineligible pack keeps its reason AND stays deselectable (D6).
        const selectedOff = screen.getByRole('checkbox', {
          name: rowName('Pack selected disabled', T('chat.scope.packDisabled'))
        })
        expect(selectedOff).toBeChecked()
        expect(selectedOff).toBeEnabled()
        // A persisted id with no row: named, ticked, clearable — never silently dropped.
        const removed = screen.getByRole('checkbox', { name: T('chat.scope.packRemoved') })
        expect(removed).toBeChecked()
        expect(removed).toBeEnabled()
        // Nothing is at the cap here, so no limit line and no cap description anywhere.
        expect(
          screen.queryByText(trCount(lang, 'chat.scope.packLimit', MAX_SELECTED_PACKS))
        ).toBeNull()
        cleanup()

        // …and the cap state (row 24): the line shows ONCE and every cap-refused box is
        // DESCRIBED by it, so the reason for the refusal is announced with the state (b)5.
        const many = Array.from({ length: MAX_SELECTED_PACKS + 1 }, (_, i) =>
          pack({ id: `cap-${i}`, title: `Cap pack ${String(i).padStart(2, '0')}` })
        )
        render(
          <I18nProvider>
            <ScopePopover
              docs={[t18Doc()]}
              collections={T18_COLLECTIONS}
              packs={many}
              scope={{
                collectionIds: [],
                documentIds: [],
                packIds: many.slice(0, MAX_SELECTED_PACKS).map((k) => k.id)
              }}
              onChangeScope={() => {}}
            />
          </I18nProvider>
        )
        await user.click(screen.getByRole('button'))
        const limitLine = trCount(lang, 'chat.scope.packLimit', MAX_SELECTED_PACKS)
        expect(await screen.findByText(limitLine)).toBeInTheDocument()
        expect(screen.getAllByText(limitLine)).toHaveLength(1)
        const capped = screen.getByRole('checkbox', { name: rowName('Cap pack 12') })
        expect(capped).toBeDisabled()
        expect(capped).toHaveAccessibleDescription(limitLine)
        // A pack that IS selected is not refused, so it carries no cap description.
        const inside = screen.getByRole('checkbox', { name: rowName('Cap pack 00') })
        expect(inside).toBeEnabled()
        expect(inside).not.toHaveAccessibleDescription(limitLine)
        cleanup()
        window.localStorage.clear()
      }

      // ---- (b) empty source sets (inventory rows 18, 19, 25, 26; §9.23 (e)) ---------------
      stubApi({})
      const userB = userEvent.setup()
      // Documents off with nothing ticked: the chip NAMES the state — and IS the trigger.
      render(
        <I18nProvider>
          <ScopePopover
            docs={[t18Doc()]}
            collections={T18_COLLECTIONS}
            packs={[pack()]}
            scope={{ collectionIds: [], documentIds: [], documentsOff: true }}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      const emptyChip = screen.getByRole('button')
      expect(emptyChip).toHaveTextContent(tr('en', 'chat.scope.documentsOffNoPacks'))
      await userB.click(emptyChip)
      expect(
        await screen.findByRole('group', { name: tr('en', 'chat.scope.packsTitle') })
      ).toBeInTheDocument()
      cleanup()

      // Documents off with ONLY attachments (row 19): the file is named, the tail is honest.
      render(
        <I18nProvider>
          <ScopePopover
            docs={[]}
            collections={T18_COLLECTIONS}
            packs={[pack()]}
            attachments={[t18Doc({ id: 'a1', title: 'notes.pdf' })]}
            scope={{ collectionIds: [], documentIds: [], documentsOff: true }}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      expect(screen.getByRole('button')).toHaveTextContent(
        `notes.pdf · ${tr('en', 'chat.scope.documentsOffSuffix')}`
      )
      cleanup()

      // A pack-only corpus keeps the picker (row 25) — the source control stays reachable.
      render(
        <I18nProvider>
          <ScopePopover
            docs={[]}
            collections={T18_COLLECTIONS}
            packs={[pack()]}
            scope={{ collectionIds: [], documentIds: [] }}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      await userB.click(screen.getByRole('button'))
      expect(
        await screen.findByRole('checkbox', { name: rowName('Klimawandel von Wikipedia') })
      ).toBeEnabled()
      cleanup()

      // Nothing at all (row 26): the ONE state with no picker, because there is nothing to pick.
      render(
        <I18nProvider>
          <ScopePopover
            docs={[]}
            collections={T18_COLLECTIONS}
            packs={[]}
            scope={null}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      const jump = screen.getByRole('button')
      expect(jump).toHaveTextContent(tr('en', 'chat.scope.none'))
      await userB.click(jump)
      expect(screen.queryByRole('group', { name: tr('en', 'chat.scope.packsTitle') })).toBeNull()
      cleanup()

      // ---- (c) long labels: the FULL 200-character title is the accessible name -----------
      expect(LONG_TITLE).toHaveLength(200)
      stubApi({})
      const userC = userEvent.setup()
      render(
        <I18nProvider>
          <ScopePopover
            docs={[]}
            collections={T18_COLLECTIONS}
            packs={[pack({ id: 'p-long', title: LONG_TITLE })]}
            scope={{ collectionIds: [], documentIds: [] }}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      await userC.click(screen.getByRole('button'))
      expect(await screen.findByRole('checkbox', { name: LONG_TITLE })).toHaveAccessibleName(
        LONG_TITLE
      )
      cleanup()

      stubApi({
        getPackArticle: async () => ({
          title: LONG_TITLE,
          sections: [{ label: null, text: 'Ein Absatz.' }],
          partial: false
        })
      })
      render(
        <I18nProvider>
          <ArticleModal
            target={{ packId: 'uuid-climate', articlePath: 'A/x', archiveTitle: 'Wikipedia' }}
            onClose={() => {}}
          />
        </I18nProvider>
      )
      expect(await screen.findByRole('dialog', { name: LONG_TITLE })).toHaveAccessibleName(
        LONG_TITLE
      )
      cleanup()

      render(
        <NoticeHarness
          outcomes={[
            {
              packId: 'p-long',
              title: LONG_TITLE,
              status: 'searched',
              reason: null,
              found: 1,
              admitted: 1
            }
          ]}
        />
      )
      await userC.click(screen.getByRole('button', { name: /Knowledge packs:/ }))
      expect(screen.getByText(LONG_TITLE)).toBeInTheDocument()
      cleanup()

      // ---- (d) keyboard only: popover Escape/restoration, modal trap/Escape/restoration ----
      stubApi({})
      const userD = userEvent.setup()
      render(
        <I18nProvider>
          <ScopePopover
            docs={[t18Doc()]}
            collections={T18_COLLECTIONS}
            packs={[pack()]}
            scope={{ collectionIds: [], documentIds: [] }}
            onChangeScope={() => {}}
          />
        </I18nProvider>
      )
      const trigger = screen.getByRole('button')
      trigger.focus()
      expect(document.activeElement).toBe(trigger)
      await userD.keyboard('{Enter}')
      await screen.findByRole('group', { name: tr('en', 'chat.scope.packsTitle') })
      // Tab moves onto a row control INSIDE the popover…
      await userD.tab()
      expect(document.activeElement?.tagName).toBe('INPUT')
      expect(document.activeElement).toHaveAttribute('type', 'checkbox')
      // …Escape closes it and focus is BACK on the chip that opened it.
      await userD.keyboard('{Escape}')
      await waitFor(() =>
        expect(screen.queryByRole('group', { name: tr('en', 'chat.scope.packsTitle') })).toBeNull()
      )
      expect(document.activeElement).toBe(trigger)
      cleanup()

      stubApi({
        getPackArticle: async () => ({
          title: 'Treibhausgas',
          sections: [{ label: null, text: 'Treibhausgase sind Spurengase.' }],
          partial: false
        })
      })
      render(<ArticleHarness />)
      await userD.click(screen.getByRole('button', { name: /Sources/ }))
      const openBtn = screen.getByRole('button', {
        name: tr('en', 'chat.sources.openArticleNamed', { title: 'Treibhausgas' })
      })
      // The visible text stays the bare action; the NAME carries the article (b)6.
      expect(openBtn).toHaveTextContent(tr('en', 'chat.sources.openArticle'))
      openBtn.focus()
      await userD.keyboard('{Enter}')
      const dialog = await screen.findByRole('dialog')
      await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true))
      // Focus TRAP: repeated Tab never leaves the dialog.
      for (let i = 0; i < 6; i++) {
        await userD.tab()
        expect(dialog.contains(document.activeElement), `tab ${i}`).toBe(true)
      }
      await userD.keyboard('{Escape}')
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
      expect(document.activeElement).toBe(openBtn)
      cleanup()

      // ---- (e) disabled controls are not selectable (§9.23 (b)9) --------------------------
      stubApi({})
      const userE = userEvent.setup()
      const emitted: DocumentScope[] = []
      const capPacks = [
        ...Array.from({ length: MAX_SELECTED_PACKS }, (_, i) =>
          pack({ id: `e-${i}`, title: `Sel pack ${String(i).padStart(2, '0')}` })
        ),
        pack({ id: 'e-extra', title: 'Cap refused pack' }),
        pack({ id: 'e-noindex', title: 'Index-less pack', searchable: 'no' })
      ]
      render(
        <I18nProvider>
          <ScopePopover
            docs={[t18Doc()]}
            collections={T18_COLLECTIONS}
            packs={capPacks}
            scope={{
              collectionIds: [],
              documentIds: [],
              packIds: capPacks.slice(0, MAX_SELECTED_PACKS).map((k) => k.id)
            }}
            onChangeScope={(next) => emitted.push(next)}
          />
        </I18nProvider>
      )
      await userE.click(screen.getByRole('button'))
      const capRefused = await screen.findByRole('checkbox', { name: rowName('Cap refused pack') })
      const ineligible = screen.getByRole('checkbox', {
        name: rowName('Index-less pack', tr('en', 'chat.scope.packNotSearchable'))
      })
      expect(capRefused).toBeDisabled()
      expect(ineligible).toBeDisabled()
      await userE.click(capRefused)
      await userE.click(ineligible)
      // REFUSED at the source — not accepted here and trimmed somewhere downstream.
      expect(emitted).toEqual([])
      cleanup()

      // ---- (f) live refresh through the real event (§9.23 (f); rows 5, 35) ----------------
      // A searchability verdict arrives on the SAME `packs:changed` refetch as everything
      // else, so a mounted popover must grey the row with its new reason — with no navigation.
      const emitter = packsEventEmitter()
      let listCalls = 0
      const listKnowledgePacks = vi.fn(async () => {
        listCalls++
        return listCalls === 1 ? [pack()] : [pack({ searchable: 'no' })]
      })
      stubApi({
        listConversations: vi.fn(async () => [t18Conversation()]),
        getRuntimeStatus: vi.fn(async () => T18_RUNTIME),
        listMessages: vi.fn(async () => []),
        listDocuments: vi.fn(async () => [t18Doc()]),
        listCollections: vi.fn(async () => T18_COLLECTIONS),
        listAttachments: vi.fn(async () => []),
        listKnowledgePacks,
        onKnowledgePacksChanged: emitter.onKnowledgePacksChanged
      })
      const userF = userEvent.setup()
      render(<ChatScreen onNavigate={() => {}} />)
      await userF.click(await screen.findByText('Doc Q&A'))
      await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(1))
      await userF.click(await screen.findByRole('button', { name: /answering from/i }))
      expect(
        await screen.findByRole('checkbox', { name: rowName('Klimawandel von Wikipedia') })
      ).toBeEnabled()

      act(() => emitter.emit({ epoch: 2, revision: 1, refreshing: false, reason: 'reconcile-end' }))
      await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(2))
      const greyedName = rowName(
        'Klimawandel von Wikipedia',
        tr('en', 'chat.scope.packNotSearchable')
      )
      expect(await screen.findByRole('checkbox', { name: greyedName })).toBeDisabled()

      // An OLDER epoch (an old session's late announcement) refetches nothing. Proved without
      // a sleep: a newer event follows it, and the total call count shows the old one was
      // dropped rather than merely slow.
      act(() => emitter.emit({ epoch: 1, revision: 9, refreshing: false, reason: 'reconcile-end' }))
      act(() => emitter.emit({ epoch: 3, revision: 3, refreshing: false, reason: 'reconcile-end' }))
      await waitFor(() => expect(listKnowledgePacks).toHaveBeenCalledTimes(3))
      expect(listKnowledgePacks).toHaveBeenCalledTimes(3)
      expect(screen.getByRole('checkbox', { name: greyedName })).toBeDisabled()
      cleanup()

      // ---- (g) per-answer notices (rows 29-34): every reason code, and row 34's independence -
      stubApi({})
      const userG = userEvent.setup()
      const outcomes: KnowledgePackOutcome[] = [
        {
          packId: 'ok',
          title: 'Klimawandel von Wikipedia',
          status: 'searched',
          reason: null,
          found: 3,
          admitted: 2
        },
        ...ALL_REASONS.map((reason, i) => ({
          packId: `p-${reason}`,
          title: `Pack ${i}`,
          status: (reason === 'search-failed' ||
          reason === 'read-failed' ||
          reason === 'timeout' ||
          reason === 'server-restarted'
            ? 'failed'
            : 'skipped') as KnowledgePackOutcome['status'],
          reason,
          found: 0,
          admitted: 0
        }))
      ]
      render(<NoticeHarness outcomes={outcomes} />)
      const summary = screen.getByRole('button', {
        name: new RegExp(
          esc(tr('en', 'chat.packs.outcome.summary', { searched: 1, other: ALL_REASONS.length }))
        )
      })
      expect(summary).toHaveAttribute('aria-expanded', 'false')
      await userG.click(summary)
      expect(summary).toHaveAttribute('aria-expanded', 'true')
      // One list, one item per selected pack — "list, 15 items" is the announced structure.
      expect(screen.getByRole('list')).toBeInTheDocument()
      expect(screen.getAllByRole('listitem')).toHaveLength(outcomes.length)
      expect(screen.getByText(tr('en', 'chat.packs.outcome.searched'))).toBeInTheDocument()
      expect(screen.getByText(trCount('en', 'chat.packs.outcome.passages', 2))).toBeInTheDocument()
      for (const reason of ALL_REASONS) {
        expect(
          screen.getByText(tr('en', `chat.packs.outcome.${reason}` as 'chat.packs.outcome.searched')),
          reason
        ).toBeInTheDocument()
      }
      // Row 34: the notice reads the PERSISTED message, never the live scope. Change the scope
      // underneath it — tick a pack — and nothing about the answer's outcomes may move.
      await userG.click(screen.getByRole('button', { name: /answering from|using/i }))
      await userG.click(
        await screen.findByRole('checkbox', { name: rowName('Klimawandel von Wikipedia') })
      )
      await userG.keyboard('{Escape}')
      expect(summary).toHaveAttribute('aria-expanded', 'true')
      expect(summary).toHaveTextContent(
        tr('en', 'chat.packs.outcome.summary', { searched: 1, other: ALL_REASONS.length })
      )
      expect(screen.getAllByRole('listitem')).toHaveLength(outcomes.length)
      expect(screen.getByText(tr('en', 'chat.packs.outcome.deadline'))).toBeInTheDocument()
    },
    // A ceiling on a hang, never a proof (the T16-a precedent): these legs mount the real
    // ChatScreen and drive two portalled overlays with real userEvent timing.
    120_000
  )
})
