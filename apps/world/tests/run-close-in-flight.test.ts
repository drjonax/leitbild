import { afterEach, expect, test } from 'bun:test'
import { lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newWorkspaceId, type WorkspaceId } from '@leitbild/contracts'
import type { PackRuntimeAdapter } from '../src/simulation/protocol.ts'
import { buildSimulationRunActor } from '../src/core/api/simulation-run-routes.ts'
import { createSimulationRunRegistry } from '../src/core/simulation-runs/registry.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { fixtureRuntimeId } from './fixtures/fixture-pack.ts'
import { fixtureCommandIds } from './fixtures/fixture-runtime.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

// A Run closes, for a delete, a Workspace removal or World stopping, while
// commands it admitted are still preparing or committing. Those commands must
// finish inside the close: never commit into a closed or deleted Run.

const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

const exists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(complete => { resolve = complete })
  return { promise, resolve }
}

/** Test-only fixture Runtime whose commands, once sent, wait at a gate the test opens. */
const gatedAdapters = () => {
  let gate: ReturnType<typeof deferred> | null = null
  let entered = deferred()
  const adapters: ReadonlyArray<PackRuntimeAdapter> = createTestPackRuntimeAdapters().map(adapter => adapter.id !== fixtureRuntimeId ? adapter : {
    ...adapter,
    connect: async connectConfig => {
      const connection = await adapter.connect(connectConfig)
      return { ...connection, sendCommand: async (command, context) => {
        const result = await connection.sendCommand(command, context)
        if (gate) { entered.resolve(); await gate.promise }
        return result
      } }
    },
  })
  return {
    adapters,
    hold: () => { gate = deferred(); entered = deferred(); return { entered: entered.promise, release: () => gate!.resolve() } },
  }
}

const announce = { capabilityId: fixtureCommandIds.announce, input: { text: 'hello' } }
const operator = buildSimulationRunActor('actor:operator' as never)
const settled = async <T>(promise: Promise<T>, ms: number): Promise<boolean> =>
  await Promise.race([promise.then(() => true, () => true), Bun.sleep(ms).then(() => false)])

test('deleting a Run waits for the command it admitted, then leaves no directory and no ghost Run', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-delete-mid-command-'))
  directories.push(dataDir)
  const workspaceId = newWorkspaceId() as WorkspaceId
  const gated = gatedAdapters()
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: gated.adapters, scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  try {
    const run = await registry.create({ scenarioId: 'test-response' })
    const runDir = join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs', run.id)
    const held = gated.hold()
    const release = registry.acquireLease(run.id, 'api')
    const command = run.invokeCapability(operator, announce)
    await held.entered
    const deleting = registry.delete(run.id)
    // The delete waits for the command it would otherwise strand.
    expect(await settled(deleting, 200)).toBe(false)
    held.release()
    expect(await command).toMatchObject({ kind: 'command', result: { ok: true } })
    release()
    expect(await deleting).toBe(true)
    await Bun.sleep(50)
    expect(await exists(runDir)).toBe(false)
    expect(await registry.listKnown()).toEqual([])
  } finally { await registry.shutdown() }
}, 30_000)

test('closing a Workspace with a command in flight keeps the playing Run playing in its final snapshot', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-close-mid-command-'))
  directories.push(dataDir)
  const gated = gatedAdapters()
  const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: gated.adapters })
  const id = newWorkspaceId()
  try {
    const { runtime } = await workspaces.provision(id)
    const run = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
    const runDir = join(dataDir, 'workspaces', id, 'world', 'simulation-runs', run.id)
    await runtime.simulationRuns.setExecution(run.id, { playback: 'playing' })
    const held = gated.hold()
    const request = workspaces.withRuntime(id, async workspace => {
      const release = workspace.simulationRuns.acquireLease(run.id, 'api')
      try { return await run.invokeCapability(operator, announce) } finally { release() }
    })
    await held.entered
    const closing = workspaces.close(id)
    expect(await settled(closing, 200)).toBe(false)
    held.release()
    expect(await request).toMatchObject({ kind: 'command', result: { ok: true } })
    expect(await closing).toBe(true)
    const events = (await Bun.file(join(runDir, 'events.jsonl')).text()).trim().split('\n').map(line => JSON.parse(line) as { seq: number; type: string })
    const { snapshot } = await Bun.file(join(runDir, 'snapshot.json')).json() as { snapshot: { seq: number; clock: { paused: boolean } } }
    // The command's result committed before the final snapshot, which keeps the Run playing.
    expect(events.at(-1)!.type).toBe('command.result')
    expect(snapshot.seq).toBeGreaterThanOrEqual(events.at(-1)!.seq)
    expect(snapshot.clock.paused).toBe(false)
    // Reopened after the close, as after a deploy, the Run plays on.
    const reopened = await workspaces.getOrLoad(id)
    expect((await reopened.simulationRuns.executionStatus(run.id)).playback).toBe('playing')
  } finally { await workspaces.shutdown() }
}, 30_000)

for (const operation of ['reset', 'copy'] as const) {
  test(`removing a Workspace while a ${operation} is in flight leaves no live Run and no files`, async () => {
    const dataDir = await mkdtemp(join(tmpdir(), `world-remove-mid-${operation}-`))
    directories.push(dataDir)
    const workspaces = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: createWorldModuleState({ dataDir }), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters() })
    const id = newWorkspaceId()
    try {
      const { runtime } = await workspaces.provision(id)
      const run = await runtime.simulationRuns.create({ scenarioId: 'test-response' })
      const gate = deferred()
      const request = workspaces.withRuntime(id, async workspace => {
        await gate.promise
        return operation === 'reset' ? await workspace.simulationRuns.reset(run.id) : await workspace.simulationRuns.copy(run.id, {})
      })
      const removing = workspaces.remove(id)
      expect(await settled(removing, 100)).toBe(false)
      gate.resolve()
      // The request finishes before the Workspace closes its Runs, and the close takes its Run too.
      await request
      expect(await removing).toBe(true)
      expect(runtime.simulationRuns.list()).toEqual([])
      expect(await exists(join(dataDir, 'workspaces', id))).toBe(false)
    } finally { await workspaces.shutdown() }
  }, 30_000)
}

test('a copy racing the Run registry\'s shutdown never leaves a live Run behind', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-copy-shutdown-'))
  directories.push(dataDir)
  const workspaceId = newWorkspaceId() as WorkspaceId
  const registry = createSimulationRunRegistry({ dataDir, workspaceId, ...testScenarioAuthoring(), runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver() })
  const run = await registry.create({ scenarioId: 'test-response' })
  const copying = registry.copy(run.id, {}).then(() => 'copied', (error: unknown) => String(error))
  await registry.shutdown()
  expect(await copying).toContain('closing')
  expect(registry.list()).toEqual([])
  expect((await readdir(join(dataDir, 'workspaces', workspaceId, 'world', 'simulation-runs'))).length).toBe(1)
}, 30_000)
