import { describe, expect, it } from 'vitest'
import * as nodeFs from 'node:fs'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zimSmokeEnv } from '../helpers/zim-smoke-env'
import { kiwixManageBinaryName, kiwixServeBinaryName } from '../../src/main/services/zim/tools'
import { packUuid, writeZimFixture } from '../helpers/zim-header'

// The FAIL-CLOSED smoke-env contract (#301 P5, finding L8, plan §9.19 (d)): a pure function
// against a REAL temp dir — no mocked fs — so a genuine "not a directory" / "not a file" /
// "not a real ZIM header" check is exercised the way the manual harness would hit it.

function validToolsDir(platform: NodeJS.Platform): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-tools-'))
  writeFileSync(join(dir, kiwixServeBinaryName(platform)), 'x')
  writeFileSync(join(dir, kiwixManageBinaryName(platform)), 'x')
  return dir
}

function validZimFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-zim-'))
  return writeZimFixture(join(dir, 'a.zim'), packUuid('0000feed', 'smoke1'))
}

describe('zimSmokeEnv — unrequested', () => {
  it('is { requested: false } when HILBERTRAUM_ZIM_SMOKE is unset, empty, "0" or "false"', () => {
    for (const value of [undefined, '', '0', 'false']) {
      const env: NodeJS.ProcessEnv = value === undefined ? {} : { HILBERTRAUM_ZIM_SMOKE: value }
      expect(zimSmokeEnv(env, 'linux')).toEqual({ requested: false })
    }
  })

  it('ignores garbage in the other ZIM env vars when unrequested', () => {
    const env: NodeJS.ProcessEnv = {
      HILBERTRAUM_ZIM_TOOLS_DIR: '/does/not/exist',
      HILBERTRAUM_ZIM_FILE: '/does/not/exist.zim',
      HILBERTRAUM_ZIM_QUERY: ''
    }
    expect(zimSmokeEnv(env, 'linux')).toEqual({ requested: false })
  })
})

describe('zimSmokeEnv — requested, valid inputs', () => {
  it('reports zero problems for a fully valid configuration', () => {
    const toolsDir = validToolsDir('linux')
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'Treibhausgas'
      },
      'linux'
    )
    expect(gate).toEqual({
      requested: true,
      problems: [],
      toolsDir,
      zimFile,
      query: 'Treibhausgas',
      expectArticle: null
    })
  })

  it('carries HILBERTRAUM_ZIM_EXPECT_ARTICLE when set and non-blank', () => {
    const toolsDir = validToolsDir('linux')
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: 'yes',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'Treibhausgas',
        HILBERTRAUM_ZIM_EXPECT_ARTICLE: 'A/Alpha'
      },
      'linux'
    )
    expect(gate).toMatchObject({ requested: true, problems: [], expectArticle: 'A/Alpha' })
  })
})

describe('zimSmokeEnv — requested, invalid inputs (fail-closed, one named problem each)', () => {
  it('HILBERTRAUM_ZIM_TOOLS_DIR unset', () => {
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      { HILBERTRAUM_ZIM_SMOKE: '1', HILBERTRAUM_ZIM_FILE: zimFile, HILBERTRAUM_ZIM_QUERY: 'q' },
      'linux'
    )
    expect(gate.requested).toBe(true)
    expect((gate as { problems: string[] }).problems).toEqual(['HILBERTRAUM_ZIM_TOOLS_DIR is not set'])
  })

  it('HILBERTRAUM_ZIM_TOOLS_DIR not a directory', () => {
    const notADir = join(mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-')), 'file.txt')
    writeFileSync(notADir, 'x')
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: notADir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'linux'
    )
    expect((gate as { problems: string[] }).problems).toEqual(['HILBERTRAUM_ZIM_TOOLS_DIR is not a directory'])
  })

  it('HILBERTRAUM_ZIM_TOOLS_DIR missing one or both platform binaries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-empty-tools-'))
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: dir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'win32'
    )
    expect((gate as { problems: string[] }).problems).toEqual([
      'HILBERTRAUM_ZIM_TOOLS_DIR is missing kiwix-serve.exe',
      'HILBERTRAUM_ZIM_TOOLS_DIR is missing kiwix-manage.exe'
    ])
  })

  it('HILBERTRAUM_ZIM_FILE unset', () => {
    const toolsDir = validToolsDir('linux')
    const gate = zimSmokeEnv(
      { HILBERTRAUM_ZIM_SMOKE: '1', HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir, HILBERTRAUM_ZIM_QUERY: 'q' },
      'linux'
    )
    expect((gate as { problems: string[] }).problems).toEqual(['HILBERTRAUM_ZIM_FILE is not set'])
  })

  it('HILBERTRAUM_ZIM_FILE not a file (a directory)', () => {
    const toolsDir = validToolsDir('linux')
    const aDir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-notfile-'))
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: aDir,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'linux'
    )
    expect((gate as { problems: string[] }).problems).toEqual(['HILBERTRAUM_ZIM_FILE is not a file'])
  })

  it('HILBERTRAUM_ZIM_FILE fails readZimHeader (not a real ZIM)', () => {
    const toolsDir = validToolsDir('linux')
    const dir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-badzim-'))
    const notAZim = join(dir, 'not-a-zim.zim')
    writeFileSync(notAZim, 'this is not a zim archive header')
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: notAZim,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'linux'
    )
    expect((gate as { problems: string[] }).problems).toEqual([
      'HILBERTRAUM_ZIM_FILE failed the ZIM header check (readZimHeader rejected it)'
    ])
  })

  it('HILBERTRAUM_ZIM_QUERY unset or blank — no default', () => {
    const toolsDir = validToolsDir('linux')
    const zimFile = validZimFile()
    for (const query of [undefined, '', '   ']) {
      const env: NodeJS.ProcessEnv = {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: zimFile
      }
      if (query !== undefined) env.HILBERTRAUM_ZIM_QUERY = query
      const gate = zimSmokeEnv(env, 'linux')
      expect((gate as { problems: string[] }).problems).toEqual(['HILBERTRAUM_ZIM_QUERY is not set or blank'])
    }
  })

  it('never echoes the configured (invalid) values inside a problem message', () => {
    const SENTINEL = 'XSMOKEVALUE_SENTINEL_should_never_appear'
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: `/${SENTINEL}/tools`,
        HILBERTRAUM_ZIM_FILE: `/${SENTINEL}/file.zim`,
        HILBERTRAUM_ZIM_QUERY: ''
      },
      'linux'
    )
    expect((gate as { problems: string[] }).problems.join('\n')).not.toContain(SENTINEL)
  })

  it('reports every problem at once when everything is invalid', () => {
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: '/nope',
        HILBERTRAUM_ZIM_FILE: '/nope.zim',
        HILBERTRAUM_ZIM_QUERY: ''
      },
      'linux'
    )
    expect((gate as { problems: string[] }).problems).toEqual([
      'HILBERTRAUM_ZIM_TOOLS_DIR is not a directory',
      'HILBERTRAUM_ZIM_FILE is not a file',
      'HILBERTRAUM_ZIM_QUERY is not set or blank'
    ])
  })
})

describe('zimSmokeEnv — the platform parameter, injected not read', () => {
  it('checks for the win32 binary names when platform is win32, independent of the host', () => {
    const toolsDir = mkdtempSync(join(tmpdir(), 'hilbertraum-smoke-tools-'))
    writeFileSync(join(toolsDir, 'kiwix-serve'), 'x') // POSIX name only — wrong for win32
    writeFileSync(join(toolsDir, 'kiwix-manage'), 'x')
    const zimFile = validZimFile()
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'win32'
    )
    expect((gate as { problems: string[] }).problems).toEqual([
      'HILBERTRAUM_ZIM_TOOLS_DIR is missing kiwix-serve.exe',
      'HILBERTRAUM_ZIM_TOOLS_DIR is missing kiwix-manage.exe'
    ])
  })
})

describe('zimSmokeEnv — the fs seam', () => {
  it('accepts an injected fs implementation (mirrors production default of node:fs)', () => {
    const toolsDir = validToolsDir('linux')
    const zimFile = validZimFile()
    const calls: string[] = []
    const fs = {
      existsSync: (p: nodeFs.PathLike) => {
        calls.push(String(p))
        return nodeFs.existsSync(p)
      },
      statSync: nodeFs.statSync
    }
    const gate = zimSmokeEnv(
      {
        HILBERTRAUM_ZIM_SMOKE: '1',
        HILBERTRAUM_ZIM_TOOLS_DIR: toolsDir,
        HILBERTRAUM_ZIM_FILE: zimFile,
        HILBERTRAUM_ZIM_QUERY: 'q'
      },
      'linux',
      fs
    )
    expect(gate).toMatchObject({ requested: true, problems: [] })
    expect(calls.length).toBeGreaterThan(0)
  })
})
