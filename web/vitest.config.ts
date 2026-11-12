import { defineConfig } from 'vitest/config'

// A separate config from vite.config.ts: the TanStack Start and Nitro plugins
// build an app, and these tests only exercise pure helpers in src/lib.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
