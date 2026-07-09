// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { SkillInfoCard } from '../../src/renderer/chat'
import { I18nProvider } from '../../src/renderer/i18n'
import type { SkillInfo } from '../../src/shared/types'

// #46 — the compact skill info card: an APP skill renders its catalog what/needs/limits lines
// (`shared/skill-info.ts`); a user/unknown skill falls back to its own description (the app never
// invents honesty claims about content it didn't author). Pure + props-driven (the SkillRunBar
// test precedent).

function withI18n(ui: React.ReactElement): React.ReactElement {
  return <I18nProvider>{ui}</I18nProvider>
}

function skill(over: Partial<SkillInfo> = {}): SkillInfo {
  return {
    installId: 'app:document-edit',
    id: 'document-edit',
    title: 'Document Edit',
    description: 'Use when the user wants to make targeted find-and-replace edits to a document.',
    version: '1.0.0',
    kind: 'tool',
    author: 'HilbertRaum',
    language: 'en',
    source: 'app',
    trustedLevel: 'app',
    enabled: true,
    warningAck: true,
    unavailable: false,
    permissions: { documents: 'selected_only', network: 'denied', filesystem: 'skill_resources_only' },
    permissionSummary: 'x',
    duplicateId: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over
  }
}

afterEach(cleanup)

describe('SkillInfoCard (#46)', () => {
  it('renders the catalog what/needs/limits lines for an app skill', () => {
    render(withI18n(<SkillInfoCard skill={skill()} onClose={vi.fn()} />))
    expect(screen.getByText('Document Edit')).toBeInTheDocument()
    // what — states the never-rewrites promise up front.
    expect(screen.getByText(/never rewrites your document/)).toBeInTheDocument()
    // needs — names the actual run button and where it appears (the #44 confusion said up front).
    expect(screen.getByText('Needs:')).toBeInTheDocument()
    expect(screen.getByText(/“Apply text edits” button appears just above the message box/)).toBeInTheDocument()
    // limits — the #45 output-format cliff, stated at selection time.
    expect(screen.getByText('Keep in mind:')).toBeInTheDocument()
    expect(screen.getByText(/Word keeps \.docx, other formats save as \.txt/)).toBeInTheDocument()
    // The pick-lifetime footer line.
    expect(screen.getByText(/Applies to your questions in this chat/)).toBeInTheDocument()
  })

  it('falls back to the skill’s own description for a non-catalog (user) skill', () => {
    render(
      withI18n(
        <SkillInfoCard
          skill={skill({ installId: 'user:my-skill', id: 'my-skill', title: 'My skill', description: 'Does my thing.', source: 'user', trustedLevel: 'user' })}
          onClose={vi.fn()}
        />
      )
    )
    expect(screen.getByText('Does my thing.')).toBeInTheDocument()
    // No invented catalog lines for content the app didn't author.
    expect(screen.queryByText('Needs:')).not.toBeInTheDocument()
    expect(screen.queryByText('Keep in mind:')).not.toBeInTheDocument()
  })

  it('close and Learn more fire their handlers', async () => {
    const onClose = vi.fn()
    const onLearnMore = vi.fn()
    const user = userEvent.setup()
    render(withI18n(<SkillInfoCard skill={skill()} onClose={onClose} onLearnMore={onLearnMore} />))
    await user.click(screen.getByRole('button', { name: 'Learn more' }))
    expect(onLearnMore).toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Hide this explanation' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('omits the Learn more link when no handler is wired', () => {
    render(withI18n(<SkillInfoCard skill={skill()} onClose={vi.fn()} />))
    expect(screen.queryByRole('button', { name: 'Learn more' })).not.toBeInTheDocument()
  })
})
