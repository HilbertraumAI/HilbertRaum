// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup, within, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillsTab } from '../../src/renderer/screens/settings/SkillsTab'
import { I18nProvider } from '../../src/renderer/i18n'
import { ToastProvider } from '../../src/renderer/components'
import { DEFAULT_SETTINGS, type AppSettings, type SkillInfo, type SkillPreview } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// Phase S5 — Settings → Skills UI (skills plan §15/§18.1). The renderer is a thin view over
// the S4 IPC surface: list / enable / import-preview / delete / acknowledge. fs, dialogs and
// validation all live main-side, so these tests stub window.api and assert the calm flows.

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'user:bank-statement',
    id: 'bank-statement',
    title: 'Bank statement helper',
    description: 'Explains a bank statement in plain language.',
    version: '1.0.0',
    kind: 'instruction',
    author: 'You',
    language: 'en',
    source: 'user',
    trustedLevel: 'user',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary:
      'can read the documents you pick for a turn; cannot access the network; reads only its own bundled files.',
    duplicateId: false,
    installedAt: '2026-06-17T00:00:00.000Z',
    updatedAt: '2026-06-17T00:00:00.000Z',
    ...over
  }
}

function preview(over: Partial<SkillPreview> = {}): SkillPreview {
  return {
    ok: true,
    sourceKind: 'zip',
    id: 'new-skill',
    title: 'New skill',
    description: 'A freshly picked skill.',
    version: '1.2.0',
    kind: 'instruction',
    author: 'You',
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'can read the documents you pick for a turn; cannot access the network.',
    errors: [],
    notes: [],
    ...over
  }
}

function renderTab(): void {
  render(
    <I18nProvider>
      <ToastProvider>
        <SkillsTab />
      </ToastProvider>
    </I18nProvider>
  )
}

afterEach(cleanup)

describe('SkillsTab — list + empty state', () => {
  it('shows the empty state with the import affordance when no skills are installed', async () => {
    stubApi({ listSkills: vi.fn(async () => []) })
    renderTab()
    expect(await screen.findByText('No skills yet')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import a skill/ })).toBeInTheDocument()
  })

  it('renders a row with the trust chip and the enable switch', async () => {
    stubApi({ listSkills: vi.fn(async () => [skill()]) })
    renderTab()
    expect(await screen.findByText('Bank statement helper')).toBeInTheDocument()
    expect(screen.getByText('Made by you')).toBeInTheDocument()
    expect(screen.getByRole('switch')).toBeChecked()
  })

  it('marks an app skill as non-deletable (no Delete item in the overflow)', async () => {
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill({ installId: 'app:x', source: 'app', trustedLevel: 'app' })]) })
    renderTab()
    await screen.findByText('Bank statement helper')
    await user.click(screen.getByRole('button', { name: 'Skill actions' }))
    expect(screen.getByRole('menuitem', { name: /Export/ })).toBeInTheDocument()
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument()
  })
})

describe('SkillsTab — enable / disable', () => {
  it('disables an enabled skill through the switch', async () => {
    const disableSkill = vi.fn(async () => skill({ enabled: false }))
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill()]), disableSkill })
    renderTab()
    await screen.findByText('Bank statement helper')
    await user.click(screen.getByRole('switch'))
    expect(disableSkill).toHaveBeenCalledWith('user:bank-statement')
  })

  // FE-3: rapid toggles must not race. The Switch is disabled while a toggle is in flight and a
  // second submit for the same skill is ignored; the final UI reconciles to the server state.
  it('suppresses a second toggle while the first is pending and ends on the server state', async () => {
    const user = userEvent.setup()
    let resolveDisable: (() => void) | null = null
    const disableSkill = vi.fn(() => new Promise<void>((res) => { resolveDisable = res }))
    const listSkills = vi.fn()
    listSkills.mockResolvedValueOnce([skill({ enabled: true })]) // initial load
    listSkills.mockResolvedValue([skill({ enabled: false })]) // server state after the disable
    stubApi({ listSkills, disableSkill: disableSkill as never })
    renderTab()
    const sw = await screen.findByRole('switch')
    expect(sw).toBeChecked()

    await user.click(sw) // first toggle → in flight
    expect(disableSkill).toHaveBeenCalledTimes(1)
    expect(sw).toBeDisabled() // disabled while pending — no double-submit

    await user.click(sw) // second toggle while pending → suppressed
    expect(disableSkill).toHaveBeenCalledTimes(1)

    // Resolve the first toggle → refresh reconciles to the server's post-disable state.
    await act(async () => {
      resolveDisable?.()
    })
    await waitFor(() => expect(screen.getByRole('switch')).not.toBeChecked())
    expect(screen.getByRole('switch')).toBeEnabled()
    expect(disableSkill).toHaveBeenCalledTimes(1)
  })

  it('confirms before enabling a duplicate-id skill (one active per name, DS12)', async () => {
    const enableSkill = vi.fn(async () => skill({ enabled: true }))
    const user = userEvent.setup()
    stubApi({
      listSkills: vi.fn(async () => [skill({ enabled: false, duplicateId: true })]),
      enableSkill
    })
    renderTab()
    await screen.findByText('Bank statement helper')
    await user.click(screen.getByRole('switch'))
    // The replace prompt appears first — nothing enabled yet.
    expect(screen.getByText('Use this skill instead?')).toBeInTheDocument()
    expect(enableSkill).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Turn on' }))
    expect(enableSkill).toHaveBeenCalledWith('user:bank-statement')
  })
})

describe('SkillsTab — detail drawer', () => {
  it('shows the permission block and the unacknowledged-warning acknowledge flow', async () => {
    const acknowledgeSkillWarning = vi.fn(async () => skill({ warningAck: true }))
    const user = userEvent.setup()
    stubApi({
      listSkills: vi.fn(async () => [skill({ warningAck: false })]),
      acknowledgeSkillWarning
    })
    renderTab()
    await user.click(await screen.findByText('Bank statement helper'))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('This skill can:')).toBeInTheDocument()
    expect(dialog.getByText('Add instructions to AI answers')).toBeInTheDocument()
    expect(dialog.getByText('Access the internet')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Got it' }))
    expect(acknowledgeSkillWarning).toHaveBeenCalledWith('user:bank-statement')
  })

  // The honest Tier-2 note triggers off reservesTools (a kind:'instruction' stub that reserves
  // its Tier-2 tools), NOT off kind:'tool' — the bank-statement v1 stub is instruction-only (DS17).
  it('shows the guidance-only note for a tool-reserved instruction skill', async () => {
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill({ kind: 'instruction', reservesTools: true })]) })
    renderTab()
    await user.click(await screen.findByText('Bank statement helper'))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText(/adds guidance only/i)).toBeInTheDocument()
    // An instruction stub does NOT claim it can use tools today (that ✓ line is kind:'tool' only).
    expect(dialog.queryByText('Use approved local tools when you ask')).not.toBeInTheDocument()
  })

  it('does not show the guidance-only note for a plain instruction skill', async () => {
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill({ kind: 'instruction', reservesTools: false })]) })
    renderTab()
    await user.click(await screen.findByText('Bank statement helper'))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText(/adds guidance only/i)).not.toBeInTheDocument()
  })

  // S11c: a kind:'tool' skill names its real tools (not the "arrive later" note) AND its permission
  // block gains the "Use approved local tools" line.
  it('shows the real-tools note + the approved-tools permission line for a kind:tool skill', async () => {
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill({ kind: 'tool', reservesTools: true })]) })
    renderTab()
    await user.click(await screen.findByText('Bank statement helper'))
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.queryByText(/adds guidance only/i)).not.toBeInTheDocument()
    // Generic (domain-free) active-tools note — applies to every kind:'tool' skill, not just bank.
    expect(dialog.getByText(/run approved local tools on a document you choose/i)).toBeInTheDocument()
    expect(dialog.getByText('Use approved local tools when you ask')).toBeInTheDocument()
  })
})

describe('SkillsTab — import preview (§15: permission summary before confirm)', () => {
  it('previews permissions then imports on confirm', async () => {
    const importSkill = vi.fn(async () => skill())
    const user = userEvent.setup()
    stubApi({
      listSkills: vi.fn(async () => []),
      pickSkillPackage: vi.fn(async () => '/tmp/new.skill.zip'),
      previewSkillPackage: vi.fn(async () => preview()),
      importSkill
    })
    renderTab()
    await screen.findByText('No skills yet')
    await user.click(screen.getByRole('button', { name: /Import a skill/ }))
    await user.click(await screen.findByRole('menuitem', { name: /From a file/ }))

    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('Add this skill?')).toBeInTheDocument()
    expect(dialog.getByText('This skill can:')).toBeInTheDocument()
    await user.click(dialog.getByRole('button', { name: 'Add skill' }))
    expect(importSkill).toHaveBeenCalledWith('/tmp/new.skill.zip')
  })

  // FE-2: pickSkillPackage now sits INSIDE pick()'s try, so a rejecting picker surfaces a
  // friendly toast instead of an unhandled promise rejection.
  it('shows a friendly toast (no unhandled rejection) when the skill picker rejects', async () => {
    const user = userEvent.setup()
    const pickSkillPackage = vi.fn(async () => {
      throw new Error('picker exploded')
    })
    stubApi({ listSkills: vi.fn(async () => []), pickSkillPackage: pickSkillPackage as never })
    renderTab()
    await screen.findByText('No skills yet')
    await user.click(screen.getByRole('button', { name: /Import a skill/ }))
    await user.click(await screen.findByRole('menuitem', { name: /From a file/ }))
    expect(await screen.findByText(/couldn.t be added/)).toBeInTheDocument()
  })

  it('blocks confirm on a dev-mode-gated downgrade (DS15)', async () => {
    const importSkill = vi.fn()
    const user = userEvent.setup()
    stubApi({
      listSkills: vi.fn(async () => []),
      pickSkillPackage: vi.fn(async () => '/tmp/old.skill.zip'),
      previewSkillPackage: vi.fn(async () =>
        preview({ collision: true, isDowngrade: true, downgradeBlocked: true, installedVersion: '2.0.0', version: '1.0.0' })
      ),
      importSkill
    })
    renderTab()
    await screen.findByText('No skills yet')
    await user.click(screen.getByRole('button', { name: /Import a skill/ }))
    await user.click(await screen.findByRole('menuitem', { name: /From a file/ }))

    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText(/needs developer mode/i)).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Add skill' })).toBeDisabled()
  })

  it('shows friendly structural errors and blocks confirm when the preview is not ok', async () => {
    const user = userEvent.setup()
    stubApi({
      listSkills: vi.fn(async () => []),
      pickSkillPackage: vi.fn(async () => '/tmp/bad.skill.zip'),
      previewSkillPackage: vi.fn(async () =>
        preview({ ok: false, errors: ['This skill package is missing its SKILL.md.'] })
      )
    })
    renderTab()
    await screen.findByText('No skills yet')
    await user.click(screen.getByRole('button', { name: /Import a skill/ }))
    await user.click(await screen.findByRole('menuitem', { name: /From a file/ }))

    const dialog = within(await screen.findByRole('dialog'))
    expect(dialog.getByText('This skill package is missing its SKILL.md.')).toBeInTheDocument()
    expect(dialog.getByRole('button', { name: 'Add skill' })).toBeDisabled()
  })
})

describe('SkillsTab — auto-fire opt-in (S13c/D4)', () => {
  it('reflects the saved off state and turns auto-fire on through the shared Settings patch', async () => {
    const user = userEvent.setup()
    const updateSettings = vi.fn(async (p: Partial<AppSettings>) => ({ ...DEFAULT_SETTINGS, ...p }))
    stubApi({
      listSkills: vi.fn(async () => [skill()]),
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillsAutoFireEnabled: false })),
      updateSettings: updateSettings as never
    })
    renderTab()
    const toggle = (await screen.findByRole('switch', {
      name: 'Apply a matching skill automatically'
    })) as HTMLInputElement
    expect(toggle).not.toBeChecked() // off by default — the safe-merge property
    await user.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({ skillsAutoFireEnabled: true })
  })

  it('reflects a saved on state', async () => {
    stubApi({
      listSkills: vi.fn(async () => [skill()]),
      getSettings: vi.fn(async () => ({ ...DEFAULT_SETTINGS, skillsAutoFireEnabled: true }))
    })
    renderTab()
    expect(
      await screen.findByRole('switch', { name: 'Apply a matching skill automatically' })
    ).toBeChecked()
  })

  it('hides the toggle when settings cannot be read (never implies an unconfirmed state)', async () => {
    stubApi({ listSkills: vi.fn(async () => [skill()]) }) // no getSettings stub ⇒ load fails silently
    renderTab()
    await screen.findByText('Bank statement helper')
    expect(
      screen.queryByRole('switch', { name: 'Apply a matching skill automatically' })
    ).not.toBeInTheDocument()
  })
})

describe('SkillsTab — delete', () => {
  it('confirms then deletes a user skill', async () => {
    const deleteSkill = vi.fn(async () => undefined)
    const user = userEvent.setup()
    stubApi({ listSkills: vi.fn(async () => [skill()]), deleteSkill })
    renderTab()
    await screen.findByText('Bank statement helper')
    await user.click(screen.getByRole('button', { name: 'Skill actions' }))
    await user.click(await screen.findByRole('menuitem', { name: 'Delete' }))
    await user.click(await screen.findByRole('button', { name: 'Delete' }))
    expect(deleteSkill).toHaveBeenCalledWith('user:bank-statement')
  })
})
