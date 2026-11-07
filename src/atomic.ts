/**
 * Atomic filesystem primitives shared by draft writes, revision publishing,
 * and the revision pointer lock. Files are written to a same-directory
 * temporary file, fsynced, and renamed; locks are exclusive create-only files
 * with pid and age based stale takeover.
 * @module dsh-laputa
 */

import {
  chmodSync, closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

/** SHA-256 of arbitrary bytes or text. */
export function digestOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Best-effort directory fsync so a rename survives a crash. Filesystems that
 * do not support opening or syncing a directory are tolerated.
 * @param directory - directory to sync.
 */
export function fsyncDirectory(directory: string): void {
  let fd: number | undefined
  try {
    fd = openSync(directory, 'r')
    fsyncSync(fd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EISDIR' && code !== 'EBADF' && code !== 'EPERM'
      && code !== 'EACCES' && code !== 'ENOTSUP') {
      throw error
    }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
  }
}

/** Options for one atomic file replacement. */
export interface AtomicWriteOptions {
  /** File mode; defaults to `0600`. */
  readonly mode?: number
  /** Runs immediately before each rename attempt; may throw to abort. */
  readonly beforeRename?: () => void
}

/**
 * Replace a file atomically. A concurrent-writer check can be supplied through
 * `beforeRename`; on Windows the check runs again before the rename retry.
 * @param target - absolute target path.
 * @param data - complete replacement content.
 * @param options - mode and pre-rename check.
 */
export function atomicWriteFile(
  target: string,
  data: Buffer | string,
  options: AtomicWriteOptions = {},
): void {
  const mode = options.mode ?? 0o600
  const directory = dirname(target)
  const temp = join(directory, `.${basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data
  let fd: number | undefined
  try {
    fd = openSync(temp, 'wx', mode)
    writeSync(fd, payload)
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    chmodSync(temp, mode)
    options.beforeRename?.()

    try {
      renameSync(temp, target)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (process.platform !== 'win32' || (code !== 'EEXIST' && code !== 'EPERM')) throw error
      options.beforeRename?.()
      rmSync(target, { force: true })
      renameSync(temp, target)
    }
    fsyncDirectory(directory)
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch {}
    }
    try { rmSync(temp, { force: true }) } catch {}
  }
}

/**
 * Write stable, human-readable JSON with a trailing newline.
 * @param target - absolute target path.
 * @param value - JSON-serializable value with a stable key order.
 * @param options - pre-rename check.
 */
export function writeJsonAtomic(
  target: string,
  value: unknown,
  options: Omit<AtomicWriteOptions, 'mode'> = {},
): void {
  atomicWriteFile(target, `${JSON.stringify(value, null, 2)}\n`, { ...options, mode: 0o600 })
}

/** Lock metadata written by `withFileLock`. */
export interface FileLockInfo {
  readonly pid: number
  readonly token: string
  readonly createdAt: string
}

/** Options for `withFileLock`. */
export interface FileLockOptions {
  /** A lock older than this is treated as stale. Defaults to 30 seconds. */
  readonly staleMs?: number
}

/** Raised when another live holder owns the lock. */
export class LockBusyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LockBusyError'
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function isStale(lockPath: string, staleMs: number): boolean {
  let raw: string
  let age: number
  try {
    raw = readFileSync(lockPath, 'utf8')
    age = Date.now() - statSync(lockPath).mtimeMs
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    throw error
  }

  let info: Partial<FileLockInfo>
  try {
    info = JSON.parse(raw) as Partial<FileLockInfo>
  } catch {
    return age > staleMs
  }
  if (typeof info.createdAt === 'string') {
    const created = Date.parse(info.createdAt)
    if (Number.isFinite(created) && Date.now() - created > staleMs) return true
  }
  if (typeof info.pid === 'number' && info.pid > 0 && !isProcessAlive(info.pid)) return true
  return false
}

function acquireLock(lockPath: string, info: FileLockInfo, staleMs: number): void {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 })
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number | undefined
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, `${JSON.stringify(info)}\n`)
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      fsyncDirectory(dirname(lockPath))
      return
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch {}
        try { rmSync(lockPath, { force: true }) } catch {}
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (attempt > 0 || !isStale(lockPath, staleMs)) {
        throw new LockBusyError(`revision lock is held: ${lockPath}`)
      }
      rmSync(lockPath, { force: true })
    }
  }
}

function releaseLock(lockPath: string, token: string): void {
  let raw: string
  try {
    raw = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let info: Partial<FileLockInfo>
  try {
    info = JSON.parse(raw) as Partial<FileLockInfo>
  } catch {
    return
  }
  if (info.token === token) rmSync(lockPath, { force: true })
}

/**
 * Run `fn` while holding an advisory exclusive lock. The lock is fail-fast:
 * a live, fresh holder raises `LockBusyError`; a dead pid or an expired lock
 * is removed and retried once.
 * @param lockPath - absolute lock file path.
 * @param fn - critical section.
 * @param options - stale timeout.
 */
export function withFileLock<T>(
  lockPath: string,
  fn: () => T,
  options: FileLockOptions = {},
): T {
  const token = randomBytes(12).toString('hex')
  const info: FileLockInfo = {
    pid: process.pid,
    token,
    createdAt: new Date().toISOString(),
  }
  acquireLock(lockPath, info, options.staleMs ?? 30_000)
  try {
    return fn()
  } finally {
    releaseLock(lockPath, token)
  }
}
