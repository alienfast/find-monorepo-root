export type Strategy = 'bolt' | 'yarn' | 'pnpm' | 'lerna' | 'npm'

export interface Result<T extends Strategy = Strategy> {
  strategy: T
  dir: string
}

export interface Lerna {
  useWorkspaces?: boolean
  packages?: string[]
}

export interface Package {
  name: string
  workspaces?: any
  bolt?: any
  packageManager?: string
}
