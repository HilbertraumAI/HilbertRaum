// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { ChatScreen } from '../../src/renderer/screens/ChatScreen'
import type { RuntimeStatus } from '../../src/shared/types'
import { stubApi } from '../helpers/renderer'

// #107: while a model start is in flight, the no-model panel shows HONEST load progress
// when an estimate exists — the model file size over the measured effective read speed
// (#108) — instead of the indeterminate "starting" line. The estimate is presented as
// approximate ("about {pct}%") and the bar caps below 100%. Without a measured read
// speed (fresh install), the plain indeterminate line stays: no data, no claim.

function startingStatus(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    running: false,
    modelId: null,
    port: null,
    healthy: false,
    message: 'Starting',
    startingModelId: 'qwen3-9b',
    ...over
  }
}

function setup(status: RuntimeStatus): void {
  stubApi({
    listConversations: vi.fn(async () => []),
    listMessages: vi.fn(async () => []),
    listActiveStreamConversations: vi.fn(async () => []),
    getActiveStream: vi.fn(async () => null),
    getRuntimeStatus: vi.fn(async () => status),
    onScopeNotice: vi.fn(() => () => {})
  })
  render(<ChatScreen onNavigate={() => {}} />)
}

beforeAll(() => {
  // jsdom has no scrollTo; the transcript autoscroll calls it on mount.
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

describe('ChatScreen — honest model-load progress (#107)', () => {
  it('shows the approximate progress line + a determinate bar when an estimate exists', async () => {
    // 6.0 GB at ~70 MB/s ⇒ expected ≈ 85.7 s; 30 s elapsed ⇒ about 35%.
    setup(
      startingStatus({
        starting: { elapsedMs: 30_000, bytesTotal: 6_000_000_000, expectedMs: 85_700 }
      })
    )

    const line = await screen.findByText(/reading the model file \(6\.0 GB\), about 35% so far/)
    expect(line).toBeInTheDocument()
    const bar = document.querySelector('progress')
    expect(bar).not.toBeNull()
    expect(bar!.getAttribute('value')).toBe('35')
  })

  it('caps the displayed progress at 97% — an estimate never claims completion', async () => {
    setup(
      startingStatus({
        starting: { elapsedMs: 500_000, bytesTotal: 6_000_000_000, expectedMs: 85_700 }
      })
    )
    await screen.findByText(/about 97% so far/)
  })

  it('keeps the plain indeterminate line when no read-speed estimate exists (fresh install)', async () => {
    setup(startingStatus({ starting: { elapsedMs: 30_000, bytesTotal: 6_000_000_000 } }))

    const line = await screen.findByText(/Your model is starting — large models take a little/)
    expect(line).toBeInTheDocument()
    expect(screen.queryByText(/about \d+% so far/)).not.toBeInTheDocument()
  })
})
