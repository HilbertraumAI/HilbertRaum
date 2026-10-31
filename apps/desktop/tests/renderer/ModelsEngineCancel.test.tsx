// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ModelsScreen } from '../../src/renderer/screens/ModelsScreen'
import { ENGINE_MISSING, engineJob, stubModelsApi } from '../helpers/model-fixtures'
import { assertNoUnexpectedApiCalls } from '../helpers/renderer'

// SH-1 (frontend audit 2026-08-09, #144): the engine download (multi-hundred-MB llama.cpp
// fetch) had NO Cancel — cancelEngineDownload was exposed on the bridge with zero callers.
// The live branch of the engine banner now carries a Cancel mirroring the model-download one.
//
// Isolated in its own file so ModelsScreen's module-level rememberedEngineJob starts fresh;
// the test drives the job to a terminal 'cancelled' state so nothing live leaks onward.

afterEach(() => {
  try {
    assertNoUnexpectedApiCalls()
  } finally {
    cleanup()
  }
})

describe('ModelsScreen — engine download Cancel (SH-1, #144)', () => {
  it('offers Cancel while the engine fetch is live and cancelling ends the job', async () => {
    const user = userEvent.setup()
    const live = engineJob()
    const cancelled = engineJob({ status: 'cancelled' })
    const downloadEngine = vi.fn(async () => live)
    const cancelEngineDownload = vi.fn(async () => cancelled)
    stubModelsApi({
      getEngineStatus: vi.fn(async () => ENGINE_MISSING),
      getEngineJob: vi.fn(async () => live),
      downloadEngine,
      cancelEngineDownload
    })
    render(<ModelsScreen />)

    // The demo-mode warning offers the install; starting it shows progress + Cancel.
    await user.click(await screen.findByRole('button', { name: 'Install AI engine' }))
    // Pre-fix TEETH: the live branch rendered ONLY the Progress — no Cancel existed anywhere.
    const cancelBtn = await screen.findByRole('button', { name: 'Cancel download' })
    await user.click(cancelBtn)
    expect(cancelEngineDownload).toHaveBeenCalledWith('e1')

    // The cancelled job leaves the live branch: the install affordance returns.
    expect(await screen.findByRole('button', { name: 'Install AI engine' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Cancel download' })).not.toBeInTheDocument()
  })
})
