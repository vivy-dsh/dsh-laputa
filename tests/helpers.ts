import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASSEMBLY_FILES, type PersonaFile } from '../src/domain.ts'

/** A temporary directory removed by the caller. */
export function tempDir(prefix = 'dsh-laputa-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  chmodSync(dir, 0o700)
  return dir
}

/** Remove a temporary directory without failing the test on cleanup. */
export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true })
}

/** Set DSH_HOME for one test and return a restore function. */
export function setDshHome(home: string): () => void {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  return () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

const DEFAULT_BODIES: Record<PersonaFile, string> = {
  'MISSION.MD': 'mission',
  'IDENTITY.MD': 'identity',
  'RELATIONSHIP.MD': 'relationship',
  'REDLINE.MD': 'redline',
  'DREAM.MD': '',
  'DARK.MD': '',
}

/** Write a complete persona directory with optional content overrides. */
export function writePersona(
  dir: string,
  overrides: Partial<Record<PersonaFile, string | Buffer>> = {},
): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  chmodSync(dir, 0o700)
  for (const name of ASSEMBLY_FILES) {
    const value = overrides[name] ?? DEFAULT_BODIES[name]
    writeFileSync(join(dir, name), value, { mode: 0o600 })
    chmodSync(join(dir, name), 0o600)
  }
}
