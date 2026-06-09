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
      lib: { entry: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      lib: { entry: resolve(__dirname, 'src/preload/index.ts') }
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
        input: resolve(__dirname, 'src/renderer/index.html')
      }
    },
    plugins: [react()]
  }
})
