#!/usr/bin/env node
// Gate new code clones of 10+ lines against a committed baseline of content fingerprints.
//
// Nothing else in `pnpm check` notices a session copying a sibling file: the copy typechecks, lints and passes every test it duplicates. jscpd finds
// the clone; this lane makes a NEW one fail. `.jscpd-baseline.json` records a content fingerprint (a hash of the cloned tokens, never a path) for every
// clone the tree already carries, so the gate is keyed on what a block says and not where it lives: an unrelated edit near a recorded clone cannot turn it
// red, and renaming or moving one of the two files that hold it stays green. Each fingerprint also records how many clone pairs shared it, so a further
// copy of an already-baselined block is new too: it makes one more pair than recorded.
//
// Green: a rename, move or deletion of a copy. A block carried by three or more files is where the fingerprints alone are not enough: jscpd pairs every
// copy with the lowest-sorting file holding it, and pairs the later copies as sub-ranges, so when that file is deleted, or a rename puts another file
// first, the surviving copies re-pair under fingerprints the baseline never recorded. jscpd reports those pairs as new although nothing was copied. The
// lane therefore asks git what this change touched. A fingerprint jscpd reports as new is a RE-PAIRING, and accepted, when every pair carrying that
// fingerprint holds two files unchanged against the base: nothing in them can be a new copy. The verdict is per fingerprint and not per pair because
// when a recorded fingerprint gains a pair jscpd flags the last pair of that fingerprint in its report, which need not be a pair holding the new file.
//
// Red: a copy of 10+ lines of a clone-free block, a further copy of a recorded block, an edit inside a recorded copy, and an edit anywhere in a file
// whose copy re-paired. Each puts a file that is added or edited against the base into a fingerprint group, whatever pair jscpd flags. The red lists
// the group's pairs holding such a file, so it names the copy and the file it duplicates. Consolidate onto the existing code, or record a deliberate,
// reviewed copy with `--update`.
//
// "Changed" means added, edited, retyped, renamed with an edit, or untracked, committed or not. A renamed file with unchanged content is unchanged,
// whether the rename is committed, staged, or a plain `mv` git has not seen yet. The classification is built from the unchanged side and fails closed:
// a path is unchanged only when git lists it as a tracked file the diff against the BASE does not report, or when it is a plain move matched to a
// deleted file's content. Every other path jscpd names is changed, whatever the reason git does not vouch for it (a spelling git folds, a file git
// ignores, a file in a nested repository, a tracked file marked assume-unchanged or skip-worktree). The BASE is the branch this change will merge into:
// the fork branch a `/start wt` worktree records in `start.source-branch`, else the default branch (`origin/HEAD`, else a local `main`, else
// `origin/main`). CI here is the release workflow, which runs no `pnpm check`: `pnpm check` on the developer's machine is the whole gate, so there is
// no pull-request or previous-build base to resolve. Upstream's copy of this file (basefund's `.claude/rules/check-clones.mjs`) carries that resolution
// for CircleCI, should a CI gate ever be added here.
//
// The merge base of HEAD and that branch is the comparison point. When no base resolves (no history, no branch to compare with), or when jscpd's
// SARIF report that carries the fingerprints cannot be lined up with its JSON report, the lane runs UNFILTERED, exactly as before the filter: every
// pair jscpd reports as new is red, and the output says why the run could not classify.
//
// The verdict depends on the base, and the difference runs both ways. A worktree judged against its fork branch can be green where the merged
// tree, judged against a broader base, is red because two branches' changes combine there; regenerate the baseline on the merged tree. A run judged
// against a fork branch whose local ref is behind counts changes the merge will not carry and can be red where the merged tree is green. Accepted
// false greens, by name:
//
//   (a) A rename, move or deletion forces no recording, so the counts of the fingerprints the tree no longer holds (the deleted copy's pairs, or pairs
//       the survivors left when they re-paired under new fingerprints) stay in the baseline until the next `--update`, and a copy of that block
//       passes while the dead count covers it, whether it lands in the same change as the rename, move or deletion or in a later one. A green run warns
//       when recorded counts exceed what the tree holds, and when it accepted re-pairings it also lists, as a note, every other pair that holds a file
//       changed since the base and shares a file with an accepted pair: such a pair passes only on counts the re-pairing or a deletion freed.
//   (b) A fresh pair already present on the base is accepted on every branch off it, because its files are unchanged there — and on a pushed `main`
//       itself nothing is changed against the base, so a copy that reaches `main` unrecorded is never red again anywhere: the green run lists it
//       among the accepted re-pairings and names `--update`, which is the moment to read that list.
//
// Regenerate the baseline, after consolidating onto the existing code is ruled out and the copy is deliberate and reviewed:
//
//     node .claude/rules/check-clones.mjs --update
//
// then commit the baseline diff. `--update` records whatever is on disk, uncommitted files included, and first prints each clone pair it records that the
// committed baseline lacked, labelled a re-pairing (every file unchanged against the base) or a new copy; that list is what a reviewer reads, since the
// diff is bare hashes. The baseline file's shape and its `merge=jscpd-baseline` driver are the same either way. Fingerprints are over the tokens
// as written, so formatting changes them: run `pnpm check-biome` before `--update`, and read a clone red that appears only on a second run as Biome,
// which runs beside this lane in `pnpm check`, having formatted a copy into a match. A jscpd version bump can re-key every fingerprint: a red listing a
// large share of the tree's clones on a change that moves jscpd's version is a re-keyed baseline, regenerated with `--update` in the same change.
//
// Scope lives in `.jscpd.json`, which the self-test copies verbatim into its scratch tree so the fixtures are judged by the configuration the real scan
// uses. jscpd matches both an `ignore` glob and the `pattern` anywhere in a path, not from the repository
// root: a directory named `tmp`, `dist` or `generated` at any depth is skipped, and `foo/src/x.ts` matches the pattern, which is why
// `.claude/worktrees/**` is ignored explicitly. The scan runs from the repository root with a single path, because with several path arguments jscpd
// names a file relative to its own argument (`bin/…` for `src/bin/…`), which is ambiguous across roots. `--absolute` is no alternative: the
// ignore globs then match the absolute path, and a checkout under `.claude/worktrees/` matches `.claude/worktrees/**` and scans nothing.
//
// A report-only sweep for near-miss clones (functions of similar structure, not identical tokens) is outside the gate and takes no baseline; run from the
// repository root it exits 0 and prints every clone it finds, near-miss pairs included, then a per-format totals table:
//
//     pnpm exec jscpd --config .jscpd.json --similarity --reporters console
//
// Lives at the path upstream's copy has (basefund's `.claude/rules/check-clones.mjs`): the merge driver's conflict message, the rule text and
// `UPDATE_COMMAND` all spell it, and the two files are meant to stay diffable — this one drops upstream's CircleCI base resolution and its Ruby
// formats, and plants its self-test fixtures under this repository's scan roots (src/, tools/).
//
// The self-test plants its fixtures in a throwaway directory rather than committing them: a committed planted copy inside a scanned tree would redden
// this lane forever. It injects the change classification instead of asking git, so it runs no git and no network.

import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CHECK_NAME = 'clone check'
const SCRIPT_REL = '.claude/rules/check-clones.mjs'
const UPDATE_COMMAND = `node ${SCRIPT_REL} --update`
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const CONFIG_REL = '.jscpd.json'
const BASELINE_REL = '.jscpd-baseline.json'
const SARIF_REL = 'jscpd-report.sarif'
const HASH_KEY = 'jscpdCloneHash/v1'
const MAX_LISTED = 40
const MAX_BUFFER = 256 * 1024 * 1024

const result = (code, out = '', err = '') => ({ code, err, out })
const red = (message) => result(1, '', `✗ ${CHECK_NAME}: ${message}\n`)
const indent = (text) =>
  text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')

const NO_BASE = { unfiltered: 'no base was resolved' }
const short = (sha) => sha.slice(0, 9)

function withScratch(prefix, fn) {
  const scratch = join(ROOT, 'tmp')
  mkdirSync(scratch, { recursive: true })
  const dir = mkdtempSync(join(scratch, prefix))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { force: true, recursive: true })
  }
}

// Resolved from the installed package, as check-anchors.mjs does for markdownlint; the wrapper picks the platform binary from the installed
// `jscpd-<platform>` optional dependency.
function locateJscpd() {
  // Resolution walks up past ROOT, so a worktree with no install of its own would otherwise run the enclosing checkout's jscpd, whose version can
  // key fingerprints differently.
  if (!existsSync(join(ROOT, 'node_modules', 'jscpd', 'package.json'))) {
    return {
      error: `jscpd is not installed under ${ROOT}/node_modules — run \`pnpm install\` first`,
    }
  }
  let pkgPath
  try {
    pkgPath = createRequire(join(ROOT, 'package.json')).resolve('jscpd/package.json')
  } catch {
    return {
      error: `jscpd is not installed under ${ROOT}/node_modules — run \`pnpm install\` first`,
    }
  }
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
  const bin = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.jscpd
  if (!bin)
    return {
      error: `${pkgPath} declares no jscpd bin — the package layout changed; update locateJscpd() in ${SCRIPT_REL}`,
    }
  return { path: join(dirname(pkgPath), bin) }
}

function spawnJscpd(root, args, node) {
  const bin = locateJscpd()
  if (bin.error) return { error: bin.error }
  const spawned = spawnSync(node, [bin.path, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  })
  if (spawned.error) return { error: `could not run jscpd: ${spawned.error.message}` }
  return {
    diagnostics: `${spawned.stdout}\n${spawned.stderr}`.trim(),
    ended: spawned.signal ? `was killed by ${spawned.signal}` : `exited ${spawned.status}`,
    status: spawned.status,
  }
}

function readMinLines(root) {
  try {
    const { minLines } = JSON.parse(readFileSync(join(root, CONFIG_REL), 'utf8'))
    if (!Number.isInteger(minLines)) return { error: `${CONFIG_REL} sets no integer minLines` }
    return { minLines }
  } catch (err) {
    return { error: `could not read ${CONFIG_REL}: ${err.message}` }
  }
}

// stdout, or undefined when git fails or outlives `timeout`.
function git({ root, env, args, input, timeout }) {
  const spawned = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    env,
    input,
    maxBuffer: MAX_BUFFER,
    timeout,
  })
  if (spawned.error || spawned.status !== 0) return undefined
  return spawned.stdout
}

const mergeBase = (ctx, rev) =>
  git({ ...ctx, args: ['merge-base', 'HEAD', rev] })?.trim() || undefined

function mergeBaseOfAny(ctx, refs) {
  for (const ref of refs) {
    const sha = mergeBase(ctx, ref)
    if (sha) return { ref, sha }
  }
  return undefined
}

const validBranch = (name) =>
  typeof name === 'string' && name !== '' && !name.startsWith('-') && !/\s/u.test(name)

function resolveLocalBase({ ctx }) {
  const fork = git({
    ...ctx,
    args: ['config', '--worktree', '--get', 'start.source-branch'],
  })?.trim()
  if (fork && validBranch(fork)) {
    const hit = mergeBaseOfAny(ctx, [`refs/heads/${fork}`, `refs/remotes/origin/${fork}`])
    if (hit) return { label: `fork branch ${fork}`, sha: hit.sha }
  }
  const remoteHead = git({
    ...ctx,
    args: ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'],
  })?.trim()
  const hit = mergeBaseOfAny(
    ctx,
    [remoteHead, 'refs/heads/main', 'refs/remotes/origin/main'].filter(Boolean),
  )
  if (hit)
    return {
      label: `default branch ${hit.ref.replace(/^refs\/(?:heads|remotes\/origin)\//u, '')}`,
      sha: hit.sha,
    }
  return {
    unfiltered:
      'no fork branch (start.source-branch) and no default branch (origin/HEAD, main) shares history with HEAD',
  }
}

// The commit this change will merge onto: `{ label, sha }`, or `{ unfiltered: '<reason>' }` when none resolves.
export function resolveBase({ root, env = process.env }) {
  return resolveLocalBase({ ctx: { env, root } })
}

// Which paths of today's tree are unchanged against the base: `{ label, unchanged: Set<repo-relative path> }`, or the base's `{ unfiltered }` passed
// through. A path is unchanged only when git vouches for it: it is a tracked file the diff of the working tree against the base does not list (or lists
// as the destination of an exact (R100) rename), or it is an untracked regular file with the content of a deleted file git left unpaired (a move not
// yet staged; matched one to one, so a second copy is changed). Anything else a caller asks about is changed, so a path git does not know under the
// spelling jscpd reports can never read as unchanged.
export function changesAgainst({ root, base, env = process.env }) {
  if (base.unfiltered !== undefined) return { unfiltered: base.unfiltered }
  const ctx = { env, root }
  const diff = git({
    ...ctx,
    args: [
      'diff',
      '--raw',
      '-z',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      // Full object names: an unpaired deletion is matched to an untracked file by blob hash.
      '--no-abbrev',
      '-M100%',
      base.sha,
      '--',
    ],
  })
  const untracked = git({ ...ctx, args: ['ls-files', '--others', '--exclude-standard', '-z'] })
  // `-v` tags each entry: `H` is a tracked file git checks, and every other tag (`h` assume-unchanged, `S` skip-worktree, `M` unmerged) is a path whose
  // working-tree edits the diff above may not report.
  const tracked = git({ ...ctx, args: ['ls-files', '-v', '-z'] })
  if (diff === undefined || untracked === undefined || tracked === undefined) {
    return { unfiltered: `git could not list the changes since ${short(base.sha)}` }
  }

  const changed = new Set()
  const removedBlobs = []
  const tokens = diff.split('\0')
  for (let i = 0; i < tokens.length; ) {
    if (!tokens[i].startsWith(':')) {
      i += 1
      continue
    }
    const [, , oldBlob, , status] = tokens[i].slice(1).split(' ')
    if (status.startsWith('R') || status.startsWith('C')) {
      if (status !== 'R100') changed.add(tokens[i + 2])
      i += 3
    } else {
      if (status.startsWith('D')) removedBlobs.push(oldBlob)
      else changed.add(tokens[i + 1])
      i += 2
    }
  }

  const unchanged = new Set()
  for (const entry of tracked.split('\0')) {
    if (entry.startsWith('H ') && !changed.has(entry.slice(2))) unchanged.add(entry.slice(2))
  }

  // Only a regular file can be the destination of a move, and hash-object reads newline-separated paths: a symlink (dangling or not), a directory (a
  // nested repository is listed as one), a path gone since the listing and a path holding a newline are never matched, and stay changed.
  const isRegularFile = (path) => {
    try {
      return lstatSync(join(root, path)).isFile()
    } catch {
      return false
    }
  }
  const paths = untracked.split('\0').filter(Boolean).sort()
  const candidates =
    removedBlobs.length > 0
      ? paths.filter((path) => !path.includes('\n') && isRegularFile(path))
      : []
  if (candidates.length > 0) {
    const hashed = git({
      ...ctx,
      args: ['hash-object', '--stdin-paths'],
      input: `${candidates.join('\n')}\n`,
    })
    const blobs = hashed?.split('\n').filter(Boolean)
    if (blobs === undefined || blobs.length !== candidates.length) {
      return { unfiltered: 'git could not hash the untracked files' }
    }
    const unpaired = new Map()
    for (const blob of removedBlobs) unpaired.set(blob, (unpaired.get(blob) ?? 0) + 1)
    for (const [i, path] of candidates.entries()) {
      const left = unpaired.get(blobs[i]) ?? 0
      if (left > 0) {
        unpaired.set(blobs[i], left - 1)
        unchanged.add(path)
      }
    }
  }
  return { label: base.label, unchanged }
}

const isClone = (clone) =>
  typeof clone?.lines === 'number' &&
  [clone.firstFile, clone.secondFile].every(
    (file) =>
      typeof file?.name === 'string' && Number.isInteger(file.start) && Number.isInteger(file.end),
  )

const describeClone = (clone, copies, prefix = '', carriers = true) => {
  const named = `${prefix}${clone.firstFile.name}:${clone.firstFile.start}-${clone.firstFile.end} duplicates ${clone.secondFile.name}:${clone.secondFile.start}-${clone.secondFile.end} (${clone.lines} lines)`
  const files = copies.get(clone.fragment)
  if (!carriers || files === undefined || files.size <= 2) return named
  return `${named}\n        a block carried by ${files.size} files, so the newest copy may be any of: ${[...files].sort().join(', ')}`
}

// A baselined fingerprint allows as many clone pairs as it held when recorded. A further copy of the block makes one more pair, and jscpd marks
// whichever pair it enumerates last as new — not necessarily one holding the new file — so the files carrying the block are named together.
function filesByFragment(duplicates) {
  const copies = new Map()
  for (const clone of duplicates) {
    if (typeof clone.fragment !== 'string' || !isClone(clone)) continue
    if (!copies.has(clone.fragment)) copies.set(clone.fragment, new Set())
    copies.get(clone.fragment).add(clone.firstFile.name).add(clone.secondFile.name)
  }
  return copies
}

// `carriersOf(clone)` says whether to name the files carrying a block of three or more: a pair that may hold a new copy gets them, a re-pairing has no newest
// copy to find. A red listing is capped at `limit`; a listing the reader audits pair by pair (the accepted re-pairings, the pairs a note names, the
// pairs `--update` records) passes `Infinity`.
const listClones = (
  pairs,
  duplicates,
  { prefixOf = () => '', carriersOf = () => true, limit = MAX_LISTED } = {},
) => {
  const copies = filesByFragment(duplicates)
  const lines = pairs
    .map((clone) => describeClone(clone, copies, prefixOf(clone), carriersOf(clone)))
    .sort()
  const listed = lines.slice(0, limit).map((line) => `    ${line}`)
  if (lines.length > limit) listed.push(`    … and ${lines.length - limit} more`)
  return listed.join('\n')
}

// The clone fingerprint of each reported pair, from the SARIF report: the JSON report carries none. The two reports are joined by position, and every
// pair is checked to name the same files and first start line, so a join that drifted disables the filter instead of misclassifying a pair.
function pairHashes(outDir, duplicates) {
  const sarifPath = join(outDir, SARIF_REL)
  if (!existsSync(sarifPath)) return { problem: 'jscpd wrote no SARIF report' }
  let results
  try {
    results = JSON.parse(readFileSync(sarifPath, 'utf8'))?.runs?.[0]?.results
  } catch (err) {
    return { problem: `jscpd wrote an unparseable SARIF report (${err.message})` }
  }
  if (!Array.isArray(results) || results.length !== duplicates.length) {
    return { problem: 'the SARIF report does not line up with the JSON report' }
  }
  const hashes = []
  for (const [i, clone] of duplicates.entries()) {
    const found = results[i]
    const first = found?.locations?.[0]?.physicalLocation
    const second = found?.relatedLocations?.[0]?.physicalLocation
    const hash = found?.partialFingerprints?.[HASH_KEY]
    const aligned =
      first?.artifactLocation?.uri === clone.firstFile?.name &&
      first?.region?.startLine === clone.firstFile?.start &&
      second?.artifactLocation?.uri === clone.secondFile?.name &&
      second?.region?.startLine === clone.secondFile?.start
    if (!aligned)
      return { problem: `SARIF result ${i} names different files than the JSON report's pair ${i}` }
    if (typeof hash !== 'string' || !/^[0-9a-f]{16}$/u.test(hash)) {
      return { problem: `SARIF result ${i} carries no 16-hex ${HASH_KEY}` }
    }
    hashes.push(hash)
  }
  return { hashes }
}

// Runs jscpd against the committed baseline. Returns `{ problem }` when the scan itself cannot be trusted, else the report's clones, those absent from
// the baseline among them, the new-clone count jscpd itself states (`newClones`), and each pair's fingerprint (`hashes`, aligned with `duplicates`;
// `hashProblem` says why there are none).
function scan({ root, node }) {
  const config = readMinLines(root)
  if (config.error) return { problem: config.error }

  return withScratch('check-clones-', (outDir) => {
    const run = spawnJscpd(
      root,
      [
        '--config',
        CONFIG_REL,
        '--baseline',
        BASELINE_REL,
        '--reporters',
        'json,sarif',
        '--output',
        outDir,
        '--fail-on-empty',
        '--fail-on-new-clones',
        '--no-colors',
      ],
      node,
    )
    if (run.error) return { problem: run.error }

    const reportPath = join(outDir, 'jscpd-report.json')
    if (!existsSync(reportPath)) {
      return {
        problem: `jscpd ${run.ended} without writing a report:\n${indent(run.diagnostics)}`,
      }
    }
    let report
    try {
      report = JSON.parse(readFileSync(reportPath, 'utf8'))
    } catch (err) {
      return { problem: `jscpd wrote an unparseable report (${err.message})` }
    }
    const sources = report?.statistics?.total?.sources
    if (!Array.isArray(report?.duplicates) || typeof sources !== 'number') {
      return {
        problem: `the jscpd report has an unrecognized shape — a jscpd upgrade changed its JSON output; update scan() in ${SCRIPT_REL}`,
      }
    }
    if (sources === 0) {
      return {
        problem:
          `jscpd analyzed 0 files — this gate exists to find clones in them, so zero means detection itself is broken (the ${CONFIG_REL} pattern or ` +
          'ignore globs no longer match the tree). Fix detection before trusting this checker again.',
      }
    }

    const fresh = report.duplicates.filter((clone) => clone.isNew === true)
    if (!fresh.every(isClone)) {
      return {
        problem: `a new clone in the jscpd report lacks its file names or line ranges — a jscpd upgrade changed its JSON output; update isClone() in ${SCRIPT_REL}`,
      }
    }
    const { hashes, problem: hashProblem } = pairHashes(outDir, report.duplicates)
    return {
      duplicates: report.duplicates,
      fresh,
      hashes,
      hashProblem,
      minLines: config.minLines,
      newClones: report.statistics.total.newClones,
      run,
      sources,
    }
  })
}

// Splits the fresh pairs into re-pairings and the rest. `changes` is `{ label, unchanged }` or `{ unfiltered }`. A fingerprint with a fresh pair is a
// re-pairing when every pair carrying it holds two unchanged files; `listed` is what a red names: the rejected groups' pairs that hold a changed file.
// `neighbours` is what a green run that accepted re-pairings owes the reader: the pairs that hold a changed file and share a file with an accepted pair
// (an accepted pair holds none, and a green run has no rejected one, so these are pairs jscpd did not flag), which pass only on counts the re-pairing
// freed. Unfiltered, nothing is accepted and the fresh pairs themselves are listed.
function judge({ duplicates, fresh, hashes, hashProblem }, changes) {
  const unfiltered =
    changes.unfiltered ??
    (hashes === undefined ? `the clone fingerprints are unavailable (${hashProblem})` : undefined)
  if (unfiltered !== undefined) {
    return { accepted: [], listed: fresh, neighbours: [], rejected: fresh, unfiltered }
  }

  const { label, unchanged } = changes
  const touchesChange = (clone) =>
    !unchanged.has(clone.firstFile.name) || !unchanged.has(clone.secondFile.name)
  const hashOf = new Map(duplicates.map((clone, i) => [clone, hashes[i]]))
  const tainted = new Set(duplicates.filter(touchesChange).map((clone) => hashOf.get(clone)))
  const accepted = fresh.filter((clone) => !tainted.has(hashOf.get(clone)))
  const rejected = fresh.filter((clone) => tainted.has(hashOf.get(clone)))
  const rejectedHashes = new Set(rejected.map((clone) => hashOf.get(clone)))
  const listed = duplicates.filter(
    (clone) => rejectedHashes.has(hashOf.get(clone)) && touchesChange(clone),
  )
  const acceptedFiles = new Set(
    accepted.flatMap((clone) => [clone.firstFile.name, clone.secondFile.name]),
  )
  const neighbours = duplicates.filter(
    (clone) =>
      touchesChange(clone) &&
      (acceptedFiles.has(clone.firstFile.name) || acceptedFiles.has(clone.secondFile.name)),
  )
  return { accepted, label, listed, neighbours, rejected }
}

const basis = (verdict) =>
  verdict.unfiltered === undefined
    ? `judged against ${verdict.label}`
    : `unfiltered: ${verdict.unfiltered}`

// Pairs the baseline allows beyond what the tree holds: the counts of fingerprints the tree no longer holds (a deletion, or a rename or move that re-paired
// the survivors), which would let a later copy of the block through.
function excessAllowance(root, hashes) {
  if (hashes === undefined) return 0
  let recorded
  try {
    recorded = JSON.parse(readFileSync(join(root, BASELINE_REL), 'utf8')).fingerprints
  } catch {
    return 0
  }
  const held = new Map()
  for (const hash of hashes) held.set(hash, (held.get(hash) ?? 0) + 1)
  let excess = 0
  for (const [hash, count] of Object.entries(recorded ?? {})) {
    if (Number.isInteger(count)) excess += Math.max(0, count - (held.get(hash) ?? 0))
  }
  return excess
}

// jscpd exits non-zero for a new clone (--fail-on-new-clones) and for other reasons. A run that reports new clones is explained by them only when jscpd's
// own count matches the pairs this lane read as new; a run that reports none has no explanation at all.
function unexplainedExit({ fresh, newClones, run }) {
  if (run.status === 0) return undefined
  if (fresh.length === 0) {
    return `jscpd ${run.ended} though its report holds no new clone:\n${indent(run.diagnostics)}`
  }
  if (newClones !== fresh.length) {
    return `jscpd ${run.ended} stating ${newClones ?? 'no'} new clone(s), though its report lists ${fresh.length}:\n${indent(run.diagnostics)}`
  }
  return undefined
}

// `node`: the binary that runs jscpd's entry point.
/** @param {{ root: string, changes?: ReturnType<typeof changesAgainst>, node?: string }} args */
export function check({ root, changes = NO_BASE, node = process.execPath }) {
  if (!existsSync(join(root, BASELINE_REL))) {
    return red(
      `${BASELINE_REL} is missing — the gate cannot run without it. Generate and commit it: ${UPDATE_COMMAND}`,
    )
  }
  const scanned = scan({ node, root })
  if (scanned.problem) return red(scanned.problem)
  const { duplicates, fresh, hashes, minLines, newClones, run, sources } = scanned
  const verdict = judge(scanned, changes)

  if (verdict.rejected.length > 0) {
    const remedy =
      '      Consolidate onto the existing code, or record a deliberate, reviewed copy and commit the baseline diff:\n' +
      `        ${UPDATE_COMMAND}\n`
    const explanation =
      verdict.unfiltered === undefined
        ? `      ${basis(verdict)}: a fresh fingerprint whose every pair holds unchanged files is a re-pairing and passes, so every pair above holds a file added or edited since.\n` +
          (verdict.accepted.length > 0
            ? `      ${verdict.accepted.length} other fresh pair(s) were re-pairings and accepted.\n`
            : '') +
          '      An edit inside a recorded copy is red too, with the same remedy.\n'
        : `      ${basis(verdict)}. Without a base the run cannot tell a copy from jscpd re-pairing a block carried by three or more files after a rename,\n` +
          '      move or deletion of one copy, so every pair it reports as new is red.\n'
    return result(
      1,
      '',
      `✗ ${CHECK_NAME}: ${verdict.rejected.length} new clone(s) of ${minLines}+ lines not in ${BASELINE_REL}\n${listClones(verdict.listed, duplicates)}\n${explanation}${remedy}`,
    )
  }
  const unexplained = unexplainedExit({ fresh, newClones, run })
  if (unexplained !== undefined) return red(unexplained)

  const lines = []
  if (verdict.accepted.length === 0) {
    lines.push(
      `✓ ${CHECK_NAME}: ${duplicates.length} clone(s) of ${minLines}+ lines in ${sources} file(s), every one in ${BASELINE_REL}`,
      `  ${basis(verdict)}`,
    )
  } else {
    lines.push(
      `✓ ${CHECK_NAME}: ${duplicates.length} clone(s) of ${minLines}+ lines in ${sources} file(s); ${verdict.accepted.length} fresh pair(s) accepted as re-pairings against ${verdict.label}, the rest in ${BASELINE_REL}`,
      listClones(verdict.accepted, duplicates, { carriersOf: () => false, limit: Infinity }),
      '  Every file in these pairs is unchanged against the base, so these pairs are re-pairings and copy nothing; jscpd pairs the surviving copies of a block',
      `  carried by three or more files differently once one is renamed, moved or deleted. Recording them is optional: ${UPDATE_COMMAND}`,
    )
    if (verdict.neighbours.length > 0) {
      lines.push(
        `  note: ${verdict.neighbours.length} other pair(s) hold a file changed since the base and share a file with the re-pairings above. They pass only on counts the`,
        `  re-pairing or a deletion freed in ${BASELINE_REL}, so if one is a copy this change added, consolidate it, or record it deliberately: ${UPDATE_COMMAND}`,
        listClones(verdict.neighbours, duplicates, { limit: Infinity }),
      )
    }
  }
  const excess = excessAllowance(root, hashes)
  if (excess > 0) {
    lines.push(
      `  warning: ${BASELINE_REL} allows ${excess} more clone pair(s) than the tree holds (the counts of fingerprints the tree no longer holds after a rename, move,`,
      `  deletion or edit re-paired its copies); a later copy of those blocks would pass while they last. Record the tree: ${UPDATE_COMMAND}`,
    )
  }
  return result(0, `${lines.join('\n')}\n`)
}

export const jscpdUpdateArgs = (baselinePath) => [
  '--config',
  CONFIG_REL,
  '--baseline',
  baselinePath,
  '--update-baseline',
  '--reporters',
  'silent',
  '--fail-on-empty',
  '--no-colors',
]

// jscpd rewrites the baseline before it applies --fail-on-empty, so an update that analyzed nothing would leave an emptied file behind. It writes
// to a copy, and the real file is replaced only once jscpd exits 0. The copy sits beside the baseline so the final rename never crosses a filesystem, and
// is removed on every way out.
/** @param {{ root: string, changes?: ReturnType<typeof changesAgainst>, node?: string }} args */
export function update({ root, changes = NO_BASE, node = process.execPath }) {
  const baselinePath = join(root, BASELINE_REL)
  const staged = `${baselinePath}.staged-${process.pid}`
  try {
    let recording = ''
    if (existsSync(baselinePath)) {
      copyFileSync(baselinePath, staged)
      const before = scan({ node, root })
      if (before.problem) {
        recording = `could not list the clones being recorded: ${before.problem}\n`
      } else if (before.fresh.length > 0) {
        // Labelled by fingerprint group, as the gate judges: a re-pairing is an accepted fresh pair, a new copy a pair holding a changed file in a group the
        // gate rejects. The pair jscpd flags in such a group can be an unchanged one, so the pairs listed are not always the pairs counted.
        const verdict = judge(before, changes)
        const classified = verdict.unfiltered === undefined
        const accepted = new Set(verdict.accepted)
        const prefixOf = classified
          ? (clone) => (accepted.has(clone) ? '[re-pairing] ' : '[new copy] ')
          : () => ''
        const carriersOf = (clone) => !classified || !accepted.has(clone)
        const legend = classified
          ? `  ${basis(verdict)}; the count is jscpd's new pairs and the listing the pairs behind them: a re-pairing holds only unchanged files, a new copy holds a file added or edited since`
          : `  unclassified, ${basis(verdict)}`
        const listed = classified ? [...verdict.accepted, ...verdict.listed] : before.fresh
        recording = `recording ${before.fresh.length} clone pair(s) the committed ${BASELINE_REL} lacks:\n${legend}\n${listClones(listed, before.duplicates, { carriersOf, limit: Infinity, prefixOf })}\n`
      }
    }
    const run = spawnJscpd(root, jscpdUpdateArgs(staged), node)
    if (run.error) return red(run.error)
    if (run.status !== 0) {
      return red(
        `jscpd ${run.ended}; ${BASELINE_REL} was left as it was:\n${indent(run.diagnostics)}\n` +
          `If ${BASELINE_REL} itself is corrupt (a bad merge, a truncated file), delete it and re-run ${UPDATE_COMMAND} to regenerate it from the tree, ` +
          'then review its diff.',
      )
    }
    renameSync(staged, baselinePath)
    const summary = /updated: (.+)$/mu.exec(run.diagnostics)?.[1] ?? 'updated'
    return result(
      0,
      `${recording}✓ ${CHECK_NAME}: ${BASELINE_REL} ${summary} — review and commit the diff\n`,
    )
  } finally {
    rmSync(staged, { force: true })
  }
}

// Every line carries the tag, so two blocks with different tags share no run of tokens long enough to be a clone.
const tsBlock = (tag, length = 14) =>
  Array.from(
    { length },
    (_, i) => `const ${tag}Value${i} = compute${tag}(${i}, '${tag}-${i}')`,
  ).join('\n')

const PAIR = tsBlock('pair')
const SOLO_TS = tsBlock('soloTs')
const SOLO_TSX = tsBlock('soloTsx')
const SOLO_CROSS = tsBlock('soloCross')
const SOLO_MTS = tsBlock('soloMts')

const BASE_TREE = {
  'src/pair/one.ts': PAIR,
  'src/pair/two.ts': PAIR,
  'src/solo/cross.ts': SOLO_CROSS,
  'src/solo/solo.mts': SOLO_MTS,
  'src/solo/solo.ts': SOLO_TS,
  'src/solo/solo.tsx': SOLO_TSX,
}

const PLANTS = {
  'tools/plant/copy.cts': SOLO_MTS,
  'tools/plant/copy.ts': SOLO_TS,
  'tools/plant/copy.tsx': SOLO_TSX,
  'tools/plant/cross.tsx': SOLO_CROSS,
}

const PLANTED_PAIRS = [
  ['src/solo/solo.ts', 'tools/plant/copy.ts'],
  ['src/solo/solo.tsx', 'tools/plant/copy.tsx'],
  ['src/solo/cross.ts', 'tools/plant/cross.tsx'],
  ['src/solo/solo.mts', 'tools/plant/copy.cts'],
]

// Three copies of one block whose pairs differ in extent: `a` is the shorter block, `b` and `c` carry extra lines, so the pair (b, c) is longer than the
// pairs anchored on `a`. This is the shape in which jscpd re-pairs the surviving copies when the anchor goes.
const TRI_BLOCK = tsBlock('triBlock', 12)
const TRI_TAIL = tsBlock('triTail', 6)
const TRI_LONG = `${TRI_BLOCK}\n${TRI_TAIL}`
const TRI_TREE = {
  'src/tri/a.ts': TRI_BLOCK,
  'src/tri/b.ts': TRI_LONG,
  'src/tri/c.ts': TRI_LONG,
}

const writeTree = (dir, tree) => {
  for (const [rel, content] of Object.entries(tree)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), `${content}\n`)
  }
}

const removeFiles = (dir, rels) => {
  for (const rel of rels) rmSync(join(dir, rel), { force: true })
}

const fingerprintCount = (dir) => {
  try {
    return Object.keys(JSON.parse(readFileSync(join(dir, BASELINE_REL), 'utf8')).fingerprints)
      .length
  } catch {
    return -1
  }
}

// What the self-test hands the gate in place of git's answer: every path unchanged against a base but the ones named, or no base at all. The gate only
// asks the set whether it `has` a path, so a stand-in for "git vouches for everything but these" needs no tree to enumerate. Which paths git vouches for
// is pinned where a real repository answers, in tools/scripts/check-clones-base.test.ts.
const UNFILTERED = { unfiltered: 'self-test: no base' }
const against = (...changed) => ({
  label: 'self-test base',
  unchanged: { has: (path) => !changed.includes(path) },
})

function selfTest() {
  return withScratch('check-clones-selftest-', (dir) => {
    const failures = []
    const expect = (ok, message) => {
      if (!ok) failures.push(message)
    }
    const config = readFileSync(join(ROOT, CONFIG_REL), 'utf8')
    const baselineBytes = (where = dir) => readFileSync(join(where, BASELINE_REL), 'utf8')
    const namesBoth = (text, first, second) =>
      text.split('\n').some((line) => line.includes(`${first}:`) && line.includes(`${second}:`))

    writeFileSync(join(dir, CONFIG_REL), config)
    writeTree(dir, BASE_TREE)

    const missing = check({ changes: UNFILTERED, root: dir })
    expect(
      missing.code === 1 && missing.err.includes(`${BASELINE_REL} is missing`),
      `a missing baseline did not fail: ${JSON.stringify(missing)}`,
    )

    const created = update({ changes: UNFILTERED, root: dir })
    expect(created.code === 0, `--update failed on the base tree: ${created.err}`)
    expect(
      created.out.includes('1 fingerprints added, 0 removed (1 total)'),
      `--update did not print jscpd's added/removed summary: ${created.out}`,
    )
    expect(
      fingerprintCount(dir) === 1,
      `the base tree has one clone pair and clone-free blocks, so the baseline should hold exactly 1 fingerprint, not ${fingerprintCount(dir)}`,
    )
    const original = baselineBytes()

    const clean = check({ changes: against(), root: dir })
    expect(
      clean.code === 0 && clean.out.startsWith(`✓ ${CHECK_NAME}: 1 clone(s)`),
      `the base tree was not green against its own baseline: ${JSON.stringify(clean)}`,
    )
    expect(
      clean.out.includes('judged against self-test base') && !clean.out.includes('warning'),
      `a green run on the unchanged base tree should name its base and warn of nothing: ${clean.out}`,
    )
    const cleanUnfiltered = check({ changes: UNFILTERED, root: dir })
    expect(
      cleanUnfiltered.code === 0 && cleanUnfiltered.out.includes('unfiltered: self-test: no base'),
      `a green run without a base did not say it was unfiltered: ${JSON.stringify(cleanUnfiltered)}`,
    )

    // The two-file case: with one pair the enumeration order cannot change the pairing, so a rename stays green. A block carried by three files is
    // pinned further down.
    renameSync(join(dir, 'src/pair/two.ts'), join(dir, 'src/pair/moved.ts'))
    const moved = check({ changes: against(), root: dir })
    expect(
      moved.code === 0,
      `renaming a file of a two-file baselined pair should stay green (the baseline is keyed on content): ${JSON.stringify(moved)}`,
    )
    renameSync(join(dir, 'src/pair/moved.ts'), join(dir, 'src/pair/two.ts'))

    writeTree(dir, { 'src/pair/three.ts': PAIR })
    const third = check({ changes: against('src/pair/three.ts'), root: dir })
    expect(
      third.code === 1 && third.err.startsWith(`✗ ${CHECK_NAME}: 1 new clone(s)`),
      `a third copy of a baselined block was not reported as exactly 1 new clone: ${JSON.stringify(third)}`,
    )
    expect(
      ['src/pair/one.ts', 'src/pair/two.ts', 'src/pair/three.ts'].every((file) =>
        third.err.includes(file),
      ),
      `the report for a third copy does not name all three files carrying the block: ${third.err}`,
    )
    removeFiles(dir, ['src/pair/three.ts'])

    // jscpd flags the last pair of a fingerprint in its report, which need not hold the new file: a copy sorting between the two recorded files is
    // flagged as the recorded pair, whose files are both unchanged. The verdict is per fingerprint, so the copy is still red and named with the file
    // it duplicates.
    writeTree(dir, { 'src/pair/p.ts': PAIR })
    const between = check({ changes: against('src/pair/p.ts'), root: dir })
    expect(
      between.code === 1 && namesBoth(between.err, 'src/pair/one.ts', 'src/pair/p.ts'),
      `a copy sorting between the two recorded files was not reported with the file it duplicates: ${JSON.stringify(between)}`,
    )
    expect(
      !namesBoth(between.err, 'src/pair/one.ts', 'src/pair/two.ts'),
      `the red listed the recorded pair of two unchanged files, which is not a copy: ${between.err}`,
    )
    // The recording labels by the same group verdict: the pair jscpd flags is the unchanged recorded one, but the new copy is the pair holding p.ts.
    const betweenRecorded = update({ changes: against('src/pair/p.ts'), root: dir })
    expect(
      betweenRecorded.code === 0 &&
        betweenRecorded.out
          .split('\n')
          .some(
            (line) =>
              line.includes('[new copy]') &&
              line.includes('src/pair/one.ts:') &&
              line.includes('src/pair/p.ts:'),
          ) &&
        !namesBoth(betweenRecorded.out, 'src/pair/one.ts', 'src/pair/two.ts') &&
        !betweenRecorded.out.includes('[re-pairing]'),
      `--update labelled the unchanged recorded pair, not the copy holding p.ts, as the new copy: ${betweenRecorded.out}`,
    )
    writeFileSync(join(dir, BASELINE_REL), original)
    removeFiles(dir, ['src/pair/p.ts'])

    // An edit inside a recorded copy changes the fingerprint (the block is cut to the lines that still match) and puts an edited file in the group.
    writeTree(dir, {
      'src/pair/two.ts': `${PAIR.split('\n').slice(0, 13).join('\n')}\nconst editedLine = 'edited'`,
    })
    const edited = check({ changes: against('src/pair/two.ts'), root: dir })
    expect(
      edited.code === 1 &&
        edited.err.startsWith(`✗ ${CHECK_NAME}: 1 new clone(s)`) &&
        edited.err.includes('src/pair/two.ts') &&
        edited.err.includes(UPDATE_COMMAND),
      `an edit inside a recorded copy did not stay red: ${JSON.stringify(edited)}`,
    )
    writeTree(dir, { 'src/pair/two.ts': PAIR })

    writeTree(dir, PLANTS)
    const planted = check({ changes: against(...Object.keys(PLANTS)), root: dir })
    expect(
      planted.code === 1 && planted.out === '',
      `planted copies did not exit 1 with an empty stdout: ${JSON.stringify(planted)}`,
    )
    expect(
      planted.err.startsWith(
        `✗ ${CHECK_NAME}: ${PLANTED_PAIRS.length} new clone(s) of 10+ lines not in ${BASELINE_REL}\n`,
      ),
      `the planted copies were not reported as exactly ${PLANTED_PAIRS.length} new clones: ${planted.err}`,
    )
    for (const [original_, copy] of PLANTED_PAIRS) {
      const named = planted.err
        .split('\n')
        .some(
          (line) =>
            line.includes(`${original_}:`) &&
            line.includes(`${copy}:`) &&
            line.includes('(14 lines)'),
        )
      expect(named, `no line names both ${original_} and ${copy} with their range: ${planted.err}`)
    }
    expect(
      planted.err.includes(UPDATE_COMMAND),
      'the red output does not name the regenerating command',
    )
    expect(
      planted.err.includes('judged against self-test base'),
      'the red output does not name the base it judged against',
    )
    expect(!planted.err.includes('src/pair/'), 'the already-baselined pair was reported as new')

    const plantedUnfiltered = check({ changes: UNFILTERED, root: dir })
    expect(
      plantedUnfiltered.code === 1 &&
        plantedUnfiltered.err.includes('unfiltered: self-test: no base') &&
        PLANTED_PAIRS.every(([first, second]) => namesBoth(plantedUnfiltered.err, first, second)),
      `the planted copies were not red and named without a base: ${plantedUnfiltered.err}`,
    )

    const accepted = update({ changes: against(...Object.keys(PLANTS)), root: dir })
    expect(accepted.code === 0, `--update failed with the planted copies in place: ${accepted.err}`)
    expect(
      accepted.out.startsWith(
        `recording ${PLANTED_PAIRS.length} clone pair(s) the committed ${BASELINE_REL} lacks:\n`,
      ) &&
        PLANTED_PAIRS.every(([first, second]) =>
          accepted.out
            .split('\n')
            .some(
              (line) =>
                line.includes('[new copy]') &&
                line.includes(`${first}:`) &&
                line.includes(`${second}:`),
            ),
        ),
      `--update did not list the planted pairs it was recording, each labelled a new copy: ${accepted.out}`,
    )
    expect(
      fingerprintCount(dir) === 1 + PLANTED_PAIRS.length,
      `accepting the ${PLANTED_PAIRS.length} planted copies should leave ${1 + PLANTED_PAIRS.length} fingerprints in the baseline, not ${fingerprintCount(dir)}`,
    )
    const reaccepted = check({ changes: against(...Object.keys(PLANTS)), root: dir })
    expect(
      reaccepted.code === 0,
      `the accepted copies were still red after --update: ${JSON.stringify(reaccepted)}`,
    )

    removeFiles(dir, Object.keys(PLANTS))
    update({ changes: UNFILTERED, root: dir })
    expect(
      baselineBytes() === original,
      '--update after removing the planted copies did not restore the original baseline byte for byte',
    )

    const emptyDir = join(dir, 'empty')
    mkdirSync(emptyDir)
    writeFileSync(join(emptyDir, CONFIG_REL), config)
    const emptyBaseline = `${JSON.stringify({ fingerprints: { '0000000000000000': 1 }, version: 1 }, null, 2)}\n`
    writeFileSync(join(emptyDir, BASELINE_REL), emptyBaseline)
    const nothing = check({ changes: UNFILTERED, root: emptyDir })
    expect(
      nothing.code === 1 && nothing.err.includes('analyzed 0 files'),
      `a scan that analyzed no files did not fail: ${JSON.stringify(nothing)}`,
    )
    const wiped = update({ changes: UNFILTERED, root: emptyDir })
    expect(
      wiped.code === 1 && readFileSync(join(emptyDir, BASELINE_REL), 'utf8') === emptyBaseline,
      `--update on a scan that analyzed no files did not fail or touched the baseline: ${JSON.stringify(wiped)}`,
    )
    expect(
      readdirSync(emptyDir).every((name) => !name.startsWith(`${BASELINE_REL}.`)) &&
        readdirSync(dir).every((name) => !name.startsWith(`${BASELINE_REL}.`)),
      '--update left its staged copy of the baseline beside the real one',
    )

    // The three-file case: the anchoring copy going away, or a rename that puts another file first or last in the enumeration, re-pairs the survivors
    // under a fingerprint the baseline never recorded. Against a base where no file of theirs changed it is a re-pairing and green; without one it is
    // red as it always was.
    const triDir = join(dir, 'tri')
    mkdirSync(triDir)
    writeFileSync(join(triDir, CONFIG_REL), config)
    writeTree(triDir, TRI_TREE)
    update({ changes: UNFILTERED, root: triDir })
    expect(
      fingerprintCount(triDir) === 2,
      `the three-file tree should record 2 fingerprints (the shared block and the longer pair), not ${fingerprintCount(triDir)}`,
    )
    const triBaseline = baselineBytes(triDir)
    const triClean = check({ changes: against(), root: triDir })
    expect(
      triClean.code === 0,
      `the three-file tree was not green against its own baseline: ${JSON.stringify(triClean)}`,
    )
    const restoreTri = () => {
      removeFiles(triDir, [
        'src/tri/0.ts',
        'src/tri/z.ts',
        'src/tri/bb.ts',
        'src/tri/x.ts',
        'src/tri/y.ts',
      ])
      writeTree(triDir, TRI_TREE)
      writeFileSync(join(triDir, BASELINE_REL), triBaseline)
    }
    const neighbourNote = 'share a file with the re-pairings above'
    const namesFile = (text, file) => text.split('\n').some((line) => line.includes(`${file}:`))

    const triShapes = [
      {
        apply: () => removeFiles(triDir, ['src/tri/a.ts']),
        pair: ['src/tri/b.ts', 'src/tri/c.ts'],
        what: 'deleting the anchoring copy',
      },
      {
        apply: () => renameSync(join(triDir, 'src/tri/c.ts'), join(triDir, 'src/tri/0.ts')),
        pair: ['src/tri/0.ts', 'src/tri/b.ts'],
        what: 'renaming a copy so it enumerates first',
      },
      {
        apply: () => renameSync(join(triDir, 'src/tri/a.ts'), join(triDir, 'src/tri/z.ts')),
        pair: ['src/tri/b.ts', 'src/tri/c.ts'],
        what: 'renaming the anchor so it enumerates last',
      },
    ]
    for (const { apply, pair, what } of triShapes) {
      apply()
      const repaired = check({ changes: against(), root: triDir })
      expect(
        repaired.code === 0 &&
          repaired.out.includes('accepted as re-pairings against self-test base') &&
          namesBoth(repaired.out, pair[0], pair[1]) &&
          repaired.out.includes(UPDATE_COMMAND),
        `${what} of a three-file block was not accepted as a listed re-pairing: ${JSON.stringify(repaired)}`,
      )
      expect(
        /warning: .* allows \d+ more clone pair\(s\) than the tree holds \(the counts of fingerprints the tree no longer holds after a rename, move,\n {2}deletion or edit re-paired its copies\)/u.test(
          repaired.out,
        ),
        `${what} leaves recorded counts the tree no longer holds, and the green run did not warn in words that cover a rename and a move: ${repaired.out}`,
      )
      expect(
        baselineBytes(triDir) === triBaseline,
        `${what} changed the baseline file, which the gate must leave alone`,
      )
      expect(
        !repaired.out.includes(neighbourNote) && !repaired.out.includes('note:'),
        `${what} holds no changed file, so the green run has no pair to flag, but it printed a note: ${repaired.out}`,
      )
      const strict = check({ changes: UNFILTERED, root: triDir })
      expect(
        strict.code === 1 &&
          /^✗ clone check: \d+ new clone\(s\)/u.test(strict.err) &&
          strict.err.includes('unfiltered: self-test: no base'),
        `${what} of a three-file block should be red without a base, saying so: ${JSON.stringify(strict)}`,
      )
      restoreTri()
    }

    // A copy landing in the same change as the rename: the rename frees a count of the recorded 12-line fingerprint, the copy's pair lands in it and jscpd
    // never flags it. The run stays green, since refusing dead allowance would redden a rename plus an importer edit that copies nothing, but it must not
    // say nothing was copied, and the note names the pairs that hold a changed file beside the accepted re-pairing.
    renameSync(join(triDir, 'src/tri/a.ts'), join(triDir, 'src/tri/z.ts'))
    writeTree(triDir, { 'src/tri/x.ts': TRI_BLOCK })
    const renamedAndCopied = check({ changes: against('src/tri/x.ts'), root: triDir })
    expect(
      renamedAndCopied.code === 0 &&
        renamedAndCopied.out.includes('accepted as re-pairings against self-test base') &&
        renamedAndCopied.out.includes(neighbourNote) &&
        namesFile(renamedAndCopied.out, 'src/tri/x.ts') &&
        !renamedAndCopied.out.includes('nothing was copied') &&
        renamedAndCopied.out.includes('copy nothing'),
      `a rename plus a copy of the block was not green with a note naming the copy and no claim that nothing was copied: ${JSON.stringify(renamedAndCopied)}`,
    )
    // The rename frees one count only: a second copy overflows it and is flagged.
    writeTree(triDir, { 'src/tri/y.ts': TRI_BLOCK })
    const renamedAndCopiedTwice = check({
      changes: against('src/tri/x.ts', 'src/tri/y.ts'),
      root: triDir,
    })
    expect(
      renamedAndCopiedTwice.code === 1 &&
        namesFile(renamedAndCopiedTwice.err, 'src/tri/x.ts') &&
        namesFile(renamedAndCopiedTwice.err, 'src/tri/y.ts'),
      `a rename plus two copies of the block was not red naming both: ${JSON.stringify(renamedAndCopiedTwice)}`,
    )
    restoreTri()

    // With the anchor of a four-file block gone, the re-paired fragment is carried by three files. A red names them, because the newest copy may be any
    // of them; a green re-pairing has no newest copy, so the listing must not claim one.
    const quadDir = join(dir, 'quad')
    mkdirSync(quadDir)
    writeFileSync(join(quadDir, CONFIG_REL), config)
    writeTree(quadDir, {
      'src/quad/a.ts': TRI_BLOCK,
      'src/quad/b.ts': TRI_LONG,
      'src/quad/c.ts': TRI_LONG,
      'src/quad/d.ts': TRI_LONG,
    })
    update({ changes: UNFILTERED, root: quadDir })
    removeFiles(quadDir, ['src/quad/a.ts'])
    const quadGreen = check({ changes: against(), root: quadDir })
    expect(
      quadGreen.code === 0 &&
        quadGreen.out.includes('accepted as re-pairings against self-test base') &&
        namesBoth(quadGreen.out, 'src/quad/b.ts', 'src/quad/c.ts') &&
        !quadGreen.out.includes('newest copy may be any of'),
      `deleting the anchor of a four-file block did not list its re-pairings without a newest copy: ${JSON.stringify(quadGreen)}`,
    )
    const quadStrict = check({ changes: UNFILTERED, root: quadDir })
    expect(
      quadStrict.code === 1 && quadStrict.err.includes('newest copy may be any of'),
      `without a base the re-pairings of a four-file block should be red and name the files carrying it: ${JSON.stringify(quadStrict)}`,
    )

    // The note names only pairs beside a re-pairing: a changed file whose recorded pair shares no file with an accepted pair is not flagged.
    const mixDir = join(dir, 'mix')
    mkdirSync(mixDir)
    writeFileSync(join(mixDir, CONFIG_REL), config)
    writeTree(mixDir, { ...TRI_TREE, 'src/pair/one.ts': PAIR, 'src/pair/two.ts': PAIR })
    update({ changes: UNFILTERED, root: mixDir })
    renameSync(join(mixDir, 'src/tri/a.ts'), join(mixDir, 'src/tri/z.ts'))
    const apart = check({ changes: against('src/pair/one.ts'), root: mixDir })
    expect(
      apart.code === 0 &&
        apart.out.includes('accepted as re-pairings against self-test base') &&
        !apart.out.includes('note:'),
      `a changed file whose pair shares nothing with the re-pairing was flagged in the note: ${JSON.stringify(apart)}`,
    )

    // A jscpd exit that its new clones do not explain is red, not green: here a duplication threshold fails the run with every clone recorded.
    const thresholdDir = join(dir, 'threshold')
    mkdirSync(thresholdDir)
    writeFileSync(join(thresholdDir, CONFIG_REL), config)
    writeTree(thresholdDir, { 'src/pair/one.ts': PAIR, 'src/pair/two.ts': PAIR })
    update({ changes: UNFILTERED, root: thresholdDir })
    writeFileSync(
      join(thresholdDir, CONFIG_REL),
      JSON.stringify({ ...JSON.parse(config), threshold: 0.01 }),
    )
    const overThreshold = check({ changes: against(), root: thresholdDir })
    expect(
      overThreshold.code === 1 &&
        overThreshold.err.includes('though its report holds no new clone'),
      `a jscpd failure with no new clone was not red: ${JSON.stringify(overThreshold)}`,
    )

    // A reviewer audits a green run and an `--update` listing pair by pair, so neither is capped; a red keeps its cap.
    const bigDir = join(dir, 'big')
    mkdirSync(bigDir)
    writeFileSync(join(bigDir, CONFIG_REL), config)
    writeTree(bigDir, {
      'src/big/a.ts': TRI_BLOCK,
      ...Object.fromEntries(
        Array.from({ length: MAX_LISTED + 5 }, (_, i) => [
          `src/big/b${String(i).padStart(2, '0')}.ts`,
          TRI_LONG,
        ]),
      ),
    })
    update({ changes: UNFILTERED, root: bigDir })
    removeFiles(bigDir, ['src/big/a.ts'])
    const pairLines = (text) => text.split('\n').filter((line) => line.includes(' duplicates '))
    const bigGreen = check({ changes: against(), root: bigDir })
    expect(
      bigGreen.code === 0 &&
        pairLines(bigGreen.out).length > MAX_LISTED &&
        !bigGreen.out.includes('… and'),
      `a green run accepting more than ${MAX_LISTED} re-pairings did not list every one: ${bigGreen.out.slice(0, 400)}`,
    )
    const bigRed = check({ changes: UNFILTERED, root: bigDir })
    expect(
      bigRed.code === 1 &&
        pairLines(bigRed.err).length === MAX_LISTED &&
        bigRed.err.includes('… and'),
      `a red listing more than ${MAX_LISTED} pairs was not capped: ${bigRed.err.slice(0, 400)}`,
    )
    const bigUpdate = update({ changes: against(), root: bigDir })
    expect(
      bigUpdate.code === 0 &&
        pairLines(bigUpdate.out).length > MAX_LISTED &&
        pairLines(bigUpdate.out).every((line) => line.includes('[re-pairing] ')) &&
        !bigUpdate.out.includes('… and'),
      `an --update recording more than ${MAX_LISTED} pairs did not label every one: ${bigUpdate.out.slice(0, 400)}`,
    )

    removeFiles(triDir, ['src/tri/a.ts'])
    const dead = check({ changes: against(), root: triDir })
    expect(
      dead.code === 0 &&
        /warning: .* allows \d+ more clone pair/u.test(dead.out) &&
        dead.out.includes(UPDATE_COMMAND),
      `the recorded counts of the deleted anchor's pairs exceed the tree's, and the green run did not warn: ${dead.out}`,
    )
    const relabelled = update({ changes: against(), root: triDir })
    expect(
      relabelled.code === 0 &&
        relabelled.out
          .split('\n')
          .some(
            (line) =>
              line.includes('[re-pairing]') &&
              line.includes('src/tri/b.ts:') &&
              line.includes('src/tri/c.ts:'),
          ) &&
        !relabelled.out.includes('[new copy]'),
      `--update after the anchor's deletion did not label the surviving pair a re-pairing: ${relabelled.out}`,
    )
    restoreTri()
    removeFiles(triDir, ['src/tri/a.ts'])
    const unclassified = update({ changes: UNFILTERED, root: triDir })
    expect(
      unclassified.code === 0 &&
        unclassified.out.includes('unclassified') &&
        !unclassified.out.includes('[re-pairing]') &&
        !unclassified.out.includes('[new copy]'),
      `--update without a base should say the pairs are unclassified: ${unclassified.out}`,
    )
    restoreTri()

    // A copy of b: jscpd flags the pairs of the recorded fingerprints that do not hold the new file, so only the group verdict keeps it red.
    writeTree(triDir, { 'src/tri/bb.ts': TRI_LONG })
    const copied = check({ changes: against('src/tri/bb.ts'), root: triDir })
    expect(
      copied.code === 1 &&
        copied.err.includes('src/tri/bb.ts:') &&
        copied.err.includes('newest copy may be any of'),
      `a copy of a recorded three-file block was not reported with the new file named: ${JSON.stringify(copied)}`,
    )
    expect(
      [
        ['src/tri/a.ts', 'src/tri/b.ts'],
        ['src/tri/a.ts', 'src/tri/c.ts'],
        ['src/tri/b.ts', 'src/tri/c.ts'],
      ].every(([first, second]) => !namesBoth(copied.err, first, second)),
      `the red listed a pair of unchanged files, which is not the copy: ${copied.err}`,
    )
    restoreTri()

    // The fingerprint join is verified, never trusted: a SARIF report that names other files or carries no fingerprint disables the filter.
    const sarifDir = join(dir, 'sarif')
    mkdirSync(sarifDir)
    const pairs = [
      {
        firstFile: { end: 20, name: 'x.ts', start: 3 },
        secondFile: { end: 18, name: 'y.ts', start: 1 },
      },
    ]
    const GOOD_HASH = '0123456789abcdef'
    const sarifResult = ({
      first = { startLine: 3, uri: 'x.ts' },
      second = { startLine: 1, uri: 'y.ts' },
      hash = GOOD_HASH,
    } = {}) => ({
      locations: [
        {
          physicalLocation: {
            artifactLocation: { uri: first.uri },
            region: { startLine: first.startLine },
          },
        },
      ],
      partialFingerprints: { [HASH_KEY]: hash },
      relatedLocations: [
        {
          physicalLocation: {
            artifactLocation: { uri: second.uri },
            region: { startLine: second.startLine },
          },
        },
      ],
    })
    const joinedWith = (...results) => {
      writeFileSync(join(sarifDir, SARIF_REL), JSON.stringify({ runs: [{ results }] }))
      return pairHashes(sarifDir, pairs)
    }
    expect(
      joinedWith(sarifResult()).hashes?.[0] === GOOD_HASH,
      'an aligned SARIF result was not joined to its pair',
    )
    for (const [what, results] of [
      ['a different first file', [sarifResult({ first: { startLine: 3, uri: 'other.ts' } })]],
      ['a different first start line', [sarifResult({ first: { startLine: 4, uri: 'x.ts' } })]],
      ['a different second file', [sarifResult({ second: { startLine: 1, uri: 'other.ts' } })]],
      ['a different second start line', [sarifResult({ second: { startLine: 2, uri: 'y.ts' } })]],
      ['a malformed fingerprint', [sarifResult({ hash: 'not-a-hash' })]],
      ['fewer results than pairs', []],
      ['more results than pairs', [sarifResult(), sarifResult()]],
    ]) {
      expect(
        joinedWith(...results).problem !== undefined,
        `a SARIF report with ${what} did not disable the join`,
      )
    }

    // jscpd's own exit status is read beside its report: a non-zero exit with no new clone, or with a count other than the pairs this lane read as new, is
    // not explained by the new clones.
    const exited = (status) => ({ diagnostics: 'diag', ended: `exited ${status}`, status })
    expect(
      unexplainedExit({ fresh: [], newClones: 0, run: exited(0) }) === undefined &&
        unexplainedExit({ fresh: [{}], newClones: 1, run: exited(1) }) === undefined &&
        unexplainedExit({ fresh: [], newClones: 0, run: exited(1) }) !== undefined &&
        unexplainedExit({ fresh: [{}], newClones: 2, run: exited(1) }) !== undefined &&
        unexplainedExit({ fresh: [{}], newClones: undefined, run: exited(1) }) !== undefined,
      'a jscpd exit was not read against its stated new-clone count',
    )

    if (failures.length > 0) {
      return result(
        1,
        '',
        `${failures.map((failure) => `✗ ${CHECK_NAME}: ${failure}`).join('\n')}\n` +
          `✗ ${CHECK_NAME}: self-test FAILED — ${SCRIPT_REL} does not detect what it claims to\n`,
      )
    }
    return result(
      0,
      `✓ ${CHECK_NAME}: self-test passed — planted copies across ts, tsx and mts/cts, a third copy of a baselined block (also one sorting between the recorded files), and an edit inside a recorded copy are red; a deleted, renamed or moved copy of a three-file block is a listed re-pairing against a base and red without one, and a copy landing beside it is noted; --update labels re-pairings and new copies by fingerprint group; a renamed two-file pair and an accepted copy stay green; an empty scan and a missing baseline fail\n`,
    )
  })
}

const USAGE = [
  `usage: node ${SCRIPT_REL} [--self-test | --update]`,
  `  (no argument)  gate: fail when a clone of the configured size is not in ${BASELINE_REL}`,
  '  --self-test    negative control: assert the gate flags planted copies and passes the baseline',
  `  --update       regenerate ${BASELINE_REL} from the current tree (a deliberate, reviewed copy)`,
].join('\n')

async function run({ args, root = ROOT, env = process.env }) {
  const unknown = args.filter((arg) => arg !== '--self-test' && arg !== '--update')
  if (unknown.length > 0 || args.length > 1) {
    return result(1, '', `✗ ${CHECK_NAME}: unrecognized argument(s): ${args.join(' ')}\n${USAGE}\n`)
  }
  if (args[0] === '--self-test') return selfTest()
  const changes = changesAgainst({ base: resolveBase({ env, root }), env, root })
  if (args[0] === '--update') return update({ changes, root })
  return check({ changes, root })
}

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
) {
  const { code, err, out } = await run({ args: process.argv.slice(2) })
  process.stdout.write(out)
  process.stderr.write(err)
  process.exitCode = code
}
