import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { findMonorepoRoot } from './index.js'

const cwd = path.join(process.cwd(), 'test/workspaces')
const packages = ['package-a', 'package-b', 'package-c']
const clients = ['pnpm', 'yarn', 'bolt', 'lerna']

describe('findMonorepoRoot', () => {
  clients.forEach((client) => {
    for (const pkg of packages) {
      it(`should find root using ${client} from ${pkg}`, async () => {
        const root = path.join(cwd, client)

        const result = await findMonorepoRoot(path.join(root, 'packages', pkg))
        expect(result.client).toBe(client)
        expect(result.dir).toBe(root)
      })
    }

    it(`should find root from non-package root using ${client} from 'package-a/scripts'`, async () => {
      const root = path.join(cwd, client)

      const result = await findMonorepoRoot(path.join(root, 'packages', 'package-a', 'scripts'))
      expect(result.client).toBe(client)
      expect(result.dir).toBe(root)
    })

    it(`should find root from non-package root using ${client} from 'scripts'`, async () => {
      const root = path.join(cwd, client)

      const result = await findMonorepoRoot(path.join(root, 'scripts'))
      expect(result.client).toBe(client)
      expect(result.dir).toBe(root)
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
