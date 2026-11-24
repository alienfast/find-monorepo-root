import { rimraf as r } from 'rimraf'

console.log('Cleaning...')

await Promise.all([
  r('dist'),
  r('node_modules/.cache'),
  r('node_modules/.vite-temp'),
  r('*.log', { glob: true }),
  r('*.tsbuildinfo', { glob: true }),
  r('test-results'),
  r('test-report.xml'),
])
