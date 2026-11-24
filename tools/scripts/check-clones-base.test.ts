import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { execaSync } from 'execa'
import { afterAll, afterEach, describe, expect, it } from 'vitest'

import { changesAgainst, check, resolveBase, update } from '../../.claude/rules/check-clones.mjs'
import { disposeNodeRuntime, nodeRuntime } from './nodeRuntime.ts'

/**
 * Drives the base resolution, change classification and post-merge verdict of the clone gate (.claude/rules/check-clones.mjs) through real git
 * repositories. The lane's self-test injects the classification it would otherwise ask git for, so it cannot pin anything git-derived: which base
 * the local run resolves, what counts as changed against it, and that a merged deletion is green on the merged tree itself.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.join(HERE, '..', '..')
const BASELINE = '.jscpd-baseline.json'

const dirsToClean: string[] = []

afterEach(() => {
  for (const dir of dirsToClean.splice(0)) fs.rmSync(dir, { force: true, recursive: true })
}, 30_000)

afterAll(disposeNodeRuntime)

// Nothing inherited may decide an arm: a developer's global git config would otherwise stand in for the repository's. The lane runs git with the env
// it is given, so this is also the env handed to the lane, and no CI variable of the machine running the test leaks in.
function gitEnv(extra: Record<string, string> = {}): Record<string, string> {
  const inheritedPath = process.env.PATH
  if (!inheritedPath)
    throw new Error('PATH is not set, so the scratch git environment cannot find git')
  return {
    GIT_ATTR_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    PATH: inheritedPath,
    ...extra,
  }
}

function gitOk(dir: string, args: string[]): string {
  const result = execaSync('git', args, {
    cwd: dir,
    env: gitEnv(),
    extendEnv: false,
    reject: false,
  })
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(' ')} exited ${result.exitCode}:\n${result.stdout}\n${result.stderr}`,
    )
  return result.stdout.trim()
}

// realpath because os.tmpdir() is behind a symlink on macOS and git reports physical paths.
function scratchDir(prefix: string): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), `check-clones-base-${prefix}-`)),
  )
  dirsToClean.push(dir)
  return dir
}

function configure(dir: string): void {
  gitOk(dir, ['config', 'user.email', 'test@example.test'])
  gitOk(dir, ['config', 'user.name', 'Test'])
  gitOk(dir, ['config', 'commit.gpgsign', 'false'])
}

function newRepo(prefix: string, branch = 'main'): string {
  const dir = scratchDir(prefix)
  gitOk(dir, ['init', '-q', '-b', branch])
  configure(dir)
  return dir
}

function write(dir: string, rel: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true })
  fs.writeFileSync(path.join(dir, rel), content)
}

function commitAll(dir: string, message: string): string {
  gitOk(dir, ['add', '-A'])
  gitOk(dir, ['commit', '-q', '-m', message])
  return gitOk(dir, ['rev-parse', 'HEAD'])
}

function commitFile(dir: string, rel: string, content: string, message: string): string {
  write(dir, rel, content)
  return commitAll(dir, message)
}

// A bare origin whose first commit `seed` pushed; `seed` also stands in for another developer pushing to it later.
function makeOrigin(): { bare: string; seed: string } {
  const bare = scratchDir('origin')
  gitOk(bare, ['init', '--bare', '-q', '-b', 'main'])
  const seed = newRepo('seed')
  gitOk(seed, ['remote', 'add', 'origin', bare])
  commitFile(seed, 'seed.txt', 'seed\n', 'c1')
  gitOk(seed, ['push', '-q', 'origin', 'main'])
  return { bare, seed }
}

function cloneOf(bare: string): string {
  const dir = scratchDir('work')
  gitOk(dir, ['clone', '-q', bare, '.'])
  configure(dir)
  return dir
}

const lines = (tag: string): string =>
  `${Array.from({ length: 14 }, (_, i) => `${tag} line ${i}`).join('\n')}\n`

type Changes = ReturnType<typeof changesAgainst>
const unchangedOf = (changes: Changes): ReadonlySet<string> => {
  if (changes.unchanged === undefined)
    throw new Error(`base did not resolve: ${changes.unfiltered}`)
  return changes.unchanged
}

describe('check-clones base resolution', { timeout: 60_000 }, () => {
  describe('classifying the working tree against a base', () => {
    const A = lines('alpha')
    const B = lines('beta')
    const MOVED = 'src/moved-1.txt'
    const COPY = 'src/moved-2.txt'
    const plainMv = (dir: string, from: string, to: string) =>
      fs.renameSync(path.join(dir, from), path.join(dir, to))
    const append = (dir: string, rel: string) =>
      fs.appendFileSync(path.join(dir, rel), 'one more line\n')

    // Every file, symlink and directory entry on disk outside a .git directory: the paths jscpd could name. The classification answers for each of them,
    // and a path it cannot vouch for is changed.
    function pathsOnDisk(dir: string, rel = ''): string[] {
      return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).flatMap((entry) => {
        const child = rel === '' ? entry.name : `${rel}/${entry.name}`
        if (entry.name === '.git') return []
        return entry.isDirectory() ? pathsOnDisk(dir, child) : [child]
      })
    }

    // [row, what the working tree does after the base commit, the paths that count as changed]
    const rows: [string, (dir: string) => void, string[]][] = [
      ['an unmodified tree changes nothing', () => {}, []],
      [
        'a committed git mv is unchanged',
        (dir) => {
          gitOk(dir, ['mv', 'src/a.txt', MOVED])
          commitAll(dir, 'rename')
        },
        [],
      ],
      [
        'a staged, uncommitted git mv is unchanged',
        (dir) => gitOk(dir, ['mv', 'src/a.txt', MOVED]),
        [],
      ],
      [
        'a plain filesystem move (deleted + untracked) is unchanged',
        (dir) => plainMv(dir, 'src/a.txt', MOVED),
        [],
      ],
      ['an edited file is changed', (dir) => append(dir, 'src/b.txt'), ['src/b.txt']],
      [
        'a new committed file is changed',
        (dir) => {
          commitFile(dir, 'src/new.txt', lines('gamma'), 'add')
        },
        ['src/new.txt'],
      ],
      [
        'a new untracked file is changed',
        (dir) => write(dir, 'src/new.txt', lines('gamma')),
        ['src/new.txt'],
      ],
      [
        'a committed rename with an edit is changed',
        (dir) => {
          gitOk(dir, ['mv', 'src/a.txt', MOVED])
          append(dir, MOVED)
          commitAll(dir, 'rename and edit')
        },
        [MOVED],
      ],
      [
        'a plain move then an edit is changed',
        (dir) => {
          plainMv(dir, 'src/a.txt', MOVED)
          append(dir, MOVED)
        },
        [MOVED],
      ],
      [
        // Deleted blobs are paired with untracked paths in sorted order, one to one: the first copy is the move, the second is new content.
        'an untracked identical second copy of a moved file is changed, the first copy is the move',
        (dir) => {
          plainMv(dir, 'src/a.txt', MOVED)
          write(dir, COPY, A)
        },
        [COPY],
      ],
      [
        'an untracked copy of a file that still exists is changed, whatever else was deleted',
        (dir) => {
          write(dir, COPY, A)
          fs.rmSync(path.join(dir, 'src/b.txt'))
        },
        [COPY],
      ],
      [
        // On macOS (core.ignorecase) a case-only rename is the same class and cannot be reproduced on Linux: jscpd names a spelling git does not list.
        'an untracked file git ignores is changed',
        (dir) => {
          fs.appendFileSync(path.join(dir, '.git/info/exclude'), 'src/hidden.txt\n')
          write(dir, 'src/hidden.txt', lines('gamma'))
        },
        ['src/hidden.txt'],
      ],
      [
        'an edit to a tracked file marked assume-unchanged is changed',
        (dir) => {
          gitOk(dir, ['update-index', '--assume-unchanged', 'src/b.txt'])
          append(dir, 'src/b.txt')
        },
        ['src/b.txt'],
      ],
      [
        'a tracked file marked skip-worktree is changed',
        (dir) => gitOk(dir, ['update-index', '--skip-worktree', 'src/b.txt']),
        ['src/b.txt'],
      ],
      [
        'a dangling untracked symlink beside a deleted file is changed and the move is still matched',
        (dir) => {
          plainMv(dir, 'src/a.txt', MOVED)
          fs.symlinkSync('nowhere', path.join(dir, 'src/dangling'))
        },
        ['src/dangling'],
      ],
      [
        'an untracked nested git repository beside a deleted file is changed and the move is still matched',
        (dir) => {
          plainMv(dir, 'src/a.txt', MOVED)
          fs.mkdirSync(path.join(dir, 'tools/helper'), { recursive: true })
          gitOk(path.join(dir, 'tools/helper'), ['init', '-q'])
          write(dir, 'tools/helper/helper.txt', lines('delta'))
        },
        ['tools/helper/helper.txt'],
      ],
    ]

    it.each(rows)('%s', (name, mutate, changed) => {
      const dir = newRepo('classify')
      write(dir, 'src/a.txt', A)
      write(dir, 'src/b.txt', B)
      const sha = commitAll(dir, 'base')
      mutate(dir)
      const result = changesAgainst({ base: { label: 'test base', sha }, env: gitEnv(), root: dir })
      expect(result.label, name).toBe('test base')
      expect(
        pathsOnDisk(dir)
          .filter((rel) => !unchangedOf(result).has(rel))
          .sort(),
        name,
      ).toEqual(changed)
    })

    it('passes an unresolved base through', () => {
      expect(
        changesAgainst({ base: { unfiltered: 'why' }, env: gitEnv(), root: newRepo('x') }),
      ).toEqual({
        unfiltered: 'why',
      })
    })
  })

  describe('the local base', () => {
    const env = gitEnv()

    // main at c1 and `feature` one commit ahead; the returned worktree forks from feature and records it, as `/start wt` does.
    function forkWorktree(): { c1: string; c2: string; wt: string } {
      const repo = newRepo('repo')
      const c1 = commitFile(repo, 'a.txt', 'a\n', 'c1')
      gitOk(repo, ['checkout', '-q', '-b', 'feature'])
      const c2 = commitFile(repo, 'b.txt', 'b\n', 'c2')
      gitOk(repo, ['checkout', '-q', 'main'])
      gitOk(repo, ['config', 'extensions.worktreeConfig', 'true'])
      const wt = path.join(scratchDir('wt'), 'wt')
      gitOk(repo, ['worktree', 'add', '-q', '-b', 'wt', wt, 'feature'])
      commitFile(wt, 'c.txt', 'c\n', 'c3')
      return { c1, c2, wt }
    }

    it('is the merge base with the fork branch a worktree records', async () => {
      const { c2, wt } = forkWorktree()
      gitOk(wt, ['config', '--worktree', 'start.source-branch', 'feature'])
      expect(await resolveBase({ env, root: wt })).toEqual({
        label: 'fork branch feature',
        sha: c2,
      })
    })

    it('falls back to the default branch when the recorded fork branch does not exist', async () => {
      const { c1, wt } = forkWorktree()
      gitOk(wt, ['config', '--worktree', 'start.source-branch', 'vanished'])
      expect(await resolveBase({ env, root: wt })).toEqual({
        label: 'default branch main',
        sha: c1,
      })
    })

    it("is the merge base with the fork branch's remote ref when there is no local branch of that name", async () => {
      const { bare, seed } = makeOrigin()
      gitOk(seed, ['checkout', '-q', '-b', 'feature'])
      commitFile(seed, 'feature.txt', 'f\n', 'c2')
      gitOk(seed, ['push', '-q', 'origin', 'feature'])
      const work = cloneOf(bare)
      const main = gitOk(work, ['rev-parse', 'HEAD'])
      gitOk(work, ['config', '--worktree', 'start.source-branch', 'feature'])
      commitFile(work, 'topic.txt', 't\n', 'c3')
      expect(await resolveBase({ env, root: work })).toEqual({
        label: 'fork branch feature',
        sha: main,
      })
    })

    it("is the merge base with origin's HEAD branch, ahead of a local main", async () => {
      const { bare, seed } = makeOrigin()
      gitOk(seed, ['checkout', '-q', '-b', 'develop'])
      const develop = commitFile(seed, 'develop.txt', 'd\n', 'c2')
      gitOk(seed, ['push', '-q', 'origin', 'develop'])
      gitOk(bare, ['symbolic-ref', 'HEAD', 'refs/heads/develop'])
      const work = cloneOf(bare)
      gitOk(work, ['branch', 'main', 'origin/main'])
      commitFile(work, 'topic.txt', 't\n', 'c3')
      expect(await resolveBase({ env, root: work })).toEqual({
        label: 'default branch develop',
        sha: develop,
      })
    })

    it('is the merge base with origin/main from a clone with no local main', async () => {
      const { bare } = makeOrigin()
      const work = cloneOf(bare)
      const main = gitOk(work, ['rev-parse', 'HEAD'])
      gitOk(work, ['checkout', '-q', '-b', 'topic'])
      gitOk(work, ['branch', '-D', 'main'])
      commitFile(work, 'topic.txt', 't\n', 'c2')
      expect(await resolveBase({ env, root: work })).toEqual({
        label: 'default branch main',
        sha: main,
      })
    })

    it('is the merge base with a local main when there is no origin', async () => {
      const repo = newRepo('repo')
      const c1 = commitFile(repo, 'a.txt', 'a\n', 'c1')
      gitOk(repo, ['checkout', '-q', '-b', 'topic'])
      commitFile(repo, 'b.txt', 'b\n', 'c2')
      expect(await resolveBase({ env, root: repo })).toEqual({
        label: 'default branch main',
        sha: c1,
      })
    })

    it('resolves nothing, saying why, with no record and no main', async () => {
      const repo = newRepo('repo', 'trunk')
      commitFile(repo, 'a.txt', 'a\n', 'c1')
      expect(await resolveBase({ env, root: repo })).toEqual({
        unfiltered: expect.stringContaining('no default branch'),
      })
    })
  })

  // The real jscpd with the committed .jscpd.json: a block carried by a (12 lines) and b, c (the block plus a 6-line tail), the shape in which deleting
  // the anchoring copy makes jscpd re-pair the survivors under a fingerprint the baseline never recorded.
  describe('the verdict end to end with the real jscpd', () => {
    const tsBlock = (tag: string, length: number) =>
      Array.from(
        { length },
        (_, i) => `const ${tag}Value${i} = compute${tag}(${i}, '${tag}-${i}')`,
      ).join('\n')
    const BLOCK = tsBlock('triBlock', 12)
    const family = (name: string) => `src/fixture/${name}.ts`
    const a = family('a')
    const b = family('b')
    const c = family('c')
    const d = family('d')
    // A recorded pair the changes below leave alone, so the fresh pairs are a strict subset of the reported ones, and a clone-free file to copy.
    const survivorOne = family('survivor-one')
    const survivorTwo = family('survivor-two')
    const solo = family('solo')
    const checkAgainst = (classify: NonNullable<Parameters<typeof changesAgainst>[0]>) =>
      check({
        changes: changesAgainst(classify),
        node: nodeRuntime().path,
        root: classify.root,
      })
    const namesBoth = (text: string, first: string, second: string) =>
      text.split('\n').some((line) => line.includes(`${first}:`) && line.includes(`${second}:`))
    const baselineIn = (dir: string) => fs.readFileSync(path.join(dir, BASELINE), 'utf8')

    // The independent oracle: jscpd run directly with the lane's scan flags, never through the lane. Its report says which pairs are new.
    function jscpdBin(): string {
      const dir = path.join(REPO_ROOT, 'node_modules', 'jscpd')
      const { bin } = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
      return path.join(dir, typeof bin === 'string' ? bin : bin.jscpd)
    }
    const pairKey = (clone: {
      firstFile: { name: string; start: number; end: number }
      secondFile: { name: string; start: number; end: number }
    }) =>
      `${clone.firstFile.name}:${clone.firstFile.start}-${clone.firstFile.end} duplicates ${clone.secondFile.name}:${clone.secondFile.start}-${clone.secondFile.end}`
    function oracle(dir: string): { all: number; fresh: string[] } {
      const out = scratchDir('oracle')
      const ran = execaSync(
        nodeRuntime().path,
        [
          jscpdBin(),
          '--config',
          '.jscpd.json',
          '--baseline',
          BASELINE,
          '--reporters',
          'json',
          '--output',
          out,
          '--fail-on-empty',
          '--fail-on-new-clones',
          '--no-colors',
        ],
        { cwd: dir, reject: false },
      )
      expect(ran.exitCode, ran.stderr).toBe(1)
      const report: { duplicates: (Parameters<typeof pairKey>[0] & { isNew?: boolean })[] } =
        JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8'))
      return {
        all: report.duplicates.length,
        fresh: report.duplicates
          .filter((clone) => clone.isNew === true)
          .map(pairKey)
          .sort(),
      }
    }
    // The pairs a lane output names, as `file:start-end duplicates file:start-end`.
    const namedPairs = (text: string): string[] =>
      text
        .split('\n')
        .map(
          (line) =>
            /^\s*(?:\[[a-z -]+\] )?(\S+:\d+-\d+ duplicates \S+:\d+-\d+) \(\d+ lines\)$/u.exec(
              line,
            )?.[1],
        )
        .filter((pair): pair is string => pair !== undefined)
        .sort()

    function recordedFamily(): { before: string; dir: string } {
      const dir = newRepo('family')
      fs.copyFileSync(path.join(REPO_ROOT, '.jscpd.json'), path.join(dir, '.jscpd.json'))
      write(dir, a, `${BLOCK}\n`)
      write(dir, b, `${BLOCK}\n${tsBlock('triTail', 6)}\n`)
      write(dir, c, `${BLOCK}\n${tsBlock('triTail', 6)}\n`)
      write(dir, survivorOne, `${tsBlock('survivor', 14)}\n`)
      write(dir, survivorTwo, `${tsBlock('survivor', 14)}\n`)
      write(dir, solo, `${tsBlock('solo', 14)}\n`)
      const recorded = update({ node: nodeRuntime().path, root: dir })
      expect(recorded.code, JSON.stringify(recorded)).toBe(0)
      // The copy --update stages sits beside the baseline, on its filesystem, and is gone once the rename is done.
      expect(fs.readdirSync(dir).filter((name) => name.startsWith(`${BASELINE}.`))).toEqual([])
      commitAll(dir, 'base')
      return { before: gitOk(dir, ['rev-parse', 'HEAD']), dir }
    }

    function mergeDeletion(dir: string): void {
      gitOk(dir, ['checkout', '-q', '-b', 'drop-anchor'])
      gitOk(dir, ['rm', '-q', a])
      commitAll(dir, 'drop anchor')
      gitOk(dir, ['checkout', '-q', 'main'])
      gitOk(dir, ['merge', '-q', '--no-ff', '-m', 'merge drop-anchor', 'drop-anchor'])
    }

    // On the merged tree itself nothing is changed against the base (main's merge base with HEAD is HEAD), so the survivors' re-pairing is accepted.
    it('is green on the merged tree after a deletion merged into it, with the baseline untouched', () => {
      const { dir } = recordedFamily()
      const baseline = baselineIn(dir)
      mergeDeletion(dir)
      const merged = gitOk(dir, ['rev-parse', 'HEAD'])

      const env = gitEnv()
      const base = resolveBase({ env, root: dir })
      expect(base).toEqual({ label: 'default branch main', sha: merged })
      const changes = changesAgainst({ base, env, root: dir })
      expect(changes.label).toBe('default branch main')
      expect(
        [b, c, survivorOne, survivorTwo, solo].filter((file) => !unchangedOf(changes).has(file)),
      ).toEqual([])

      const result = check({ changes, node: nodeRuntime().path, root: dir })
      expect(result.code, JSON.stringify(result)).toBe(0)
      expect(result.out, result.out).toContain(
        'accepted as re-pairings against default branch main',
      )
      expect(namesBoth(result.out, b, c), result.out).toBe(true)
      expect(baselineIn(dir)).toBe(baseline)
    })

    it('is the shipped gate, saying it is unfiltered, for a run with no default branch', () => {
      const { dir } = recordedFamily()
      mergeDeletion(dir)
      gitOk(dir, ['branch', '-m', 'main', 'trunk'])

      const env = gitEnv()
      const base = resolveBase({ env, root: dir })
      expect(base, 'a base resolved').toEqual({ unfiltered: expect.any(String) })
      const result = checkAgainst({ base, env, root: dir })
      expect(result.code, JSON.stringify(result)).toBe(1)
      expect(result.err, result.err).toContain('unfiltered:')
      expect(namesBoth(result.err, b, c), result.err).toBe(true)

      // The lane's red is the oracle's verdict: the pairs jscpd itself reports as new, and none of the pairs it reports as recorded.
      const expected = oracle(dir)
      expect(expected.fresh.length, 'the oracle found nothing new').toBeGreaterThan(0)
      expect(
        expected.all,
        'every reported pair is new, so the oracle cannot tell fresh from recorded',
      ).toBeGreaterThan(expected.fresh.length)
      expect(namedPairs(result.err)).toEqual(expected.fresh)
      expect(result.err).toMatch(
        new RegExp(`^✗ clone check: ${expected.fresh.length} new clone\\(s\\)`, 'u'),
      )
      expect(result.err).not.toContain(survivorOne)
    })

    it('stays red for a further copy of the block on a branch, naming the new file', async () => {
      const { before, dir } = recordedFamily()
      gitOk(dir, ['checkout', '-q', '-b', 'copy-block'])
      commitFile(dir, d, `${BLOCK}\n`, 'copy the block')

      const env = gitEnv()
      const base = await resolveBase({ env, root: dir })
      expect(base).toEqual({ label: 'default branch main', sha: before })
      const result = checkAgainst({ base, env, root: dir })
      expect(result.code, JSON.stringify(result)).toBe(1)
      expect(result.err, result.err).toContain(`${d}:`)
      expect(result.err, result.err).toContain('judged against default branch main')
    })

    // jscpd scans a nested repository's files, which git lists only as the directory: a path git does not name is not vouched for, so it is changed.
    it('stays red for a copy inside an untracked nested repository', async () => {
      const { before, dir } = recordedFamily()
      const nested = 'src/fixture/nested/copy.ts'
      fs.mkdirSync(path.join(dir, 'src/fixture/nested'), { recursive: true })
      gitOk(path.join(dir, 'src/fixture/nested'), ['init', '-q'])
      write(dir, nested, `${tsBlock('solo', 14)}\n`)

      const env = gitEnv()
      const base = await resolveBase({ env, root: dir })
      expect(base).toEqual({ label: 'default branch main', sha: before })
      const result = checkAgainst({ base, env, root: dir })
      expect(result.code, JSON.stringify(result)).toBe(1)
      expect(namesBoth(result.err, solo, nested), result.err).toBe(true)
    })

    // The `node` option must reach every spawn of jscpd: a shim counts the launches it receives and hands over to the real runtime.
    it('runs every jscpd launch of check and update through the node it is given', () => {
      const { dir } = recordedFamily()
      const log = path.join(scratchDir('shim'), 'launches')
      const shim = path.join(path.dirname(log), 'node-shim')
      fs.writeFileSync(shim, `#!/bin/sh\necho x >> '${log}'\nexec '${nodeRuntime().path}' "$@"\n`, {
        mode: 0o755,
      })
      const launches = () =>
        fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').length - 1 : 0

      const checked = check({ node: shim, root: dir })
      expect(checked.code, JSON.stringify(checked)).toBe(0)
      expect(launches(), 'check launches jscpd once').toBe(1)

      const updated = update({ node: shim, root: dir })
      expect(updated.code, JSON.stringify(updated)).toBe(0)
      expect(launches() - 1, 'update scans the tree, then records it').toBe(2)
    })
  })
})
