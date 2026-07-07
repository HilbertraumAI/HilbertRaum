import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

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
    plugins: [react()]
  }
})
