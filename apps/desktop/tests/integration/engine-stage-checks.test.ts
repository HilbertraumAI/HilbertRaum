import { afterEach, describe, expect, it, vi } from 'vitest'
// #998 round 1: what `stageEngineInstall` checks between the unpack and the marker. A scanner can take a fresh
// file at any moment: right after the member check, while the copy is hashed, while it is flushed. Each such
// copy must fail the stage (the installed engine stays) instead of being marked without the file, or with no
// map at all. The seams are the module's own calls: `lstat` and `open` (node:fs/promises) and `sha256File`
// (models.ts) call a row's hook once they have run. The extractor is a fake that writes the archive's files,
// so the archive itself (a real zip, which `archiveMembers` lists) never needs the OS tar.
const hooks = vi.hoisted(() => ({
  afterLstat: null as null | ((path: string) => void),
  afterOpen: null as null | ((path: string, flags: unknown) => void),
  beforeHash: null as null | ((path: string) => void)
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>()
  const mocked = {
    ...orig,
    lstat: async (...args: Parameters<typeof orig.lstat>) => {
      const result = await orig.lstat(...args)
      hooks.afterLstat?.(String(args[0]))
      return result
    },
    open: async (...args: Parameters<typeof orig.open>) => {
      const handle = await orig.open(...args)
      hooks.afterOpen?.(String(args[0]), args[1])
      return handle
    }
  }
  return { ...mocked, default: mocked }
})
vi.mock('../../src/main/services/models', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../../src/main/services/models')>()
  return {
    ...orig,
    sha256File: (...args: Parameters<typeof orig.sha256File>) => {
      hooks.beforeHash?.(String(args[0]))
      return orig.sha256File(...args)
    }
  }
})

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { hostRuntimeArch, hostRuntimeOs, stageEngineInstall, type ExtractFn } from '../../src/main/services/runtime-download'
import { planRuntimeDownload, runtimeMarkerPath, type RuntimeDownloadPlan } from '../../src/main/services/assets'
import { llamaServerBinaryName } from '../../src/main/services/runtime/sidecar'
import { tMain } from '../../src/main/services/i18n'
import { makeZip } from '../helpers/archives'

afterEach(() => {
  hooks.afterLstat = null
  hooks.afterOpen = null
  hooks.beforeHash = null
})

const BIN = llamaServerBinaryName()
const sha = (s: string): string => createHash('sha256').update(s).digest('hex')
const FILES: Record<string, string> = { [BIN]: 'server', 'ggml-vulkan.dll': 'vulkan', 'ggml-cpu-x64.dll': 'cpu' }

/** A plan whose verified archive (a zip listing `listed`) sits in the install folder, and its staging folder. */
function setup(listed: Record<string, string> = FILES): { plan: RuntimeDownloadPlan; staging: string } {
  const root = mkdtempSync(join(tmpdir(), 'hr-stage-checks-'))
  const plan = planRuntimeDownload(
    root,
    {
      os: hostRuntimeOs(),
      arch: hostRuntimeArch(),
      backend: 'vulkan',
      url: 'https://example.test/llama.zip',
      sha256: 'a'.repeat(64),
      extractTo: `runtime/llama.cpp/${hostRuntimeOs()}`
    },
    'b200'
  )
  mkdirSync(plan.extractTo, { recursive: true })
  writeFileSync(plan.zipDest, makeZip(Object.entries(listed).map(([name, data]) => ({ name, data: Buffer.from(data) }))))
  return { plan, staging: `${plan.extractTo}.new` }
}

/** An extractor that writes `files` into the folder (as tar would), then runs `after`. */
const writing =
  (files: Record<string, string>, after?: (dir: string) => Promise<void> | void): ExtractFn =>
  async (_archive, dir) => {
    for (const [name, data] of Object.entries(files)) {
      await mkdir(dirname(join(dir, name)), { recursive: true })
      await writeFile(join(dir, name), data)
    }
    await after?.(dir)
  }

const marker = (staging: string): { binaries?: Record<string, string> } =>
  JSON.parse(readFileSync(runtimeMarkerPath(staging), 'utf8')) as { binaries?: Record<string, string> }

describe('a file taken between the unpack and the marker fails the stage (#998 round 1)', () => {
  // Each window was open before round 1: the copy was marked without the file (it was simply not walked), or
  // with no map at all (a hash failure dropped it), and the swap's check then passed on the program alone.
  it.each([
    {
      window: 'right after its member check',
      arm: (staging: string) => {
        hooks.afterLstat = (p) => {
          if (p === join(staging, 'ggml-vulkan.dll')) {
            hooks.afterLstat = null
            rmSync(p)
          }
        }
      }
    },
    {
      window: 'while the copy is hashed',
      arm: (staging: string) => {
        hooks.beforeHash = (p) => {
          if (p.startsWith(staging)) {
            hooks.beforeHash = null
            rmSync(join(staging, 'ggml-vulkan.dll'))
          }
        }
      }
    },
    {
      window: 'while the copy is flushed, before the marker',
      arm: (staging: string) => {
        hooks.afterOpen = (p, flags) => {
          if (flags === 'r+' && p.startsWith(staging)) {
            hooks.afterOpen = null
            rmSync(join(staging, 'ggml-vulkan.dll'))
          }
        }
      }
    }
  ])('a listed DLL taken $window: the stage fails and nothing is marked', async ({ arm }) => {
    const { plan, staging } = setup()
    arm(staging)
    await expect(stageEngineInstall(plan, staging, { extract: writing(FILES) })).rejects.toThrow(tMain('main.engine.extractFailed'))
    expect(existsSync(runtimeMarkerPath(staging))).toBe(false)
  })

  // Control: with nothing taken, every listed file is recorded with its bytes.
  it('a whole copy records every listed file', async () => {
    const { plan, staging } = setup()
    await stageEngineInstall(plan, staging, { extract: writing(FILES) })
    expect(marker(staging).binaries).toEqual(Object.fromEntries(Object.entries(FILES).map(([k, v]) => [k, sha(v)])))
  })

  it('a folder where the archive lists a file fails the stage', async () => {
    const { plan, staging } = setup()
    const extract = writing({ [BIN]: 'server', 'ggml-cpu-x64.dll': 'cpu' }, (dir) => {
      mkdirSync(join(dir, 'ggml-vulkan.dll'))
    })
    const logs: string[] = []
    await expect(stageEngineInstall(plan, staging, { extract, log: (m) => logs.push(m) })).rejects.toThrow(tMain('main.engine.extractFailed'))
    // The member check itself refuses it, before anything is hashed.
    expect(logs).toContain('Engine extraction finished but files the archive lists are missing')
    expect(existsSync(runtimeMarkerPath(staging))).toBe(false)
  })
})

describe('what a marker never records (#998 round 1)', () => {
  // macOS bsdtar reads AppleDouble members back into extended attributes, so they never land on the disk
  // there: listed, they would fail every macOS install. A Finder `.DS_Store` is never an engine file either.
  it('macOS metadata the archive lists is not expected, and none on the disk is recorded', async () => {
    const { plan, staging } = setup({
      ...FILES,
      ['._' + BIN]: 'appledouble',
      [`__MACOSX/._${BIN}`]: 'appledouble',
      '.DS_Store': 'finder'
    })
    await stageEngineInstall(plan, staging, { extract: writing({ ...FILES, '.DS_Store': 'finder', '._ggml-cpu-x64.dll': 'x' }) })
    expect(Object.keys(marker(staging).binaries ?? {}).sort()).toEqual(Object.keys(FILES).sort())
  })

  // A link to a folder or a dangling link cannot be hashed; recording it used to drop the whole map. Windows
  // makes neither without a privilege, so junctions stand in there (Node reports a junction as a link).
  it('a link to a folder and a dangling link are not recorded, and the rest of the map stays', async () => {
    const { plan, staging } = setup({ [BIN]: 'server' })
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    const extract = writing({ [BIN]: 'server', 'backends/ggml-cpu.dll': 'cpu' }, (dir) => {
      symlinkSync(join(dir, 'backends'), join(dir, 'backends-link'), linkType)
      symlinkSync(join(dir, 'gone'), join(dir, 'dangling-link'), linkType)
    })
    const logs: string[] = []
    await stageEngineInstall(plan, staging, { extract, log: (m) => logs.push(m) })
    expect(marker(staging).binaries).toEqual({ [BIN]: sha('server'), 'backends/ggml-cpu.dll': sha('cpu') })
    expect(logs.filter((m) => m === 'A link in the engine copy that is not a file is not recorded')).toHaveLength(2)
  })
})
