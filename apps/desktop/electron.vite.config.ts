import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Electron-vite builds three targets: main process, preload, and renderer.
// The renderer is a normal Vite + React app rooted at src/renderer.
export default defineConfig({
  main: {
    build: {
      outDir: 'out/main',
      lib: { entry: resolve(__dirname, 'src/main/index.ts') }
    }
  },
  preload: {
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
