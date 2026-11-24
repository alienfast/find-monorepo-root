import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // tools/scripts has its own suite and config, run by `test-tools`.
    include: ['src/**/*.test.ts'],
  },
})
