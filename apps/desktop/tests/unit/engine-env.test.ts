import { describe, it, expect } from 'vitest'
import { dirname, join } from 'node:path'
import { engineChildEnv } from '../../src/main/services/runtime/engine-env'

// #730: a llama.cpp child must not see the host's llama.cpp variables or config files. llama.cpp reads
// config files (located through PROGRAMDATA / APPDATA / XDG_CONFIG_HOME), then the environment, then the
// command line, so anything the app does not pass on the command line came from the host.

const BIN = join('/drive', 'runtime', 'llama.cpp', 'linux', 'llama-server')

describe('engineChildEnv (#730)', () => {
  it.each([
    ['LLAMA_ARG_RPC', 'host:50052'],
    ['LLAMA_ARG_CONNECT', '1'],
    ['llama_arg_hf_repo', 'some/repo'], // Windows variable names are case-insensitive
    ['LLAMA_API_KEY', 'inherited'],
    ['HF_TOKEN', 'secret'],
    ['MTMD_BACKEND_DEVICE', 'Vulkan0']
  ])('drops the inherited %s', (name, value) => {
    expect(engineChildEnv(BIN, {}, { [name]: value, PATH: '/usr/bin' })).not.toHaveProperty(name)
  })

  it('keeps the rest of the environment, the GGML driver switches included', () => {
    const env = engineChildEnv(BIN, {}, { PATH: '/usr/bin', HOME: '/home/u', GGML_VK_VISIBLE_DEVICES: '0' })
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/u', GGML_VK_VISIBLE_DEVICES: '0' })
  })

  // The target sits below the binary FILE: a path that can never exist, so nothing can be planted or written there.
  it.each([
    ['win32', ['APPDATA', 'PROGRAMDATA'], 'XDG_CONFIG_HOME'],
    ['linux', ['XDG_CONFIG_HOME'], 'APPDATA'],
    ['darwin', ['XDG_CONFIG_HOME'], 'APPDATA']
  ] as const)('on %s points the config lookup %j below the engine binary, leaving %s alone', (platform, redirected, untouched) => {
    const host = { ProgramData: 'C:\\ProgramData', AppData: 'C:\\Users\\u\\AppData\\Roaming', XDG_CONFIG_HOME: '/home/u/.config' }
    const env = engineChildEnv(BIN, {}, host, platform)
    for (const name of redirected) {
      // Windows variable names are case-insensitive: the host's `ProgramData` / `AppData` must not survive beside the redirect.
      expect(Object.keys(env).filter((n) => n.toUpperCase() === name)).toEqual([name])
      expect(dirname(env[name]!)).toBe(BIN)
    }
    const kept = Object.entries(host).find(([n]) => n.toUpperCase() === untouched)!
    expect(env[kept[0]]).toBe(kept[1])
  })

  it('adds the child’s own variables after the filter, and leaves the parent untouched', () => {
    const parent = { LLAMA_API_KEY: 'inherited', LLAMA_ARG_RPC: 'host:50052', PATH: '/usr/bin' }
    const env = engineChildEnv(BIN, { LLAMA_API_KEY: 'per-spawn' }, parent)
    expect(env.LLAMA_API_KEY).toBe('per-spawn')
    expect(parent).toEqual({ LLAMA_API_KEY: 'inherited', LLAMA_ARG_RPC: 'host:50052', PATH: '/usr/bin' })
  })
})
