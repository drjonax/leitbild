import { afterEach, describe, expect, test } from 'bun:test'
import { rm } from 'node:fs/promises'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import { createServer } from '../src/core/api/server.ts'
import type { SimulationRunId } from '../src/core/model/index.ts'
import type { WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createRoleRunWorkspaces } from './fixtures/role-runs.ts'
import { waitForCondition } from './helpers.ts'

// A pop-out display's viewer lease (multiunit plan T6.5): the Run's WebSocket
// with attach=loaded joins a Run that is loaded and holds it as the Run page's
// does, and never loads one that is not.

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const startServer = async (): Promise<{ readonly workspaces: WorldWorkspaceRuntimeRegistry; readonly workspaceId: WorkspaceId; readonly ws: string }> => {
  const { workspaces, dataDir } = await createRoleRunWorkspaces()
  cleanups.push(async () => { await workspaces.shutdown(); await rm(dataDir, { recursive: true, force: true }) })
  const workspaceId = newWorkspaceId()
  await workspaces.provision(workspaceId)
  const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1' })
  cleanups.push(async () => { await server.stop() })
  return { workspaces, workspaceId, ws: `ws://127.0.0.1:${server.port}/api/workspaces/${workspaceId}/world/ws` }
}

const createRun = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId): Promise<SimulationRunId> =>
  await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.create({ scenarioId: 'open-run' })).id)

const loaded = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, run: SimulationRunId): Promise<boolean> =>
  await workspaces.withRuntime(workspaceId, async runtime => runtime.simulationRuns.get(run) !== undefined)

const realtimeLeases = async (workspaces: WorldWorkspaceRuntimeRegistry, workspaceId: WorkspaceId, run: SimulationRunId): Promise<number> =>
  await workspaces.withRuntime(workspaceId, async runtime => (await runtime.simulationRuns.status()).leases.find(lease => lease.simulationRunId === run)?.leasesByKind.realtime ?? 0)

describe('a viewer that attaches only to a loaded Run', () => {
  test('is refused by a Run that is not loaded, and leaves it unloaded', async () => {
    const { workspaces, workspaceId, ws } = await startServer()
    const run = await createRun(workspaces, workspaceId)
    await workspaces.withRuntime(workspaceId, async runtime => { await runtime.simulationRuns.close(run) })
    expect(await loaded(workspaces, workspaceId, run)).toBe(false)

    const refused = await fetch(`${ws.replace('ws://', 'http://')}?simulationRun=${run}&attach=loaded`)
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ error: { code: 'simulation_run_not_loaded' } })
    expect(await loaded(workspaces, workspaceId, run)).toBe(false)

    const unknown = await fetch(`${ws.replace('ws://', 'http://')}?simulationRun=${run}&attach=always`)
    expect(unknown.status).toBe(400)
    expect(await loaded(workspaces, workspaceId, run)).toBe(false)
  })

  test('holds a loaded Run as a realtime viewer until it disconnects', async () => {
    const { workspaces, workspaceId, ws } = await startServer()
    const run = await createRun(workspaces, workspaceId)
    expect(await loaded(workspaces, workspaceId, run)).toBe(true)

    const socket = new WebSocket(`${ws}?simulationRun=${run}&attach=loaded`)
    const types: string[] = []
    socket.onmessage = event => { types.push((JSON.parse(String(event.data)) as { readonly type: string }).type) }
    cleanups.push(async () => { socket.close() })
    await waitForCondition('the ready message', () => types.includes('realtime.ready'))
    expect(await realtimeLeases(workspaces, workspaceId, run)).toBe(1)

    let closed = false
    socket.onclose = () => { closed = true }
    socket.close()
    await waitForCondition('the socket closed', () => closed)
    for (let tries = 0; tries < 50 && await realtimeLeases(workspaces, workspaceId, run) > 0; tries += 1) await Bun.sleep(20)
    expect(await realtimeLeases(workspaces, workspaceId, run)).toBe(0)
  })
})
