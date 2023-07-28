export type Client = 'bolt' | 'yarn' | 'pnpm' | 'lerna'

export interface Result<T extends Client = Client> {
  client: T
  dir: string
}

export interface Lerna {
  useWorkspaces?: boolean
  packages?: string[]
}

export interface Pkg {
  workspaces?: any
  bolt?: any
}
