import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'

// L18 (audit-2026-06-13): @napi-rs/canvas is an OPTIONAL transitive dep of pdfjs-dist —
// a platform-specific native `.node` (Skia) the app never imports. With
// `includeSubNodeModules: true`, electron-builder would otherwise follow the hoisted
// dependency tree and bundle the win32 `.node` into app.asar, breaking the pure-JS /
// cross-OS portable posture (a Windows binary shipped on a macOS/Linux drive). The
// exclusion is invisible until release packaging, so guard it here in the green gate.

const BUILDER_YML = join(__dirname, '..', '..', 'electron-builder.yml')

interface BuilderConfig {
  files?: string[]
  asarUnpack?: string[]
  includeSubNodeModules?: boolean
}

function loadBuilderConfig(): BuilderConfig {
  return parse(readFileSync(BUILDER_YML, 'utf8')) as BuilderConfig
}

describe('electron-builder packaging excludes the @napi-rs/canvas native binary (L18)', () => {
  it('has a files glob that negates every @napi-rs/canvas variant', () => {
    const cfg = loadBuilderConfig()
    expect(Array.isArray(cfg.files)).toBe(true)
    const files = cfg.files ?? []

    // The exclusion must be a negation glob ("!...") that matches the canvas package
    // and all its per-platform siblings (@napi-rs/canvas-win32-x64-msvc, -darwin-*, …).
    const exclusion = files.find(
      (f) => f.startsWith('!') && /@napi-rs\/canvas/.test(f)
    )
    expect(exclusion, 'expected a "!**/@napi-rs/canvas*/**"-style exclusion in files').toBeTruthy()
    expect(exclusion).toContain('@napi-rs/canvas')
    // A trailing `*` after `canvas` so the platform-suffixed packages are caught too.
    expect(exclusion).toMatch(/@napi-rs\/canvas\*/)
  })

  it('the exclusion glob actually matches the platform-specific native package paths', () => {
    const cfg = loadBuilderConfig()
    const exclusion = (cfg.files ?? []).find(
      (f) => f.startsWith('!') && /@napi-rs\/canvas/.test(f)
    )!
    // Translate the (minimatch-style) glob to a coarse RegExp and prove it covers the
    // real hoisted paths electron-builder would walk.
    const body = exclusion.slice(1) // drop the leading "!"
    const rx = new RegExp(
      '^' +
        body
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          // `**/` matches zero or more leading path segments (minimatch globstar)…
          .replace(/\*\*\//g, '(?:.*/)?')
          // …a bare `**` matches anything…
          .replace(/\*\*/g, '.*')
          // …and a single `*` matches within one segment.
          .replace(/(?<!\.)\*/g, '[^/]*') +
        '$'
    )
    for (const p of [
      'node_modules/@napi-rs/canvas/index.js',
      'node_modules/@napi-rs/canvas-win32-x64-msvc/skia.win32-x64-msvc.node',
      'node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node',
      'apps/desktop/node_modules/@napi-rs/canvas-linux-x64-gnu/skia.linux-x64-gnu.node'
    ]) {
      expect(rx.test(p), `exclusion should match ${p}`).toBe(true)
    }
  })
})
