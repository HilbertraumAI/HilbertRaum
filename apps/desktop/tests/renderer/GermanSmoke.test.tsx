// @vitest-environment jsdom
import type { ReactNode } from 'react'
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { HomeScreen } from '../../src/renderer/screens/HomeScreen'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import { DocumentsScreen } from '../../src/renderer/screens/DocumentsScreen'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import { I18nProvider, UI_LANGUAGE_STORAGE_KEY } from '../../src/renderer/i18n'
import { t } from '../../src/shared/i18n'
import type { AppStatus, RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase-40 German render smokes (i18n-plan §5): one per migrated screen. Each renders
// the screen inside I18nProvider with the pre-unlock localStorage mirror seeded 'de'
// (i18n-plan §3.2 / D-L3) and asserts a German string from the de catalog — proving the
// screen's copy actually flows through t() (an untranslated literal would stay English).
// Assertions reference the catalogs (D-L8), never re-typed literals.

function appStatus(over: Partial<AppStatus> = {}): AppStatus {
  return {
    appName: 'x',
    appVersion: '0',
    offlineMode: true,
    networkAllowed: false,
    activeModelId: 'm1',
    hardwareProfile: 'UNKNOWN',
    workspaceMode: 'plaintext_dev',
    workspaceReady: true,
    machineRamGb: 16,
    dictationAvailable: false,
    ...over
  } as AppStatus
}

const runningStatus: RuntimeStatus = {
  running: true,
  modelId: 'm1',
  port: 1234,
  healthy: true,
  message: 'ok'
}

function german(node: ReactNode): JSX.Element {
  window.localStorage.setItem(UI_LANGUAGE_STORAGE_KEY, 'de')
  return <I18nProvider>{node}</I18nProvider>
}

beforeAll(() => {
  Object.defineProperty(window.HTMLElement.prototype, 'scrollTo', {
    configurable: true,
    writable: true,
    value: () => {}
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('German render smokes (Phase 40)', () => {
  it('HomeScreen renders German', async () => {
    stubApi({
      getAppStatus: vi.fn(async () => appStatus()),
      listDocuments: vi.fn(async () => []),
      runPreflight: vi.fn(async () => ({
        rootPath: 'x',
        writable: true,
        freeBytes: null,
        slowDriveWarning: null,
        problems: []
      })),
      getRuntimeStatus: vi.fn(async () => runningStatus)
    })
    render(german(<HomeScreen onNavigate={() => {}} />))

    expect(
      await screen.findByRole('button', { name: t('de', 'home.actions.startChat') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'home.headline.ready'))).toBeInTheDocument()
    expect(screen.getByText(t('de', 'home.workspace.label'))).toBeInTheDocument()
  })

  it('ChatScreen renders German (empty state + composer)', async () => {
    stubApi({
      listConversations: vi.fn(async () => []),
      getRuntimeStatus: vi.fn(async () => runningStatus),
      listDocuments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<ChatScreen onNavigate={() => {}} />))

    expect(await screen.findByText(t('de', 'chat.empty.title'))).toBeInTheDocument()
    expect(
      screen.getByPlaceholderText(t('de', 'chat.placeholder.chat'))
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'chat.send.send') })
    ).toBeInTheDocument()
    expect(
      screen.getByRole('button', { name: t('de', 'chat.example.summarize') })
    ).toBeInTheDocument()
  })

  it('DocumentsScreen renders German (empty state)', async () => {
    stubApi({
      listDocuments: vi.fn(async () => []),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<DocumentsScreen />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'docs.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'docs.empty.title'))).toBeInTheDocument()
    expect(
      screen.getAllByRole('button', { name: t('de', 'docs.import.files') }).length
    ).toBeGreaterThan(0)
  })

  it('ModelsScreen renders German (empty manifests)', async () => {
    stubApi({
      listModels: vi.fn(async () => []),
      getSettings: vi.fn(async () => ({}) as never),
      getPolicy: vi.fn(async () => {
        throw new Error('no policy')
      }),
      getAppStatus: vi.fn(async () => appStatus())
    })
    render(german(<ModelsScreen />))

    expect(
      await screen.findByRole('heading', { name: t('de', 'models.title') })
    ).toBeInTheDocument()
    expect(await screen.findByText(t('de', 'models.empty.title'))).toBeInTheDocument()
  })
})
