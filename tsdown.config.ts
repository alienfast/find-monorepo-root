import { defineConfig } from 'tsdown'

export default defineConfig({
  dts: true,
  entry: ['src/index.ts', 'src/bin/findMonorepoRoot.ts'],
  format: ['esm'], // cjs can't be used for top level await
  sourcemap: true,
})
