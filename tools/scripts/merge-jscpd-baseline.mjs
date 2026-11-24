#!/usr/bin/env node
// Git merge driver for the committed jscpd clone baseline (`.jscpd-baseline.json`), registered as `merge=jscpd-baseline` in .gitattributes.
//
// Every issue that consolidates a clone regenerates this file, and the fingerprint keys are hashes, so the removals two branches make land on
// unrelated lines that are often adjacent: a plain line-based three-way merge of two such branches conflicts far more often than not. The file is a
// set of fingerprints with a pair count each, so it merges as one: per key, with an absent key counting as 0, the merged count is
// `ours + theirs - base`, and the key is kept when that is positive. A removal on either side drops the key, an addition on either side keeps it,
// and two sides that both changed a count combine by delta.
//
// That equals regenerating from the merged tree when the two sides change disjoint clone groups. Otherwise a count map cannot know what the merged tree
// holds, so the merge can leave a count short, which turns the `check-clones` lane red on the merged tree (`node .claude/rules/check-clones.mjs --update`
// there), or stale, which leaves the lane green and the baseline over-allowing until an `--update` drops it (run one on the integration branch after a
// batch of merges).
//
// A side that does not parse, does not have the baseline shape, or disagrees on `version` is not guessed at: the driver leaves %A conflicted and exits 1.
// Where `git merge-file` finds a textual conflict, %A is its output; where it finds none, %A is both sides wrapped whole in one marker block, so the file
// still cannot parse as a baseline. An internal failure takes the same path where it can; where it cannot, it exits 2 with %A untouched.
//
// Node builtins only, and `node` rather than `tsx`, for the reason merge-generated-schema.mjs gives: a merge driver runs from IDEs and hooks where
// nothing but the bare runtime is guaranteed.

import { spawnSync } from 'node:child_process'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'

const DRIVER_NAME = 'merge-jscpd-baseline'
const DEFAULT_MARKER_SIZE = 7
const MAX_BUFFER = 256 * 1024 * 1024
const FINGERPRINT_RE = /^[0-9a-f]{16}$/

class Refusal extends Error {}

// A baseline is exactly `{version, fingerprints}`. Anything looser is a file this driver was not written for.
function parseBaseline(text, side) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Refusal(`${side} is not valid JSON (${error.message})`)
  }
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  if (!isObject(parsed) || !Number.isInteger(parsed.version) || !isObject(parsed.fingerprints)) {
    throw new Refusal(`${side} is not a { version, fingerprints } baseline`)
  }
  if (Object.keys(parsed).length !== 2) {
    throw new Refusal(`${side} carries top-level keys beyond version and fingerprints`)
  }
  const fingerprints = new Map()
  for (const [key, count] of Object.entries(parsed.fingerprints)) {
    if (!FINGERPRINT_RE.test(key) || !Number.isSafeInteger(count) || count < 1) {
      throw new Refusal(`${side} has a malformed fingerprint entry: ${JSON.stringify(key)}`)
    }
    fingerprints.set(key, count)
  }
  return { fingerprints, version: parsed.version }
}

// git hands %O as a readable temp file, empty when the file was added on both sides: an empty set that constrains no version. A read error is not that
// case, and treating it as one would double every count the two sides share, so it propagates as an internal error.
function readBase(basePath) {
  const text = readFileSync(basePath, 'utf8')
  return text.trim() === ''
    ? { fingerprints: new Map(), version: undefined }
    : parseBaseline(text, 'base')
}

function mergeBaselines(base, ours, theirs) {
  const versions = [base.version, ours.version, theirs.version].filter(
    (version) => version !== undefined,
  )
  if (new Set(versions).size !== 1) {
    throw new Refusal(`the sides disagree on the baseline version (${versions.join(', ')})`)
  }
  const merged = {}
  const keys = [
    ...new Set([
      ...base.fingerprints.keys(),
      ...ours.fingerprints.keys(),
      ...theirs.fingerprints.keys(),
    ]),
  ].sort()
  for (const key of keys) {
    const count =
      (ours.fingerprints.get(key) ?? 0) +
      (theirs.fingerprints.get(key) ?? 0) -
      (base.fingerprints.get(key) ?? 0)
    if (count > 0) merged[key] = count
  }
  // jscpd writes `version` before `fingerprints`. Spelled as entries because Biome sorts the keys of an object literal alphabetically.
  const document = Object.fromEntries([
    ['version', versions[0]],
    ['fingerprints', merged],
  ])
  return `${JSON.stringify(document, null, 2)}\n`
}

// Never leaves a partial %A: the content lands in a sibling file first, and the rename is the only step that touches %A.
function replaceFile(targetPath, content) {
  const staged = `${targetPath}.${DRIVER_NAME}.${process.pid}`
  try {
    writeFileSync(staged, content)
    renameSync(staged, targetPath)
  } catch (error) {
    rmSync(staged, { force: true })
    throw error
  }
}

// Both sides, each ending in a newline, inside one marker block.
function wholeFileConflict({ markerSize, oursPath, theirsPath }) {
  const marker = (char, label) => Buffer.from(`${char.repeat(markerSize)}${label}\n`)
  const side = (sidePath) => {
    const content = readFileSync(sidePath)
    return content.length === 0 || content.at(-1) === 0x0a
      ? content
      : Buffer.concat([content, Buffer.from('\n')])
  }
  return Buffer.concat([
    marker('<', ' ours'),
    side(oursPath),
    marker('=', ''),
    side(theirsPath),
    marker('>', ' theirs'),
  ])
}

// `git merge-file` takes (current, base, other), not the (%O %A %B) order git hands a driver.
function writeConflict(paths) {
  const { basePath, markerSize, oursPath, theirsPath } = paths
  const merge = spawnSync(
    'git',
    [
      'merge-file',
      '-p',
      '--no-diff3',
      '--no-zdiff3',
      `--marker-size=${markerSize}`,
      '-L',
      'ours',
      '-L',
      'base',
      '-L',
      'theirs',
      oursPath,
      basePath,
      theirsPath,
    ],
    { maxBuffer: MAX_BUFFER },
  )
  // Exit codes up to 127 are the conflict count; 128 and above (or no exit at all) means stdout is not a merge result.
  if (merge.error || merge.status === null || merge.status >= 128) {
    throw new Error(
      `\`git merge-file\` failed: ${merge.error?.message ?? merge.stderr?.toString('utf8').trim() ?? `signal ${merge.signal}`}`,
    )
  }
  // Exit 0 is a clean textual merge of sides the driver refused: its output would carry no marker and could parse as a baseline.
  replaceFile(oursPath, merge.status === 0 ? wholeFileConflict(paths) : merge.stdout)
}

function main() {
  const [basePath, oursPath, theirsPath, markerSizeArg, pathname] = process.argv.slice(2)
  if (!basePath || !oursPath || !theirsPath) {
    console.error(
      `${DRIVER_NAME}: expected at least three paths (%O %A %B), got ${process.argv.slice(2).length} argument(s) — check the \`merge.jscpd-baseline.driver\` registration in the root package.json \`prepare\` script.`,
    )
    process.exit(2)
  }
  const parsedMarkerSize = Number.parseInt(markerSizeArg ?? '', 10)
  const markerSize =
    Number.isInteger(parsedMarkerSize) && parsedMarkerSize > 0
      ? parsedMarkerSize
      : DEFAULT_MARKER_SIZE
  const paths = { basePath, markerSize, oursPath, theirsPath }

  let merged
  try {
    merged = mergeBaselines(
      readBase(basePath),
      parseBaseline(readFileSync(oursPath, 'utf8'), 'ours'),
      parseBaseline(readFileSync(theirsPath, 'utf8'), 'theirs'),
    )
  } catch (error) {
    // A Refusal is the inputs' fault; anything else is this script's. Both degrade to a conflicted file that cannot parse as a baseline.
    const reason =
      error instanceof Refusal
        ? error.message
        : `internal error: ${error instanceof Error ? error.message : String(error)}`
    writeConflict(paths)
    console.error(
      `${DRIVER_NAME}: ${pathname || oursPath}: ${reason}. Left as a git conflict — take either side and regenerate with \`node .claude/rules/check-clones.mjs --update\`.`,
    )
    process.exit(1)
  }
  replaceFile(oursPath, merged)
  process.exit(0)
}

try {
  main()
} catch (error) {
  console.error(`${DRIVER_NAME}: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(2)
}
