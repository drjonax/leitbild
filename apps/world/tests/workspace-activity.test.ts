import { afterEach, describe, expect, test } from 'bun:test'
import { moduleActivitySchema, newWorkspaceId, type ModuleActivity, type WorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from '../src/core/api/server.ts'
import { handleWorldActivity, worldModuleManifest } from '../src/core/api/workspace-module-api.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry, type WorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createManualIdleTimer, createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring, waitForCondition } from './helpers.ts'

const directories: string[] = []
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

const createWorkspaces = async (idleRuntimeCloseDelayMs = -1): Promise<{ readonly dataDir: string; readonly workspaces: WorldWorkspaceRuntimeRegistry }> => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-activity-'))
  directories.push(dataDir)
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }),
    scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(),
    idleRuntimeCloseDelayMs })
  cleanups.push(() => workspaces.shutdown())
  return { dataDir, workspaces }
}

const readActivity = async (workspaces: WorldWorkspaceRuntimeRegistry): Promise<ModuleActivity> => {
  const request = new Request(`http://world.test${worldModuleManifest.endpoints.activity}`)
  const response = await handleWorldActivity(request, new URL(request.url), workspaces)
  expect(response?.status).toBe(200)
  return moduleActivitySchema.parse(await response!.json())
}

const itemsOf = (activity: ModuleActivity, workspaceId: WorkspaceId) =>
  activity.workspaces.find(workspace => workspace.workspaceId === workspaceId)?.items

const running = (count: number) => ({ key: 'simulations-running', label: `${count} simulation${count === 1 ? '' : 's'} running`, count, active: true })
const stored = (count: number) => ({ key: 'simulations', label: `${count} simulation${count === 1 ? '' : 's'}`, count, active: false })

describe('World Workspace activity', () => {
  test('counts a loaded playing Run as running and a paused one only as stored, and leaves out a Workspace without Runs', async () => {
    const { dataDir, workspaces } = await createWorkspaces()
    const server = createServer({ workspaces, featuredDefinitions: { definitions: [], listed: [] }, port: 0, bindHost: '127.0.0.1', mapArtifacts: { rootDir: join(dataDir, 'maps') } })
    cleanups.push(() => server.stop())
    const busy = newWorkspaceId()
    const empty = newWorkspaceId()
    const { runtime } = await workspaces.provision(busy)
    await workspaces.provision(empty)
    const playing = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    const paused = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    await runtime.simulationRuns.setExecution(paused.id, { playback: 'paused' })

    const response = await fetch(`http://127.0.0.1:${server.port}${worldModuleManifest.endpoints.activity}`)
    expect(response.status).toBe(200)
    const activity = moduleActivitySchema.parse(await response.json())
    expect(activity.workspaces).toEqual([{ workspaceId: busy, items: [running(1), stored(2)] }])

    await runtime.simulationRuns.setExecution(playing.id, { playback: 'paused' })
    expect(itemsOf(await readActivity(workspaces), busy)).toEqual([stored(2)])
    await runtime.simulationRuns.setExecution(playing.id, { playback: 'playing' })
    await runtime.simulationRuns.setExecution(paused.id, { playback: 'playing' })
    expect(itemsOf(await readActivity(workspaces), busy)).toEqual([running(2), stored(2)])
  })

  test('counts a Run advancing at maximum pace as running although its clock is paused', async () => {
    const { workspaces } = await createWorkspaces()
    const workspaceId = newWorkspaceId()
    const { runtime } = await workspaces.provision(workspaceId)
    const run = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    await runtime.simulationRuns.setExecution(run.id, { pace: 'maximum' })
    expect(await runtime.simulationRuns.executionStatus(run.id)).toMatchObject({ playback: 'playing', pace: 'maximum', acceleration: { status: 'running' } })
    expect(run.snapshot().clock?.paused).toBe(true)
    expect(itemsOf(await readActivity(workspaces), workspaceId)).toEqual([running(1), stored(1)])

    await runtime.simulationRuns.setExecution(run.id, { playback: 'paused' })
    expect(itemsOf(await readActivity(workspaces), workspaceId)).toEqual([stored(1)])
  })

  test('an idle-closed Run whose saved clock plays is stored but not running, and reading loads neither it nor its Workspace', async () => {
    const { workspaces } = await createWorkspaces(1)
    const workspaceId = newWorkspaceId()
    const { runtime } = await workspaces.provision(workspaceId)
    const run = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    await waitForCondition('the Run closes when idle', () => runtime.simulationRuns.get(run.id) === undefined)
    // Its descriptor still says playing: only the loaded runtimes say what advances.
    expect(await runtime.simulationRuns.executionOverview(run.id)).toMatchObject({ playback: 'playing' })

    expect(itemsOf(await readActivity(workspaces), workspaceId)).toEqual([stored(1)])
    expect(runtime.simulationRuns.get(run.id)).toBeUndefined()

    expect(await workspaces.close(workspaceId)).toBe(true)
    expect(itemsOf(await readActivity(workspaces), workspaceId)).toEqual([stored(1)])
    expect(workspaces.getLoaded(workspaceId)).toBeUndefined()
  })

  test('a removed Workspace disappears', async () => {
    const { workspaces } = await createWorkspaces()
    const removed = newWorkspaceId()
    const kept = newWorkspaceId()
    for (const workspaceId of [removed, kept]) {
      const { runtime } = await workspaces.provision(workspaceId)
      await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    }
    expect((await readActivity(workspaces)).workspaces.map(workspace => workspace.workspaceId).sort()).toEqual([removed, kept].sort())

    expect(await workspaces.remove(removed)).toBe(true)
    expect((await readActivity(workspaces)).workspaces).toEqual([{ workspaceId: kept, items: [running(1), stored(1)] }])
  })

  test('a Run registry reads its activity without moving a lease or an idle-close countdown', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'world-activity-registry-'))
    directories.push(dataDir)
    const timer = createManualIdleTimer()
    const registry = createSimulationRunRegistry({ dataDir, workspaceId: newWorkspaceId(), ...testScenarioAuthoring(),
      runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
      idleRuntimeCloseDelayMs: 1_000, idleRuntimeCloseTimer: timer.arm })
    cleanups.push(() => registry.shutdown())
    const run = await registry.create({ scenarioId: 'test-response' })
    await timer.advance(600)
    const leases = registry.leaseSummary(run.id)
    expect(registry.activity()).toEqual({ loadedRunIds: [run.id], advancingRunIds: [run.id] })
    expect(registry.leaseSummary(run.id)).toEqual(leases)
    // A read that re-armed the countdown would keep the Run loaded past its first schedule.
    await timer.advance(400)
    expect(registry.get(run.id)).toBeUndefined()
    expect(registry.activity()).toEqual({ loadedRunIds: [], advancingRunIds: [] })
    expect(registry.get(run.id)).toBeUndefined()
  })
})
