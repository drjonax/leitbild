import { expect, test } from 'bun:test'
import { newWorkspaceId } from '@leitbild/contracts'
import { mkdtemp, rm, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createWorldWorkspaceRuntimeRegistry } from '../src/core/workspaces/runtime-registry.ts'
import { createWorldModuleState } from '../src/core/workspaces/module-state.ts'
import { createTestPackRuntimeAdapters, createTestScenarioRuntimeResolver, testScenarioAuthoring } from './helpers.ts'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r }); return { promise, resolve } }

test('Workspace deletion drains a save in compilation and rejects stale library references', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-delete-save-'))
  const workspaceId = newWorkspaceId()
  const entered = deferred(), gate = deferred()
  const authoring = testScenarioAuthoring()
  const moduleState = createWorldModuleState({ dataDir })
  const registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState, ...authoring,
    runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(),
    compileScenarioDefinition: async source => { entered.resolve(); await gate.promise; return authoring.compileScenarioDefinition(source) },
  })
  try {
    const { runtime } = await registry.provision(workspaceId)
    const original = await runtime.simulationRuns.currentScenario('test-response')
    const source = { ...original!.document, id: 'race-save', title: 'Pending save' }
    const saving = runtime.simulationRuns.createScenario(source)
    await entered.promise
    let deleted = false
    const deleting = registry.remove(workspaceId).then(() => { deleted = true })
    await Bun.sleep(10)
    expect(deleted).toBe(false)
    gate.resolve()
    await saving
    await deleting
    await expect(runtime.simulationRuns.createScenario(source)).rejects.toThrow('closing')
    expect(await moduleState.get(workspaceId)).toBeNull()
    await expect(access(join(dataDir, 'workspaces', workspaceId, 'world'))).rejects.toThrow()
  } finally { gate.resolve(); await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})

test('capacity reclamation preserves requests and stays bounded across concurrent admissions', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-capacity-work-'))
  const state = createWorldModuleState({ dataDir })
  const registry = createWorldWorkspaceRuntimeRegistry({ dataDir, moduleState: state, ...testScenarioAuthoring(),
    runtimeAdapters: createTestPackRuntimeAdapters(), scenarioRuntimeResolver: createTestScenarioRuntimeResolver(), maxLoadedWorkspaces: 1 })
  const ids = [newWorkspaceId(), newWorkspaceId(), newWorkspaceId()]
  const entered = deferred(), gate = deferred()
  try {
    for (const id of ids) await state.provision(id!)
    const holding = registry.withRuntime(ids[0]!, async () => { entered.resolve(); await gate.promise })
    await entered.promise
    await expect(registry.getOrLoad(ids[1]!)).rejects.toThrow('active work')
    gate.resolve(); await holding
    await Promise.all(ids.slice(1).map(id => registry.getOrLoad(id!)))
    expect(ids.filter(id => registry.getLoaded(id!))).toHaveLength(1)
    expect(await state.list()).toHaveLength(3)
  } finally { gate.resolve(); await registry.shutdown(); await rm(dataDir, { recursive: true, force: true }) }
})

// Bun drops a request idle for 10 s only while its process is otherwise busy,
// as a World with running Runs always is; so the server runs in its own process.
test('a Workspace removal that takes longer than Bun\'s 10 s idle limit still answers the Host', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'world-slow-remove-'))
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'slow-workspace-removal.ts'), join(dataDir, 'maps')], { stdout: 'pipe', stderr: 'inherit' })
  try {
    const { value } = await child.stdout.getReader().read()
    const port = Number(new TextDecoder().decode(value).trim())
    const response = await fetch(`http://127.0.0.1:${port}/internal/workspaces/${newWorkspaceId()}`, { method: 'DELETE' })
    expect(response.status).toBe(204)
  } finally { child.kill(); await child.exited; await rm(dataDir, { recursive: true, force: true }) }
}, 60_000)
