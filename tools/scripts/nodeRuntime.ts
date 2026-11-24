import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { execaSync, type SyncResult } from 'execa'

/**
 * A private clone of the node binary for anything here whose subprocesses run `node`, directly or through a PATH shim. Not a test file, so vitest does not
 * collect it; each importing process gets its own clone and removes it with `disposeNodeRuntime`.
 */

export interface NodeRuntime {
  dir: string
  path: string
  source: string
  version: string
}

// Every node spawned by a test here runs under a private clone, never the binary process.execPath names: a version manager re-activating node (a git
// hook can, on every commit on the machine) replaces that binary by deleting it and re-copying it, and a node spawned meanwhile exits 127 if the binary
// is missing, dies at exec if it is partially copied, or exits 0 without running if it is zero-length. A clone is accepted only if the source held
// still across the copy.
const CLONE_ATTEMPTS = 12
const CLONE_RETRY_MS = 250

function describeStat({ ino, mtimeMs, size }: fs.Stats): string {
  return `ino=${ino} size=${size} mtimeMs=${mtimeMs}`
}

// A subprocess's exit, signal and output as one assertion message. `git merge` relays the driver's stderr, so a merge
// that went wrong under load names its own cause in the log instead of reading as a wrong merge direction.
export function describeRun(
  label: string,
  {
    durationMs,
    exitCode,
    originalMessage,
    signal,
    stderr,
    stdout,
  }: Pick<
    SyncResult,
    'durationMs' | 'exitCode' | 'originalMessage' | 'signal' | 'stderr' | 'stdout'
  >,
): string {
  return [
    `${label}: exitCode=${exitCode} signal=${signal} durationMs=${Math.round(durationMs)}`,
    ...(originalMessage ? [`spawn error: ${originalMessage}`] : []),
    `--- stdout ---\n${String(stdout ?? '(none)')}`,
    `--- stderr ---\n${String(stderr ?? '(none)')}`,
  ].join('\n')
}

function cloneNodeRuntime(): NodeRuntime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-runtime-'))
  const copy = path.join(dir, 'node')
  const failures: string[] = []
  for (let attempt = 1; attempt <= CLONE_ATTEMPTS; attempt += 1) {
    try {
      const source = fs.realpathSync(process.execPath)
      const before = fs.statSync(source)
      fs.rmSync(copy, { force: true })
      fs.copyFileSync(source, copy, fs.constants.COPYFILE_FICLONE)
      const after = fs.statSync(source)
      const copied = fs.statSync(copy)
      if (
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        failures.push(
          `attempt ${attempt}: ${source} changed during the copy: before ${describeStat(before)}, after ${describeStat(after)}`,
        )
      } else if (copied.size !== after.size) {
        failures.push(
          `attempt ${attempt}: the copy is ${copied.size} bytes but ${source} is ${after.size} bytes`,
        )
      } else {
        const probe = execaSync(copy, ['-p', 'process.version'], {
          env: {},
          extendEnv: false,
          reject: false,
        })
        if (probe.exitCode === 0 && /^v\d+\.\d+\.\d+$/.test(probe.stdout)) {
          return { dir, path: copy, source, version: probe.stdout }
        }
        failures.push(describeRun(`attempt ${attempt}: ${copy} -p process.version`, probe))
      }
    } catch (error) {
      failures.push(`attempt ${attempt}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (attempt < CLONE_ATTEMPTS) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, CLONE_RETRY_MS)
    }
  }
  fs.rmSync(dir, { force: true, recursive: true })
  throw new Error(
    `could not make a runnable private copy of ${process.execPath}:\n${failures.join('\n')}`,
  )
}

// Created on first use, so collecting a test file without running it (`vitest list`, an editor's test discovery) never pays for a copy of the node
// binary. A failed clone is remembered and rethrown, failing only the arms that ask for it instead of retrying for each of them.
let nodeRuntimeResult: { runtime: NodeRuntime } | { error: Error } | undefined

export function nodeRuntime(): NodeRuntime {
  if (!nodeRuntimeResult) {
    try {
      nodeRuntimeResult = { runtime: cloneNodeRuntime() }
    } catch (error) {
      nodeRuntimeResult = { error: error instanceof Error ? error : new Error(String(error)) }
    }
  }
  if ('error' in nodeRuntimeResult) throw nodeRuntimeResult.error
  return nodeRuntimeResult.runtime
}

export function disposeNodeRuntime(): void {
  if (nodeRuntimeResult && 'runtime' in nodeRuntimeResult) {
    fs.rmSync(nodeRuntimeResult.runtime.dir, { force: true, recursive: true })
  }
  nodeRuntimeResult = undefined
}
