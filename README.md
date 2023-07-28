![MIT](https://img.shields.io/github/license/alienfast/find-monorepo-root?style=for-the-badge)
![Version](https://img.shields.io/github/package-json/v/alienfast/find-monorepo-root?style=for-the-badge)
![CI](https://img.shields.io/github/actions/workflow/status/alienfast/find-monorepo-root/release.yml?style=for-the-badge)
![PRs Welcome](https://img.shields.io/badge/PRs-Welcome-brightgreen.svg?style=for-the-badge)

# @alienfast/find-monorepo-root

Find the root directory of a monorepo using any of the following strategies:

- Lerna
- Yarn
- Bolt
- pnpm
- npm

## Install

```sh
yarn install @alienfast/find-monorepo-root
```

## Usage

### npx

For easy use in a shell script anywhere in your monorepo, execute with the `-y`

```sh
npx -y @alienfast/find-monorepo-root
# output: /Users/rosskevin/projects/archetype
```

or

```sh
#!/usr/bin/env bash

ROOT=`npx -y @alienfast/find-monorepo-root`

echo "My monorepo root is ${ROOT}"
```

### Api

```ts
import { findMonorepoRoot } from '@alienfast/find-monorepo-root'
const cwd = process.cwd()

console.log(await findMonorepoRoot(cwd))
// {
//   strategy: 'lerna', // 'bolt' | 'yarn' | 'pnpm' | 'lerna' | 'npm'
//   dir: '/Users/rosskevin/projects/archetype',     // the monorepo root directory
// }
```

## Contributing

PRs are accepted! This project is configured with `auto`, so feel free to submit a PR and `auto` will automatically create a `canary` release for you to try out.

## Prior art

This was originally forked from https://github.com/alienfast/find-monorepo-root because it a) did not work for me in it's current form; and b) I wanted to exec it simply with `npx`. Thanks to the original author and contributors.
