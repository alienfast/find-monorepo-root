import fs from 'node:fs'
import path from 'node:path'

import stripJsonComments from 'strip-json-comments'

import { Lerna, Package, Result, Strategy } from './types'

export const exists = (dir: string, file: string) => fs.existsSync(path.join(dir, file))

export function readJson<T>(dir: string, file: string) {
  if (!exists(dir, file)) {
    return undefined
  }

  const filePath = path.join(dir, file)
  try {
    return JSON.parse(stripJsonComments(fs.readFileSync(filePath, 'utf8'))) as T
  } catch (e) {
    throw new Error(`${e}. Error reading ${filePath}`)
  }
}

const determinePackageManager = (pkg: Package, dir: string): Strategy | undefined => {
  // in order to run the tests, we need to exclude our own package dir
  if (process.env.NODE_ENV === 'test' && pkg.name === '@alienfast/find-monorepo-root') {
    return undefined
  }
  // sub-packages may have packageManager specified (e.g. setup for docker image build). We only want a yarn package with workspaces
  if (pkg.packageManager && pkg.packageManager.includes('yarn') && pkg.workspaces) {
    return 'yarn'
  } else if (pkg.bolt) {
    return 'bolt'
  } else if (exists(dir, 'pnpm-workspace.yaml')) {
    return 'pnpm'
  } else if (exists(dir, 'yarn.lock')) {
    return 'yarn'
  } else if (exists(dir, 'package-lock.json')) {
    return 'npm'
  } else if (pkg.workspaces) {
    return 'yarn' // this could be true for npm as well, but we'll assume yarn and rely on lock file detection to capture npm
  }

  // throw new Error(`Could not determine package manager from ${dir}: ${JSON.stringify(pkg)}`)
  return undefined
}

export const findByPackageManager = (dir: string): Result<Strategy> | undefined => {
  const pkg = readJson<Package>(dir, 'package.json')
  if (!pkg) {
    return undefined
  }

  const strategy = determinePackageManager(pkg, dir)
  if (!strategy) {
    return undefined
  }
  return { strategy, dir }
}

export const findLerna = (dir: string): Result<'lerna'> | undefined => {
  const lerna = readJson<Lerna>(dir, 'lerna.json')
  // https://lerna.js.org/docs/api-reference/configuration
  if (lerna) {
    if (lerna.useWorkspaces || lerna.packages) {
      return { strategy: 'lerna', dir }
    }
  }
  return undefined
}
