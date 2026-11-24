#!/usr/bin/env node

import * as process from 'node:process'

import { findMonorepoRoot } from '../index.ts'

const result = await findMonorepoRoot(process.cwd())
console.log(result.dir)
