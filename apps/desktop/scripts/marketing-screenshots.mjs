// Marketing screenshot matrix: every staged marketing shot (preview.tsx marketing block) in EN/DE
// and dark/light, at 2x, plus a manifest and a contact sheet for the visual check.
//
// Run: npm run screenshots:marketing                      (full matrix)
//      npm run screenshots:marketing -- home translate    (only these shots, all four variants)
//      flags: --out=<dir> (default screenshots/marketing), --scale=<n> (default 2)
//
// Steps: build the preview harness, capture with scripts/screenshot.mjs --strict (a shot whose
// staged walk never reached its goal fails the run instead of shipping a wrong image), then write
// manifest.json (shot, language, theme, size, app version, commit) and index.html (the contact
// sheet: one row per shot, the four variants side by side). Everything is fictional staged data;
// no workspace, model or network is involved. On a headless Linux box without DISPLAY the capture
// runs under xvfb-run when it is installed.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const desktop = resolve(here, '..')
const require = createRequire(import.meta.url)

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? hit.slice(name.length + 3) : fallback
}
const outDir = resolve(desktop, flag('out', 'screenshots/marketing'))
const scale = flag('scale', '2')
const shots = args.filter((a) => !a.startsWith('-'))
const VARIANTS = [
  { suffix: '', lang: 'en', theme: 'dark' },
  { suffix: '-de', lang: 'de', theme: 'dark' },
  { suffix: '-light', lang: 'en', theme: 'light' },
  { suffix: '-de-light', lang: 'de', theme: 'light' }
]

function run(cmd, cmdArgs, env = {}) {
  const r = spawnSync(cmd, cmdArgs, { cwd: desktop, stdio: 'inherit', env: { ...process.env, ...env } })
  if (r.error) throw r.error
  return r.status ?? 1
}
const onPath = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' }).status === 0

// 1. Build the harness.
if (run('npx', ['vite', 'build', '--config', 'vite.preview.config.ts', '--logLevel', 'warn']) !== 0) {
  console.error('marketing-screenshots: preview build failed')
  process.exit(1)
}

// 2. Capture into a clean output folder (only our own files are removed).
mkdirSync(outDir, { recursive: true })
for (const f of readdirSync(outDir)) {
  if (/^marketing-.*\.png$/.test(f) || f === 'manifest.json' || f === 'index.html') rmSync(resolve(outDir, f))
}
const cases = shots.length > 0 ? shots.flatMap((s) => VARIANTS.map((v) => `marketing-${s}${v.suffix}`)) : ['--marketing']
const electron = require('electron')
const shotArgs = ['--no-sandbox', 'scripts/screenshot.mjs', '--strict', `--out=${outDir}`, ...cases]
const env = { ELECTRON_DISABLE_SANDBOX: '1', ELECTRON_DISABLE_SECURITY_WARNINGS: '1', SHOT_SCALE: scale }
const headless = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY
const status = headless && onPath('xvfb-run') ? run('xvfb-run', ['-a', electron, ...shotArgs], env) : run(electron, shotArgs, env)

// 3. Manifest + contact sheet over whatever was captured (also on failure, to inspect it).
const pngSize = (file) => {
  const b = readFileSync(file)
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) }
}
const git = (...a) => spawnSync('git', a, { cwd: desktop, encoding: 'utf8' }).stdout.trim()
const entries = readdirSync(outDir)
  .filter((f) => /^marketing-.*\.png$/.test(f))
  .sort()
  .map((file) => {
    const segs = file.replace(/\.png$/, '').split('-')
    return {
      file,
      shot: segs[1],
      lang: segs.includes('de') ? 'de' : 'en',
      theme: segs.includes('light') ? 'light' : 'dark',
      ...pngSize(resolve(outDir, file))
    }
  })
const manifest = {
  generatedAt: new Date().toISOString(),
  appVersion: JSON.parse(readFileSync(resolve(desktop, 'package.json'), 'utf8')).version,
  commit: git('rev-parse', '--short', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  scale: Number(scale),
  images: entries
}
writeFileSync(resolve(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

const byShot = new Map()
for (const e of entries) byShot.set(e.shot, [...(byShot.get(e.shot) ?? []), e])
const cell = (shot, v) => {
  const e = byShot.get(shot)?.find((x) => x.lang === v.lang && x.theme === v.theme)
  return e
    ? `<figure><a href="${e.file}"><img src="${e.file}" loading="lazy" alt="${e.file}"></a><figcaption>${e.file} · ${e.width}×${e.height}</figcaption></figure>`
    : `<figure class="missing"><figcaption>missing: ${shot} ${v.lang} ${v.theme}</figcaption></figure>`
}
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marketing screenshots</title>
<style>
  body { margin: 0; padding: 24px; font: 14px/1.4 system-ui, sans-serif; background: #f4f5f7; color: #16181d; }
  h1 { font-size: 20px; margin: 0 0 4px; } p.meta { margin: 0 0 24px; color: #5b616e; }
  section { margin-bottom: 32px; } h2 { font-size: 16px; margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  figure { margin: 0; background: #fff; border: 1px solid #d9dce2; border-radius: 6px; padding: 6px; }
  figure.missing { display: grid; place-items: center; min-height: 120px; color: #b3261e; }
  img { width: 100%; height: auto; display: block; border-radius: 3px; }
  figcaption { font-size: 12px; color: #5b616e; margin-top: 4px; word-break: break-all; }
</style></head><body>
<h1>Marketing screenshots</h1>
<p class="meta">v${manifest.appVersion} · ${manifest.commit}${manifest.dirty ? ' (uncommitted changes)' : ''} · ${manifest.generatedAt} · ${entries.length} images · columns: EN dark, DE dark, EN light, DE light</p>
${[...byShot.keys()].map((shot) => `<section><h2>${shot}</h2><div class="row">${VARIANTS.map((v) => cell(shot, v)).join('')}</div></section>`).join('\n')}
</body></html>
`
writeFileSync(resolve(outDir, 'index.html'), html)
console.log(`marketing-screenshots: ${entries.length} images, manifest + contact sheet in ${outDir}`)
if (!existsSync(resolve(outDir, 'index.html')) || status !== 0) process.exit(status || 1)
