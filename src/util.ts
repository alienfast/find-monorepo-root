import fs from 'node:fs'
import path from 'node:path'

import stripJsonComments from 'strip-json-comments'

import { Lerna, Pkg, Result } from './types'

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

export const findYarn = (dir: string): Result<'yarn' | 'bolt'> | undefined => {
  const pkg = readJson<Pkg>(dir, 'package.json')
  if (pkg) {
    if (pkg.workspaces || pkg.bolt) {
      return { client: pkg.bolt ? 'bolt' : 'yarn', dir }
    }
  }
  return undefined
}

export const findLerna = (dir: string): Result<'lerna'> | undefined => {
  const lerna = readJson<Lerna>(dir, 'lerna.json')
  // https://lerna.js.org/docs/api-reference/configuration
  if (lerna) {
    if (lerna.useWorkspaces || lerna.packages) {
      return { client: 'lerna', dir }
    }
  }
  return undefined
}

export const findPnpm = (dir: string): Result<'pnpm'> | undefined => {
  if (exists(dir, 'pnpm-workspace.yaml')) {
    return { client: 'pnpm', dir }
  }
  return undefined
}
