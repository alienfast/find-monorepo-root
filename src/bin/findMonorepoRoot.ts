#!/usr/bin/env node

import * as process from 'node:process'

import { findMonorepoRoot } from '..'

const result = await findMonorepoRoot(process.cwd())
// eslint-disable-next-line no-console
console.log(result.dir)
