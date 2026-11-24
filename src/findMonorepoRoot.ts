import { findUp } from 'find-up'

import type { Result } from './types.ts'
import { findByPackageManager, findLerna } from './util.ts'

export async function findMonorepoRoot(cwd: string): Promise<Result> {
  let ret: Result | undefined

  await findUp(
    async (parent) => {
      ret = findLerna(parent) || findByPackageManager(parent)
      return ret?.dir
    },
    { cwd, type: 'directory' },
  )

  if (!ret) {
    throw new Error(
      `No monorepo root could be found upwards from the directory ${cwd} using lerna, yarn, pnpm, or npm as indicators.`,
    )
  }

  return ret
}
