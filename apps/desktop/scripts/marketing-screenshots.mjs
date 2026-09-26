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
// sheet: one row per shot, filterable by language and theme, with a full-size viewer that steps
// through the filtered images). Everything is fictional staged data;
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
    ? `<figure data-lang="${e.lang}" data-theme="${e.theme}"><a href="${e.file}" data-file="${e.file}" data-caption="${shot} · ${e.lang.toUpperCase()} · ${e.theme} · ${e.width}×${e.height}"><img src="${e.file}" loading="lazy" alt="${e.file}"></a><figcaption>${e.file} · ${e.width}×${e.height}</figcaption></figure>`
    : `<figure class="missing" data-lang="${v.lang}" data-theme="${v.theme}"><figcaption>missing: ${shot} ${v.lang} ${v.theme}</figcaption></figure>`
}
const seg = (name, options) =>
  `<div class="seg" role="group" aria-label="${name}">${options
    .map(([value, label]) => `<button type="button" data-filter="${name}" data-value="${value}" aria-pressed="${value === 'all'}">${label}</button>`)
    .join('')}</div>`
// The contact sheet: filters for language and theme (kept in the URL query, so a filtered view can
// be bookmarked or shared), and a viewer that opens a screenshot full size and steps through the
// CURRENTLY FILTERED images with the side buttons or the arrow keys (Esc closes).
const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Marketing screenshots</title>
<style>
  body { margin: 0; padding: 24px; font: 14px/1.4 system-ui, sans-serif; background: #f4f5f7; color: #16181d; }
  h1 { font-size: 20px; margin: 0 0 4px; } p.meta { margin: 0 0 16px; color: #5b616e; }
  .filters { display: flex; flex-wrap: wrap; gap: 16px; align-items: center; margin-bottom: 24px; position: sticky; top: 0; padding: 10px 0; background: #f4f5f7; z-index: 1; }
  .seg { display: inline-flex; border: 1px solid #c9cdd5; border-radius: 8px; overflow: hidden; background: #fff; }
  .seg button { border: 0; background: none; padding: 6px 14px; font: inherit; cursor: pointer; color: #3b404a; }
  .seg button + button { border-left: 1px solid #c9cdd5; }
  .seg button[aria-pressed="true"] { background: #1b7f5f; color: #fff; }
  .count { color: #5b616e; }
  section { margin-bottom: 32px; } h2 { font-size: 16px; margin: 0 0 8px; }
  .row { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; }
  figure { margin: 0; background: #fff; border: 1px solid #d9dce2; border-radius: 6px; padding: 6px; }
  figure.missing { display: grid; place-items: center; min-height: 120px; color: #b3261e; }
  figure[hidden], section[hidden] { display: none; }
  img { width: 100%; height: auto; display: block; border-radius: 3px; }
  figcaption { font-size: 12px; color: #5b616e; margin-top: 4px; word-break: break-all; }
  .viewer { position: fixed; inset: 0; background: #0b0d11; display: none; z-index: 10; }
  .viewer.open { display: grid; grid-template-columns: 64px 1fr 64px; grid-template-rows: 1fr auto; }
  .viewer img { grid-column: 2; grid-row: 1; max-width: 100%; max-height: calc(100vh - 64px); margin: auto; width: auto; border-radius: 4px; }
  .viewer .nav { grid-row: 1; align-self: center; justify-self: center; width: 48px; height: 48px; border-radius: 50%; border: 0; font-size: 28px; line-height: 1; cursor: pointer; background: rgba(255, 255, 255, 0.14); color: #fff; }
  .viewer .nav:hover { background: rgba(255, 255, 255, 0.28); }
  .viewer .prev { grid-column: 1; } .viewer .next { grid-column: 3; }
  .viewer .bar { grid-column: 1 / -1; grid-row: 2; display: flex; justify-content: center; gap: 16px; align-items: center; color: #d6d9df; padding: 12px; }
  .viewer .bar a { color: #8fd9bd; }
  .viewer .close { position: absolute; top: 12px; right: 16px; border: 0; background: none; color: #fff; font-size: 30px; cursor: pointer; }
</style></head><body>
<h1>Marketing screenshots</h1>
<p class="meta">v${manifest.appVersion} · ${manifest.commit}${manifest.dirty ? ' (uncommitted changes)' : ''} · ${manifest.generatedAt} · ${entries.length} images</p>
<div class="filters">
  ${seg('lang', [['all', 'All languages'], ['en', 'EN'], ['de', 'DE']])}
  ${seg('theme', [['all', 'All themes'], ['dark', 'Dark'], ['light', 'Light']])}
  <span class="count" id="count"></span>
</div>
${[...byShot.keys()].map((shot) => `<section><h2>${shot}</h2><div class="row">${VARIANTS.map((v) => cell(shot, v)).join('')}</div></section>`).join('\n')}
<div class="viewer" id="viewer" role="dialog" aria-modal="true" aria-label="Screenshot viewer">
  <button type="button" class="nav prev" id="prev" aria-label="Previous screenshot">‹</button>
  <img id="viewer-img" alt="">
  <button type="button" class="nav next" id="next" aria-label="Next screenshot">›</button>
  <div class="bar"><span id="viewer-caption"></span><span id="viewer-pos"></span><a id="viewer-open" target="_blank" rel="noopener">open file</a></div>
  <button type="button" class="close" id="close" aria-label="Close">×</button>
</div>
<script>
  const state = { lang: 'all', theme: 'all' }
  const q = new URLSearchParams(location.search)
  for (const k of ['lang', 'theme']) if (q.get(k)) state[k] = q.get(k)
  const figures = [...document.querySelectorAll('figure')]
  function apply() {
    for (const f of figures) f.hidden = (state.lang !== 'all' && f.dataset.lang !== state.lang) || (state.theme !== 'all' && f.dataset.theme !== state.theme)
    for (const s of document.querySelectorAll('section')) s.hidden = !s.querySelector('figure:not([hidden])')
    for (const b of document.querySelectorAll('[data-filter]')) b.setAttribute('aria-pressed', String(state[b.dataset.filter] === b.dataset.value))
    document.getElementById('count').textContent = visible().length + ' shown'
    const p = new URLSearchParams()
    for (const k of ['lang', 'theme']) if (state[k] !== 'all') p.set(k, state[k])
    history.replaceState(null, '', p.toString() ? '?' + p : location.pathname)
  }
  const visible = () => [...document.querySelectorAll('figure:not([hidden]) a[data-file]')]
  for (const b of document.querySelectorAll('[data-filter]')) b.addEventListener('click', () => { state[b.dataset.filter] = b.dataset.value; apply() })
  const viewer = document.getElementById('viewer')
  let index = -1
  function show(i) {
    const list = visible()
    if (list.length === 0) return close()
    index = (i + list.length) % list.length
    const a = list[index]
    // The link's href is the one path (a copy of the sheet that moves the PNGs rewrites only src/href).
    const file = a.getAttribute('href')
    document.getElementById('viewer-img').src = file
    document.getElementById('viewer-img').alt = file
    document.getElementById('viewer-caption').textContent = a.dataset.caption
    document.getElementById('viewer-pos').textContent = (index + 1) + ' / ' + list.length
    document.getElementById('viewer-open').href = file
    viewer.classList.add('open')
    document.body.style.overflow = 'hidden'
  }
  function close() { viewer.classList.remove('open'); document.body.style.overflow = ''; index = -1 }
  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[data-file]')
    if (!a || viewer.contains(a)) return
    e.preventDefault()
    show(visible().indexOf(a))
  })
  document.getElementById('prev').addEventListener('click', () => show(index - 1))
  document.getElementById('next').addEventListener('click', () => show(index + 1))
  document.getElementById('close').addEventListener('click', close)
  viewer.addEventListener('click', (e) => { if (e.target === viewer) close() })
  document.addEventListener('keydown', (e) => {
    if (!viewer.classList.contains('open')) return
    if (e.key === 'ArrowLeft') show(index - 1)
    else if (e.key === 'ArrowRight') show(index + 1)
    else if (e.key === 'Escape') close()
  })
  apply()
</script>
</body></html>
`
writeFileSync(resolve(outDir, 'index.html'), html)
console.log(`marketing-screenshots: ${entries.length} images, manifest + contact sheet in ${outDir}`)
if (!existsSync(resolve(outDir, 'index.html')) || status !== 0) process.exit(status || 1)
