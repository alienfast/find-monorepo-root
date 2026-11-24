import { $ } from 'execa'
import { rimraf as r } from 'rimraf'

console.log('Cleaning pnpm...')

await Promise.all([r('node_modules'), r('pnpm-lock.yaml')])
await $`pnpm store prune`
