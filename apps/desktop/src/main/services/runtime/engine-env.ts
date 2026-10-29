// The environment of every llama.cpp program the app starts (#730). llama.cpp reads its options from
// config files first (`%PROGRAMDATA%\llama.cpp\config.ini` and `%APPDATA%\llama.cpp\config.ini` on
// Windows; `/etc/llama.cpp/config.ini` and `${XDG_CONFIG_HOME:-~/.config}/llama.cpp/config.ini`
// elsewhere, since b11146), then from about 150 environment variables, then from the command line. The
// command line wins, but every option the app does not pass came from the host computer: a llama.cpp
// user's own config file or `LLAMA_ARG_*` variable moved the chat model off the GPU (measured), and the
// same route reaches `--rpc`, the download options, the server tools and, from v0.8.0, `--connect`.
//
// So each child gets the parent's environment without the variables llama.cpp reads, and the variables
// its config lookup starts from point BELOW the engine binary itself. A file has no children, so that
// path can never exist, nothing can plant a config there, and nothing in the child can write there.
// Both b11146 and b11960 only test the path with `exists()`. `GGML_*` stays: those are the backend's own
// switches (device visibility, driver workarounds), and none of them reaches the network. The fixed
// `/etc/llama.cpp/config.ini` on Linux and macOS cannot be redirected (security-model.md, #730).

import { join } from 'node:path'

/** The variables llama.cpp's argument parser reads: `LLAMA_ARG_*`, `LLAMA_API_KEY`, `HF_TOKEN`, `MTMD_BACKEND_DEVICE`. */
const ENGINE_VARIABLE = /^(?:LLAMA_|HF_|MTMD_)/i

/**
 * Where llama.cpp's config lookup starts on each OS. Redirected, not removed: without
 * `XDG_CONFIG_HOME` it falls back to `~/.config`.
 */
function configLocations(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? ['PROGRAMDATA', 'APPDATA'] : ['XDG_CONFIG_HOME']
}

/**
 * The environment for a llama.cpp child started from `binPath`: `parent` without the variables
 * llama.cpp reads, the config lookup pointed at a path that cannot exist, then `own` (the sidecar's
 * per-spawn `LLAMA_API_KEY`). Never mutates `parent`.
 */
export function engineChildEnv(
  binPath: string,
  own: Record<string, string> = {},
  parent: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const locations = configLocations(platform)
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(parent)) {
    // Windows variable names are case-insensitive: `Llama_Arg_Rpc` and `ProgramData` count too.
    if (ENGINE_VARIABLE.test(name) || locations.includes(name.toUpperCase())) continue
    env[name] = value
  }
  for (const name of locations) env[name] = join(binPath, 'no-config')
  return { ...env, ...own }
}
