import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findMonorepoRoot } from './findMonorepoRoot.js'

const cwd = path.join(process.cwd(), 'test/workspaces')
const packages = ['package-a', 'package-b', 'package-c']
const scenarios = [
  'pnpm',
  'yarn',
  'yarn-lock',
  'yarn-packageManager',
  'npm',
  'bolt',
  'lerna',
  'lerna-sub-yarn-packageManager',
]

describe('findMonorepoRoot', () => {
  describe('should find root', () => {
    scenarios.forEach((scenario) => {
      describe(`using scenario ${scenario}`, () => {
        const strategy = scenario.includes('-') ? scenario.split('-')[0] : scenario
        for (const pkg of packages) {
          it(`from subdirectory ${strategy}/packages/${pkg}`, async () => {
            const root = path.join(cwd, strategy)

            const result = await findMonorepoRoot(path.join(root, 'packages', pkg))
            expect(result.strategy).toBe(strategy)
            expect(result.dir).toBe(root)
          })
        }

        it(`from .`, async () => {
          const root = path.join(cwd, strategy)

          const result = await findMonorepoRoot(root)
          expect(result.strategy).toBe(strategy)
          expect(result.dir).toBe(root)
        })

        it(`from non-package root subdirectory '${strategy}/packages/package-a/scripts'`, async () => {
          const root = path.join(cwd, strategy)

          const result = await findMonorepoRoot(path.join(root, 'packages', 'package-a', 'scripts'))
          expect(result.strategy).toBe(strategy)
          expect(result.dir).toBe(root)
        })

        it(`from non-package root from subdirectory '${strategy}/scripts'`, async () => {
          const root = path.join(cwd, strategy)

          const result = await findMonorepoRoot(path.join(root, 'scripts'))
          expect(result.strategy).toBe(strategy)
          expect(result.dir).toBe(root)
        })
      })
    })
  })

  it(`should throw error when no match is found`, async () => {
    const root = path.join(cwd, 'noMatch')
    const find = async () => {
      return findMonorepoRoot(path.join(root, 'packages', 'package-a'))
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    expect(find).rejects.toThrowError(/No monorepo root could be found upwards/)
  })

  it('should throw error when package.json is broken', async () => {
    const find = async () => {
      return findMonorepoRoot(path.join(cwd, 'bad'))
    }
    // eslint-disable-next-line @typescript-eslint/no-floating-promises
    expect(find).rejects.toThrowError(/SyntaxError: Unexpected token a in JSON/)
  })
})
