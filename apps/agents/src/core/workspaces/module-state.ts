import { mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import {
  isoTimestampSchema,
  workspaceIdSchema,
  type WorkspaceId,
} from '@leitbild/contracts'
import { workspaceModulePaths } from '../paths.ts'

const markerSchema = z.object({
  workspaceId: workspaceIdSchema,
  moduleId: z.literal('agents'),
  createdAt: isoTimestampSchema,
}).strict()
export type AgentsModuleMarker = z.infer<typeof markerSchema>

const readMarker = async (workspaceId: WorkspaceId): Promise<AgentsModuleMarker | null> => {
  const file = Bun.file(workspaceModulePaths(workspaceId).agents.marker)
  if (!await file.exists()) return null
  const marker = markerSchema.parse(JSON.parse(await file.text()) as unknown)
  if (marker.workspaceId !== workspaceId) throw new Error(`Invalid Agents Workspace marker for ${workspaceId}`)
  return marker
}

export interface AgentsModuleState {
  readonly provision: (workspaceId: WorkspaceId) => Promise<{ readonly marker: AgentsModuleMarker; readonly created: boolean }>
  readonly remove: (workspaceId: WorkspaceId) => Promise<void>
  readonly has: (workspaceId: WorkspaceId) => Promise<boolean>
}

export const createAgentsModuleState = (): AgentsModuleState => {
  let mutationQueue = Promise.resolve()
  const mutate = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationQueue.then(operation)
    mutationQueue = result.then(() => undefined, () => undefined)
    return result
  }

  return {
    provision: workspaceId => mutate(async () => {
      const existing = await readMarker(workspaceId)
      if (existing) return { marker: existing, created: false }
      const marker = markerSchema.parse({ workspaceId, moduleId: 'agents', createdAt: new Date().toISOString() })
      const path = workspaceModulePaths(workspaceId).agents.marker
      await mkdir(dirname(path), { recursive: true })
      const temporaryPath = `${path}.${crypto.randomUUID()}.tmp`
      try {
        await Bun.write(temporaryPath, `${JSON.stringify(marker, null, 2)}\n`)
        await rename(temporaryPath, path)
      } finally {
        await rm(temporaryPath, { force: true })
      }
      return { marker, created: true }
    }),
    remove: workspaceId => mutate(async () => {
      const paths = workspaceModulePaths(workspaceId)
      await rm(paths.agents.root, { recursive: true, force: true })
      // The Workspace directory holds only Agents state: drop it once empty, so
      // deleted Workspaces leave nothing behind. Anything else in it is kept.
      try {
        if ((await readdir(paths.root)).length === 0) await rmdir(paths.root)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }),
    has: async workspaceId => (await readMarker(workspaceId)) !== null,
  }
}
