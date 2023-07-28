<p>
<a href="/LICENSE"><img src="https://img.shields.io/github/license/alienfast/find-monorepo-root?style=flat-square" alt="MIT License"></a>
<a href="https://www.typescriptlang.org"><img alt="Language" src="https://img.shields.io/badge/language-TypeScript-blue.svg?style=flat-square"></a>
<a href="https://github.com/alienfast/find-monorepo-root/pulls"><img alt="PRs Welcome" src="https://img.shields.io/badge/PRs-Welcome-brightgreen.svg?style=flat-square"></a>
<a href="https://github.com/alienfast/find-monorepo-root/actions/workflows/release.yml"><img alt="build" src="https://img.shields.io/github/actions/workflow/status/alienfast/find-monorepo-root/release.yml?branch=main&logo=github&style=flat-square"></a>
</p>

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
//   client: 'lerna', // the monorepo client(pnpm, lerna, yarn, bolt)
//   dir: '/Users/rosskevin/projects/archetype',     // the monorepo root directory
// }
```

## Contributing

PRs are accepted! This project is configured with `auto`, so feel free to submit a PR and `auto` will automatically create a `canary` release for you to try out.

## Prior art

This was originally forked from https://github.com/alienfast/find-monorepo-root because it a) did not work for me in it's current form; and b) I wanted to exec it simply with `npx`. Thanks to the original author and contributors.
