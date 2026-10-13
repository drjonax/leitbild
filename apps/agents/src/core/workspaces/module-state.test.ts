import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId } from '@leitbild/contracts'
import { workspaceModulePaths } from '../paths.ts'
import { createAgentsModuleState } from './module-state.ts'

let home = ''
let originalHome: string | undefined

beforeEach(async () => {
  originalHome = process.env.LEITBILD_HOME
  home = await mkdtemp(join(tmpdir(), 'leitbild-agents-module-'))
  process.env.LEITBILD_HOME = home
})

afterEach(async () => {
  if (originalHome === undefined) delete process.env.LEITBILD_HOME
  else process.env.LEITBILD_HOME = originalHome
  await rm(home, { recursive: true, force: true })
})

describe('Agents Module state', () => {
  test('provisions one strict Agents shard idempotently', async () => {
    const workspaceId = newWorkspaceId()
    const state = createAgentsModuleState()
    expect((await state.provision(workspaceId)).created).toBe(true)
    expect((await state.provision(workspaceId)).created).toBe(false)
    expect(await state.has(workspaceId)).toBe(true)
  })

  test('removes the complete Agents shard including Room state', async () => {
    const workspaceId = newWorkspaceId()
    const state = createAgentsModuleState()
    await state.provision(workspaceId)
    const paths = workspaceModulePaths(workspaceId)
    await Bun.write(paths.agents.snapshot, '{}')
    await Bun.write(paths.rooms.snapshot, '{}')

    await state.remove(workspaceId)

    expect(await state.has(workspaceId)).toBe(false)
    expect(await Bun.file(paths.agents.snapshot).exists()).toBe(false)
    expect(await Bun.file(paths.rooms.snapshot).exists()).toBe(false)
    expect(await readdir(join(home, 'workspaces'))).toEqual([])
    // Removing again, as a Host retry does, finds nothing and succeeds.
    await state.remove(workspaceId)
  })

  test('rejects corrupt markers instead of inventing Module state', async () => {
    const workspaceId = newWorkspaceId()
    const state = createAgentsModuleState()
    await state.provision(workspaceId)
    await Bun.write(workspaceModulePaths(workspaceId).agents.marker, '{}')
    expect(state.has(workspaceId)).rejects.toThrow()
  })
})
