import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { $ } from 'execa'

const $$ = $({ stdio: 'inherit' })

console.log('Resetting...')

const dir = dirname(fileURLToPath(import.meta.url))

await Promise.all([$$`node ${dir}/clean.js`, $$`node ${dir}/clean-pnpm.js`])

console.log('Installing...')
await $$`pnpm install`
