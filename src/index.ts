import { findUp } from 'find-up'

import { Result } from './types'
import { findLerna, findPnpm, findYarn } from './util'

export async function findMonorepoRoot(cwd: string): Promise<Result> {
  let ret: Result | undefined

  await findUp(
    async (parent) => {
      ret = findLerna(parent) || findYarn(parent) || findPnpm(parent)
      return ret && ret.dir
    },
    { cwd, type: 'directory' },
  )

  if (!ret) {
    throw new Error(
      `No monorepo root could be found upwards from the directory ${cwd} using lerna, yarn, or pnpm as indicators.`,
    )
  }

  return ret
}
