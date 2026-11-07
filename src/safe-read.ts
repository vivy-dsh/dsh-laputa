/**
 * Safe persona reads. The rules follow laputa's markdown reader: reject
 * symlinks, world-writable files, and aliased or non-regular files; cap each
 * file in bytes; and fail on invalid UTF-8 instead of replacing bytes.
 *
 * POSIX exposes the permission and link-count checks directly. On Windows the
 * mode bits and link count are synthesized by the runtime, so those two checks
 * are best-effort there; symlink and regularity checks still apply.
 * @module dsh-laputa
 */

import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { PersonaError } from './domain.ts'

/** One successful safe read. */
export interface SafeReadResult {
  /** File bytes, empty for an absent optional file. */
  readonly bytes: Buffer
  /** SHA-256 of the bytes. */
  readonly digest: string
}

const EMPTY = Buffer.alloc(0)
const EMPTY_DIGEST = createHash('sha256').update(EMPTY).digest('hex')
const UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Decode bytes strictly; invalid UTF-8 is a boundary failure. */
export function decodeUtf8(bytes: Buffer, label: string): string {
  try {
    return UTF8.decode(bytes)
  } catch {
    throw new PersonaError('invalid_utf8', `${label} is not valid UTF-8`)
  }
}

/**
 * Resolve a persona directory and verify it is a real, non-world-writable
 * directory (not a symlink). Returns its canonical path.
 * @param directory - candidate persona directory.
 */
export function readPersonaDirectory(directory: string): string {
  let info
  try {
    info = lstatSync(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new PersonaError('persona_directory_missing', `persona directory does not exist: ${directory}`)
    }
    throw new PersonaError('file_open_refused', `cannot inspect persona directory ${directory}: ${String(error)}`)
  }
  if (info.isSymbolicLink()) {
    throw new PersonaError('symlink_not_supported', `persona directory is a symlink: ${directory}`)
  }
  if (!info.isDirectory()) {
    throw new PersonaError('persona_directory_missing', `persona path is not a directory: ${directory}`)
  }
  if ((info.mode & 0o002) !== 0) {
    throw new PersonaError('world_writable_file_refused', `persona directory is world-writable: ${directory}`)
  }
  return realpathSync(directory)
}

/**
 * Read one persona document under the laputa boundaries.
 * @param path - absolute file path.
 * @param limit - per-file byte cap.
 * @param optional - whether a missing file is allowed.
 * @returns the bytes and their digest; empty for an absent optional file.
 */
export function safeRead(path: string, limit: number, optional: boolean): SafeReadResult {
  let linkInfo
  try {
    linkInfo = lstatSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (optional) return { bytes: EMPTY, digest: EMPTY_DIGEST }
      throw new PersonaError('required_file_missing', `required persona file is missing: ${path}`)
    }
    throw new PersonaError('file_open_refused', `cannot inspect persona file ${path}: ${String(error)}`)
  }
  if (linkInfo.isSymbolicLink()) {
    throw new PersonaError('symlink_not_supported', `persona file is a symlink: ${path}`)
  }
  if (!linkInfo.isFile()) {
    throw new PersonaError('not_an_unaliased_regular_file', `persona file is not a regular file: ${path}`)
  }

  const noFollow = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0
  let fd: number
  try {
    fd = openSync(path, constants.O_RDONLY | noFollow)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && optional) {
      return { bytes: EMPTY, digest: EMPTY_DIGEST }
    }
    throw new PersonaError('file_open_refused', `cannot open persona file ${path}: ${String(error)}`)
  }

  try {
    const info = fstatSync(fd)
    if ((info.mode & 0o002) !== 0) {
      throw new PersonaError('world_writable_file_refused', `persona file is world-writable: ${path}`)
    }
    if (!info.isFile() || info.nlink !== 1) {
      throw new PersonaError('not_an_unaliased_regular_file', `persona file is not an unaliased regular file: ${path}`)
    }
    if (info.size > limit) {
      throw new PersonaError('source_byte_budget_exceeded', `${path} exceeds ${limit} bytes`)
    }

    // Read at most one byte past the cap so a file that grows after fstat is
    // still rejected instead of silently truncated.
    const buffer = Buffer.allocUnsafe(limit + 1)
    let offset = 0
    while (offset < buffer.length) {
      const read = readSync(fd, buffer, offset, buffer.length - offset, null)
      if (read === 0) break
      offset += read
    }
    if (offset > limit) {
      throw new PersonaError('source_byte_budget_exceeded', `${path} exceeds ${limit} bytes`)
    }
    const bytes = Buffer.from(buffer.subarray(0, offset))
    decodeUtf8(bytes, path)
    return { bytes, digest: createHash('sha256').update(bytes).digest('hex') }
  } finally {
    closeSync(fd)
  }
}
