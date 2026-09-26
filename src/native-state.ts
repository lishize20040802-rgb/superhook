/** Private native session bookkeeping; official task and conversation logs remain untouched. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { NativeState } from './types.ts'

export function nativeStateStore(directory: string, sessionId: string, fingerprint: string) {
  if (!isAbsolute(directory)) throw new Error('Native stateDirectory must be absolute')
  const path = join(directory, `${createHash('sha256').update(sessionId).digest('hex')}.json`)
  return {
    async read(): Promise<NativeState | undefined> {
      let value: unknown
      try {
        value = JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
        throw error
      }
      if (!value || typeof value !== 'object') throw new Error('Invalid native session state')
      const state = value as NativeState
      if (
        state.version !== 1 ||
        state.fingerprint !== fingerprint ||
        typeof state.nativeId !== 'string' ||
        !state.nativeId ||
        !Array.isArray(state.messageIds) ||
        state.messageIds.some((id) => typeof id !== 'string')
      )
        throw new Error(
          'Native session state or configuration mismatch; refusing to create a replacement conversation',
        )
      return state
    },
    async write(state: NativeState) {
      await mkdir(directory, { recursive: true })
      const temporary = `${path}.${randomUUID()}.tmp`
      try {
        await writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 })
        await rename(temporary, path)
      } finally {
        await rm(temporary, { force: true })
      }
    },
  }
}
