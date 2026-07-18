import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'
import { buildMetaCsp } from './src/main/window-security'

// BE-2 (ocr-audit 2026-07-18, OCR-R P5): the CSP <meta> tags in index.html/ocr.html are
// generated from ONE source of truth — window-security.ts `buildMetaCsp(isDev, page)` —
// instead of being hand-maintained. The checked-in HTML carries the DEV policy (Vite HMR
// needs ws://localhost:* in connect-src); without this transform that localhost
// relaxation shipped verbatim into packaged builds, where the meta is the renderer's
// defence-in-depth CSP layer beside the onHeadersReceived header (which — measured on a
// packaged Windows build 2026-07-18 — does attach and enforce on file://; see
// docs/security-model.md). Dev serves the dev policy, `electron-vite build` bakes the
// strict prod policy; tests/integration/csp-build-output.test.ts pins the built output.
function cspMetaPlugin(): Plugin {
  let isDevServe = false
  return {
    name: 'hilbertraum:csp-meta',
    configResolved(config) {
      isDevServe = config.command === 'serve'
    },
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const page = /[\\/]ocr\.html$/.test(ctx.filename) ? 'ocr' : 'index'
        const replaced = html.replace(
          /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/,
          (_m, open: string, close: string) => `${open}${buildMetaCsp(isDevServe, page)}${close}`
        )
        if (replaced === html) {
          // Fail the build loudly — a silently missing tag would ship whatever the
          // checked-in HTML says (the exact drift this transform exists to prevent).
          throw new Error(`csp-meta transform: no CSP meta tag found in ${ctx.filename}`)
        }
        return replaced
      }
    }
  }
}

// Electron-vite builds three targets: main process, preload, and renderer.
// The renderer is a normal Vite + React app rooted at src/renderer.
//
// `externalizeDepsPlugin` keeps `dependencies` (yaml + the Phase 4 parser libs
// pdfjs-dist / mammoth / papaparse) OUT of the main/preload bundles — they are
// require()'d from node_modules at runtime. This avoids fragile bundling of pdfjs's
// large ESM build (BUILD_STATE R3) and is the idiomatic electron-vite setup.
export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') },
      // Emit the main bundle as ESM (out/main/index.mjs). The preload stays CJS —
      // sandboxed preloads (webPreferences.sandbox:true) cannot be ES modules — so we
      // scope `format: 'es'` to main only and DON'T set package "type": "module".
      rollupOptions: { output: { format: 'es' } }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: {
        entry: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          // The hidden OCR rasterizer window's tiny bridge (Phase 38, D31) — a
          // separate entry so that window never sees the app API.
          ocr: resolve(__dirname, 'src/preload/ocr.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'src/shared'),
        '@renderer': resolve(__dirname, 'src/renderer')
      }
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // Hidden OCR rasterizer page (Phase 38): bundles pdfjs + its worker locally
          // — the sentinel test proves no CDN host ever enters these bundles.
          ocr: resolve(__dirname, 'src/renderer/ocr.html')
        }
      }
    },
    plugins: [react(), cspMetaPlugin()]
  }
})
