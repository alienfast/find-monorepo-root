export type Client = 'bolt' | 'yarn' | 'pnpm' | 'lerna' | 'npm'

export interface Result<T extends Client = Client> {
  client: T
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
