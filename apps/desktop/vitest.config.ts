import { resolve } from 'node:path'
import { defineConfig } from 'vitest/config'

// Default environment is node (the bulk of the suite tests main-process services). Renderer
// component tests opt into jsdom per-file with a `// @vitest-environment jsdom` docblock and
// pull in React Testing Library; the setup file registers @testing-library/jest-dom matchers.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer')
    }
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
    setupFiles: ['./tests/setup.ts'],
    globals: true,
    // The full parallel suite on a loaded machine starves the heavy integration/
    // renderer tests of CPU and trips vitest's 5 s default timeout (1–2 flakes per
    // run, a different test each time; all pass in isolation). 3× headroom absorbs
    // the scheduling, costs nothing when tests are fast, and — unlike capping
    // maxWorkers — leaves the wall time of a clean run unchanged.
    testTimeout: 15_000
  }
})
