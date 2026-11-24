import * as fs from 'node:fs'
import { createRequire } from 'node:module'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execaSync } from 'execa'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { jscpdUpdateArgs } from '../../.claude/rules/check-clones.mjs'
import { disposeNodeRuntime, nodeRuntime } from './nodeRuntime.ts'

/**
 * Drives merge-jscpd-baseline.mjs through real `git merge` in scratch repos, with the registration read out of the root package.json `prepare` so
 * the shipped command is what runs. Every merge arm runs in both directions: the rule is symmetric, and a driver that quietly preferred one side
 * would still pass a single-direction arm. The synthetic-baseline blocks pin the merge rule; the last describe block runs the success criterion
 * with the real jscpd binary and the committed .jscpd.json.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const DRIVER = path.join(HERE, 'merge-jscpd-baseline.mjs')
const BASELINE = '.jscpd-baseline.json'

const PREPARE: string = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
  .scripts.prepare
const SHIPPED_DRIVER_COMMAND = /merge\.jscpd-baseline\.driver '([^']+)'/.exec(PREPARE)?.[1]
const SHIPPED_SCRIPT_PATH = SHIPPED_DRIVER_COMMAND
  ? /node (\S+)/.exec(SHIPPED_DRIVER_COMMAND)?.[1]
  : undefined

const CONFLICT_BEGIN = /^<{7}( |$)/m
const CONFLICT_END = /^>{7}( |$)/m

const dirsToClean: string[] = []

afterAll(disposeNodeRuntime)

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
}, 30_000)

// Nothing inherited may decide an arm: a developer's global merge drivers or attributes would otherwise stand in for the one under test.
function gitEnv(): Record<string, string> {
  const inheritedPath = process.env.PATH
  if (!inheritedPath)
    throw new Error('PATH is not set, so the scratch git environment cannot find git')
  return {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    // The shipped registration runs a bare `node`, which must be the private clone and never the binary a version manager may be replacing.
    PATH: `${nodeRuntime().dir}${path.delimiter}${inheritedPath}`,
  }
}

function git(dir: string, args: string[]) {
  return execaSync('git', args, { cwd: dir, env: gitEnv(), extendEnv: false, reject: false })
}

function gitOk(dir: string, args: string[]): string {
  const result = git(dir, args)
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
    )
  return result.stdout
}

function scratchDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `merge-jscpd-baseline-${prefix}-`))
  dirsToClean.push(dir)
  return dir
}

function initRepo({
  driverCommand = SHIPPED_DRIVER_COMMAND,
  registered,
}: {
  driverCommand?: string
  registered: boolean
}): string {
  const dir = scratchDir('repo')
  gitOk(dir, ['init', '-q', '-b', 'main'])
  gitOk(dir, ['config', 'user.email', 'test@example.test'])
  gitOk(dir, ['config', 'user.name', 'Test'])
  fs.writeFileSync(path.join(dir, '.gitattributes'), `${BASELINE} merge=jscpd-baseline\n`)
  if (registered) {
    if (!driverCommand || !SHIPPED_DRIVER_COMMAND || !SHIPPED_SCRIPT_PATH) {
      throw new Error(
        'no merge.jscpd-baseline.driver registration found in the root package.json `prepare`',
      )
    }
    // git runs a driver from the top of the working tree, so the registration's repo-relative script path has to resolve there.
    fs.mkdirSync(path.dirname(path.join(dir, SHIPPED_SCRIPT_PATH)), { recursive: true })
    fs.copyFileSync(DRIVER, path.join(dir, SHIPPED_SCRIPT_PATH))
    gitOk(dir, ['config', 'merge.jscpd-baseline.driver', driverCommand])
  }
  return dir
}

function commitAll(dir: string, message: string): void {
  gitOk(dir, ['add', '-A'])
  gitOk(dir, ['commit', '-q', '-m', message])
}

interface MergeOutcome {
  conflicted: boolean
  content: string
  /** git merge's exit, stdout and stderr (which relays the driver's own), for the message of every assertion. */
  log: string
  /** Whatever `afterMerge` returned for this direction's merged tree; empty when the merge conflicted or no hook was given. */
  regenerated: string
  stderr: string
}

type Direction = 'leftIntoRight' | 'rightIntoLeft'
const DIRECTIONS: Direction[] = ['leftIntoRight', 'rightIntoLeft']

// Merges the `left` branch into `right` and `right` into `left` from the same fork point, resetting between the two.
function mergeBothWays(
  dir: string,
  afterMerge?: (dir: string) => string,
): Record<Direction, MergeOutcome> {
  const outcomes = {} as Record<Direction, MergeOutcome>
  for (const direction of DIRECTIONS) {
    const [into, from] = direction === 'leftIntoRight' ? ['right', 'left'] : ['left', 'right']
    gitOk(dir, ['reset', '-q', '--hard'])
    gitOk(dir, ['checkout', '-q', into])
    const merge = git(dir, ['merge', '--no-edit', from])
    const log = `${direction}: git merge exit=${merge.exitCode} signal=${merge.signal}\n${merge.stdout}\n${merge.stderr}`
    const conflicted = merge.exitCode === 1
    if (
      merge.signal ||
      (merge.exitCode !== 0 && !conflicted) ||
      (conflicted && !fs.existsSync(path.join(dir, '.git', 'MERGE_HEAD')))
    ) {
      throw new Error(`git merge neither merged nor conflicted:\n${log}`)
    }
    const content = fs.readFileSync(path.join(dir, BASELINE), 'utf8')
    outcomes[direction] = {
      conflicted,
      content,
      log,
      regenerated: conflicted || !afterMerge ? '' : afterMerge(dir),
      stderr: String(merge.stderr),
    }
  }
  return outcomes
}

// Commits `base` on main, then `left` and `right` on their own branches; a null side leaves the file out of that branch.
function forkAndMerge({
  base,
  driverCommand,
  left,
  registered,
  right,
}: {
  base: string | null
  driverCommand?: string
  left: string
  registered: boolean
  right: string
}) {
  const dir = initRepo({ driverCommand, registered })
  const baselinePath = path.join(dir, BASELINE)
  if (base === null) fs.writeFileSync(path.join(dir, 'seed.txt'), 'seed\n')
  else fs.writeFileSync(baselinePath, base)
  commitAll(dir, 'base')
  for (const [branch, content] of [
    ['left', left],
    ['right', right],
  ] as const) {
    gitOk(dir, ['checkout', '-q', '-b', branch, 'main'])
    fs.writeFileSync(baselinePath, content)
    commitAll(dir, branch)
  }
  return mergeBothWays(dir)
}

const fp = (n: number): string => n.toString(16).padStart(16, '0')

// The committed shape: 2-space indent, trailing newline, keys ascending by code unit.
function baselineText(counts: Record<string, number>, version = 1): string {
  const fingerprints = Object.fromEntries(
    Object.entries(counts).sort(([a], [b]) => (a < b ? -1 : 1)),
  )
  // jscpd writes `version` first; entries keep Biome's alphabetical key sort off the literal.
  const document = Object.fromEntries([
    ['version', version],
    ['fingerprints', fingerprints],
  ])
  return `${JSON.stringify(document, null, 2)}\n`
}

function countsOf(keys: number[], count = 1): Record<string, number> {
  return Object.fromEntries(keys.map((n) => [fp(n), count]))
}

const without = (counts: Record<string, number>, drop: (n: number) => boolean) =>
  Object.fromEntries(Object.entries(counts).filter(([key]) => !drop(Number.parseInt(key, 16))))

describe('merge-jscpd-baseline', { timeout: 60_000 }, () => {
  describe('two branches that each remove different fingerprints', () => {
    const everything = countsOf(Array.from({ length: 400 }, (_, n) => n))
    // Interleaved so every removal on one side sits on the line next to a removal on the other, as sorted random hashes do.
    const leftRemoves = (n: number) => n % 10 === 5
    const rightRemoves = (n: number) => n % 10 === 6
    const input = {
      base: baselineText(everything),
      left: baselineText(without(everything, leftRemoves)),
      right: baselineText(without(everything, rightRemoves)),
    }

    it('conflicts under git default merge, so the arm below is not vacuous', () => {
      const outcomes = forkAndMerge({ ...input, registered: false })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(true)
        expect(outcomes[direction].content, outcomes[direction].log).toMatch(CONFLICT_BEGIN)
      }
    })

    it('merges without a conflict to a baseline lacking both sets, everything else intact, in either direction', () => {
      const expected = baselineText(without(everything, (n) => leftRemoves(n) || rightRemoves(n)))
      const outcomes = forkAndMerge({ ...input, registered: true })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(false)
        expect(outcomes[direction].content, outcomes[direction].log).toBe(expected)
      }
      expect(Object.keys(JSON.parse(expected).fingerprints)).toHaveLength(400 - 40 - 40)
    })
  })

  describe('additions', () => {
    const base = countsOf([10, 30, 50])

    it('keeps a fingerprint added on one side, sorted into place', () => {
      const added = { ...base, [fp(20)]: 1 }
      const outcomes = forkAndMerge({
        base: baselineText(base),
        left: baselineText(added),
        registered: true,
        right: baselineText(without(base, (n) => n === 50)),
      })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(false)
        expect(outcomes[direction].content, outcomes[direction].log).toBe(
          baselineText({ [fp(10)]: 1, [fp(20)]: 1, [fp(30)]: 1 }),
        )
      }
    })

    it('keeps different fingerprints added on both sides', () => {
      const outcomes = forkAndMerge({
        base: baselineText(base),
        left: baselineText({ ...base, [fp(20)]: 1 }),
        registered: true,
        right: baselineText({ ...base, [fp(40)]: 3 }),
      })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(false)
        expect(outcomes[direction].content, outcomes[direction].log).toBe(
          baselineText({ ...base, [fp(20)]: 1, [fp(40)]: 3 }),
        )
      }
    })

    it('merges a baseline added on both sides against no base file', () => {
      const outcomes = forkAndMerge({
        base: null,
        left: baselineText({ [fp(1)]: 1 }),
        registered: true,
        right: baselineText({ [fp(2)]: 2 }),
      })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(false)
        expect(outcomes[direction].content, outcomes[direction].log).toBe(
          baselineText({ [fp(1)]: 1, [fp(2)]: 2 }),
        )
      }
    })
  })

  describe('pair counts combine by delta', () => {
    it('adds both sides changes over the base count and drops a key that reaches zero', () => {
      const outcomes = forkAndMerge({
        // fp(1): 1 -> 2 on one side only; fp(2): 2 -> 1 on both sides; fp(3): removed on one side, 1 -> 2 on the other; fp(4) is untouched.
        base: baselineText({ [fp(1)]: 1, [fp(2)]: 2, [fp(3)]: 1, [fp(4)]: 7 }),
        left: baselineText({ [fp(1)]: 2, [fp(2)]: 1, [fp(4)]: 7 }),
        registered: true,
        right: baselineText({ [fp(1)]: 1, [fp(2)]: 1, [fp(3)]: 2, [fp(4)]: 7 }),
      })
      for (const direction of DIRECTIONS) {
        expect(outcomes[direction].conflicted, outcomes[direction].log).toBe(false)
        expect(outcomes[direction].content, outcomes[direction].log).toBe(
          baselineText({ [fp(1)]: 2, [fp(3)]: 1, [fp(4)]: 7 }),
        )
      }
    })
  })

  describe('a side the driver will not guess at', () => {
    const base = countsOf([1, 2, 3])
    const lines = baselineText(base).split('\n')
    const withLine = (index: number, replacement: string) =>
      lines.map((line, i) => (i === index ? replacement : line)).join('\n')
    const changedLine = (text: string) =>
      text.split('\n').find((line, i) => line !== lines[i]) ?? ''
    // Line 1 is the version, line 3 the first fingerprint; changing the same line on both sides makes git's own text merge conflict too.
    const cases: [string, string, string][] = [
      [
        'a side that is not valid JSON',
        withLine(3, `    "${fp(1)}": `),
        withLine(3, `    "${fp(1)}": 2,`),
      ],
      ['a version mismatch', withLine(1, '  "version": 2,'), withLine(1, '  "version": 3,')],
      [
        'a non-positive count',
        withLine(3, `    "${fp(1)}": 0,`),
        withLine(3, `    "${fp(1)}": 2,`),
      ],
      [
        'a key that is not a fingerprint',
        withLine(3, '    "not-a-fingerprint": 1,'),
        withLine(3, `    "${fp(1)}": 2,`),
      ],
    ]

    it.each(cases)('stops %s as a conflict with both sides in the file', (_name, left, right) => {
      const outcomes = forkAndMerge({ base: baselineText(base), left, registered: true, right })
      for (const direction of DIRECTIONS) {
        const { conflicted, content, log, stderr } = outcomes[direction]
        expect(conflicted, log).toBe(true)
        expect(stderr, log).toContain('merge-jscpd-baseline')
        expect(content, log).toMatch(CONFLICT_BEGIN)
        expect(content, log).toMatch(CONFLICT_END)
        expect(content, log).toContain(changedLine(left))
        expect(content, log).toContain(changedLine(right))
      }
    })

    it('stops a version mismatch as a conflict even when git alone would merge the text cleanly', () => {
      const outcomes = forkAndMerge({
        base: baselineText(base),
        left: withLine(1, '  "version": 2,'),
        registered: true,
        right: baselineText(without(base, (n) => n === 3)),
      })
      for (const direction of DIRECTIONS) {
        const { conflicted, content, log } = outcomes[direction]
        expect(conflicted, log).toBe(true)
        expect(content, log).toMatch(CONFLICT_BEGIN)
        expect(content, log).toMatch(CONFLICT_END)
        expect(() => JSON.parse(content), log).toThrow()
      }
    })
  })

  // A driver that cannot run must leave git's own merge, never ours verbatim and unmarked: the exit 1 of a missing script is the driver's own conflict exit,
  // so the registration also checks that the script exists.
  describe('a registration whose driver cannot run', () => {
    const base = countsOf([1, 2, 3])
    const left = { ...base, [fp(1)]: 2 }
    const right = { ...base, [fp(1)]: 3 }
    const withoutScript = SHIPPED_DRIVER_COMMAND?.replaceAll(
      SHIPPED_SCRIPT_PATH ?? '',
      'tools/scripts/absent.mjs',
    )
    const withoutTheirs = SHIPPED_DRIVER_COMMAND?.replace('%A %B %L %P', '%A "" %L %P')

    it.each([
      ['a script path that does not exist (node exits 1)', withoutScript, 'absent.mjs'],
      [
        'a dropped placeholder (the driver exits 2)',
        withoutTheirs,
        'expected at least three paths',
      ],
    ])('falls back to git merge with markers for %s', (_name, driverCommand, stderrMark) => {
      const outcomes = forkAndMerge({
        base: baselineText(base),
        driverCommand,
        left: baselineText(left),
        registered: true,
        right: baselineText(right),
      })
      for (const direction of DIRECTIONS) {
        const { conflicted, content, log, stderr } = outcomes[direction]
        expect(stderr, log).toContain(stderrMark)
        expect(conflicted, log).toBe(true)
        expect(content, log).toMatch(CONFLICT_BEGIN)
        expect(content, log).toMatch(CONFLICT_END)
        expect(content, log).toContain(`"${fp(1)}": 2`)
        expect(content, log).toContain(`"${fp(1)}": 3`)
      }
    })
  })

  // Every driver registration in `prepare` stands unchained and ends in `|| true`: a `&&` would let a failing step skip it, and a bare failure would
  // fail the install. The jscpd registration ends `prepare` here, so nothing follows its `|| true`.
  describe('the prepare registrations', () => {
    const registrations = [
      ...PREPARE.matchAll(
        /(?<=^|; )git config --replace-all merge\.([\w-]+)\.driver '[^']*' \|\| true(?:;|$)/g,
      ),
    ]

    it('registers every driver unchained, ending in `|| true`', () => {
      expect(registrations.map((match) => match[1])).toEqual(['jscpd-baseline'])
      expect(PREPARE.match(/merge\.[\w-]+\.driver/g)).toHaveLength(registrations.length)
    })

    it('hands the jscpd driver every placeholder it reads', () => {
      expect(SHIPPED_DRIVER_COMMAND).toContain('merge-jscpd-baseline.mjs %O %A %B %L %P')
    })
  })

  describe('invoked directly', () => {
    function inputs(ours: string, theirs: string) {
      const dir = scratchDir('direct')
      const paths = {
        base: path.join(dir, 'base'),
        ours: path.join(dir, 'ours'),
        theirs: path.join(dir, 'theirs'),
      }
      fs.writeFileSync(paths.base, baselineText(countsOf([1, 2])))
      fs.writeFileSync(paths.ours, ours)
      fs.writeFileSync(paths.theirs, theirs)
      return { dir, paths }
    }
    const runDriver = (args: string[]) =>
      execaSync(nodeRuntime().path, [DRIVER, ...args], {
        env: gitEnv(),
        extendEnv: false,
        reject: false,
      })

    it('exits 0, writes the merged file, and leaves no temp file beside it', () => {
      const { dir, paths } = inputs(baselineText(countsOf([1])), baselineText(countsOf([1, 2, 3])))
      const result = runDriver([paths.base, paths.ours, paths.theirs, '7', BASELINE])
      expect(result.exitCode, String(result.stderr)).toBe(0)
      expect(fs.readFileSync(paths.ours, 'utf8')).toBe(baselineText(countsOf([1, 3])))
      expect(fs.readdirSync(dir).sort()).toEqual(['base', 'ours', 'theirs'])
    })

    it('exits 1 with git markers at the requested width, and no temp file, when a side is unreadable as a baseline', () => {
      const { dir, paths } = inputs('{ not json\n', baselineText(countsOf([1, 2, 3])))
      const result = runDriver([paths.base, paths.ours, paths.theirs, '9', BASELINE])
      expect(result.exitCode, String(result.stderr)).toBe(1)
      expect(fs.readFileSync(paths.ours, 'utf8')).toMatch(/^<{9}( |$)/m)
      expect(fs.readdirSync(dir).sort()).toEqual(['base', 'ours', 'theirs'])
    })

    it('exits 1 with the sides wrapped whole in one marker block at the requested width when git finds no textual conflict', () => {
      const { dir, paths } = inputs(baselineText(countsOf([1, 2]), 2), baselineText(countsOf([1])))
      const result = runDriver([paths.base, paths.ours, paths.theirs, '9', BASELINE])
      const content = fs.readFileSync(paths.ours, 'utf8')
      expect(result.exitCode, String(result.stderr)).toBe(1)
      expect(content).toMatch(/^<{9} ours$/m)
      expect(content).toMatch(/^={9}$/m)
      expect(content).toMatch(/^>{9} theirs$/m)
      expect(content).toContain(baselineText(countsOf([1, 2]), 2))
      expect(content).toContain(baselineText(countsOf([1])))
      expect(() => JSON.parse(content)).toThrow()
      expect(fs.readdirSync(dir).sort()).toEqual(['base', 'ours', 'theirs'])
    })

    const document = (fingerprints: Record<string, number>, extra: Record<string, unknown> = {}) =>
      `${JSON.stringify({ fingerprints, version: 1, ...extra })}\n`
    it.each([
      ['an extra top-level key', document(countsOf([1]), { extra: true }), 'top-level keys beyond'],
      [
        'a fingerprint of 15 hex digits',
        document({ [fp(1).slice(1)]: 1 }),
        'malformed fingerprint',
      ],
      [
        'an uppercase fingerprint',
        document({ [fp(255).toUpperCase()]: 1 }),
        'malformed fingerprint',
      ],
      ['a fractional count', document({ [fp(1)]: 1.5 }), 'malformed fingerprint'],
      ['a count beyond the safe integers', document({ [fp(1)]: 1e300 }), 'malformed fingerprint'],
    ])('refuses %s with its own reason and a file that cannot parse', (_name, ours, reason) => {
      const { paths } = inputs(ours, baselineText(countsOf([1, 2, 3])))
      const result = runDriver([paths.base, paths.ours, paths.theirs, '7', BASELINE])
      expect(result.exitCode, String(result.stderr)).toBe(1)
      expect(String(result.stderr)).toContain(reason)
      expect(() => JSON.parse(fs.readFileSync(paths.ours, 'utf8'))).toThrow()
    })

    it('exits 2 and leaves %A as it was when the base is unreadable, rather than treating it as empty', () => {
      const { dir, paths } = inputs(baselineText(countsOf([1])), baselineText(countsOf([1, 2])))
      const before = fs.readFileSync(paths.ours, 'utf8')
      const result = runDriver([path.join(dir, 'absent'), paths.ours, paths.theirs, '7', BASELINE])
      expect(result.exitCode, String(result.stderr)).toBe(2)
      expect(fs.readFileSync(paths.ours, 'utf8')).toBe(before)
    })

    it('exits 2 and leaves %A as it was when it cannot even run the fallback', () => {
      const { paths } = inputs(baselineText(countsOf([1])), baselineText(countsOf([1, 2])))
      const before = fs.readFileSync(paths.ours, 'utf8')
      const missingArgs = runDriver([paths.base, paths.ours])
      expect(missingArgs.exitCode).toBe(2)
      expect(String(missingArgs.stderr)).toContain('expected at least three paths')
      const missingTheirs = runDriver([
        paths.base,
        paths.ours,
        path.join(path.dirname(paths.ours), 'absent'),
      ])
      expect(missingTheirs.exitCode).toBe(2)
      expect(fs.readFileSync(paths.ours, 'utf8')).toBe(before)
    })
  })
})

describe('the real .gitattributes', () => {
  it('attaches the driver to the baseline and to nothing near it', () => {
    const mergeAttr = (file: string) =>
      gitOk(REPO_ROOT, ['check-attr', 'merge', '--', file]).split(': ').at(-1)
    expect(mergeAttr(BASELINE)).toBe('jscpd-baseline')
    // Negative controls: the same call would not distinguish a pattern that matched everything.
    expect(mergeAttr('package.json')).toBe('unspecified')
    expect(mergeAttr('.jscpd.json')).toBe('unspecified')
  })
})

describe('the success criterion with the real jscpd and the committed .jscpd.json', {
  timeout: 60_000,
}, () => {
  function jscpdBin(): string {
    const pkgPath = createRequire(path.join(REPO_ROOT, 'package.json')).resolve(
      'jscpd/package.json',
    )
    const pkg: { bin: string | Record<string, string> } = JSON.parse(
      fs.readFileSync(pkgPath, 'utf8'),
    )
    return path.join(path.dirname(pkgPath), typeof pkg.bin === 'string' ? pkg.bin : pkg.bin.jscpd)
  }

  // The lane's own --update flags, run from the scratch repo root as the lane runs from the repository root.
  function regenerate(dir: string): string {
    const run = execaSync(nodeRuntime().path, [jscpdBin(), ...jscpdUpdateArgs(BASELINE)], {
      cwd: dir,
      reject: false,
    })
    if (run.exitCode !== 0)
      throw new Error(`jscpd exited ${run.exitCode}:\n${run.stdout}\n${run.stderr}`)
    return fs.readFileSync(path.join(dir, BASELINE), 'utf8')
  }

  const fingerprintsIn = (text: string): string[] => Object.keys(JSON.parse(text).fingerprints)

  // Every line carries the tag, so blocks with different tags share no run of tokens long enough to be a clone.
  const block = (tag: string): string =>
    `${Array.from({ length: 14 }, (_, i) => `export const ${tag}Value${i} = compute${tag}(${i}, '${tag}-${i}')`).join('\n')}\n`
  const copy = (pair: string, which: 'one' | 'two') => `src/fixture/${pair}-${which}.ts`

  it('merges two branches that each consolidate a different clone to the baseline regenerated from the merged tree', () => {
    const dir = initRepo({ registered: true })
    fs.copyFileSync(path.join(REPO_ROOT, '.jscpd.json'), path.join(dir, '.jscpd.json'))
    // Two pairs survive both merges, so the merged file's key order is compared against jscpd's own ordering, not just one key.
    for (const pair of ['pairA', 'pairB', 'pairC', 'pairD']) {
      for (const which of ['one', 'two'] as const) {
        fs.mkdirSync(path.join(dir, 'src/fixture'), { recursive: true })
        fs.writeFileSync(path.join(dir, copy(pair, which)), block(pair))
      }
    }
    const baseFingerprints = fingerprintsIn(regenerate(dir))
    // A scan that analyzed nothing would produce an empty baseline, which every later equality below would satisfy.
    expect(baseFingerprints).toHaveLength(4)
    commitAll(dir, 'base')

    for (const [branch, pair] of [
      ['left', 'pairA'],
      ['right', 'pairB'],
    ] as const) {
      gitOk(dir, ['checkout', '-q', '-b', branch, 'main'])
      fs.rmSync(path.join(dir, copy(pair, 'two')))
      expect(fingerprintsIn(regenerate(dir)), branch).toHaveLength(3)
      commitAll(dir, branch)
    }

    // From scratch rather than from the merged file, so the reference does not depend on what the merge left behind.
    const outcomes = mergeBothWays(dir, () => {
      fs.rmSync(path.join(dir, BASELINE))
      return regenerate(dir)
    })
    for (const direction of DIRECTIONS) {
      const { conflicted, content, log, regenerated } = outcomes[direction]
      expect(conflicted, log).toBe(false)
      expect(fingerprintsIn(regenerated), log).toHaveLength(2)
      expect(content, log).toBe(regenerated)
    }
  })
})
