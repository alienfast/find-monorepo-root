import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findMonorepoRoot } from './index.js'

const cwd = path.join(process.cwd(), 'test/workspaces')
const packages = ['package-a', 'package-b', 'package-c']
const scenarios = ['pnpm', 'yarn', 'yarn-lock', 'yarn-packageManager', 'npm', 'bolt', 'lerna']

describe('findMonorepoRoot', () => {
  describe('should find root', () => {
    scenarios.forEach((scenario) => {
      describe(`using scenario ${scenario}`, () => {
        const client = scenario.includes('-') ? scenario.split('-')[0] : scenario
        for (const pkg of packages) {
          it(`from subdirectory ${client}/packages/${pkg}`, async () => {
            const root = path.join(cwd, client)

            const result = await findMonorepoRoot(path.join(root, 'packages', pkg))
            expect(result.client).toBe(client)
            expect(result.dir).toBe(root)
          })
        }

        it(`from .`, async () => {
          const root = path.join(cwd, client)

          const result = await findMonorepoRoot(root)
          expect(result.client).toBe(client)
          expect(result.dir).toBe(root)
        })

        it(`from non-package root subdirectory '${client}/packages/package-a/scripts'`, async () => {
          const root = path.join(cwd, client)

          const result = await findMonorepoRoot(path.join(root, 'packages', 'package-a', 'scripts'))
          expect(result.client).toBe(client)
          expect(result.dir).toBe(root)
        })

        it(`from non-package root from subdirectory '${client}/scripts'`, async () => {
          const root = path.join(cwd, client)

          const result = await findMonorepoRoot(path.join(root, 'scripts'))
          expect(result.client).toBe(client)
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
