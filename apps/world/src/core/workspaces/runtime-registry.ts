import type { WorkspaceId } from '@leitbild/contracts'
import { createOperationScope, createStorageBudget } from '@leitbild/module-runtime'
import type { ProcedureSourceService } from '../../features/procedures/source.ts'
import type { PackRuntimeAdapter } from '../../simulation/protocol.ts'
import type { CompiledScenario } from '../model/index.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import type { ScenarioDefinition } from '../scenarios/definition.ts'
import type { ScenarioRuntimeResolver } from '../scenarios/runtime-resolver.ts'
import { createSimulationRunRegistry,type SimulationRunRegistry } from '../simulation-runs/registry.ts'
import { listStoredSimulationRunIds } from '../simulation-runs/stored-runs.ts'
import { mapWithConcurrency, workspaceFanOutLimit } from '../storage/bounded-fan-out.ts'
import { createKeyedOperations } from '../storage/keyed-operations.ts'
import type { WorldModuleMarker,WorldModuleState } from './module-state.ts'
import { worldWorkspacePaths } from './paths.ts'

export interface WorldWorkspaceRuntime {
  readonly workspaceId: WorkspaceId
  readonly simulationRuns: SimulationRunRegistry
}

/** A provisioned Workspace's Simulation Runs: how many it stores and how many advance now. */
export interface WorldWorkspaceActivity {
  readonly workspaceId: WorkspaceId
  /** Its Run directories, together with any Run loaded in memory. */
  readonly storedRuns: number
  /** Its loaded Runs whose clock plays or that maximum pace advances; a Run not loaded advances nothing. */
  readonly advancingRuns: number
}

export interface WorldWorkspaceRuntimeRegistry {
  readonly list: () => Promise<ReadonlyArray<WorldModuleMarker>>
  readonly provision: (id: WorkspaceId) => Promise<{
    readonly runtime: WorldWorkspaceRuntime
    readonly created: boolean
  }>
  readonly getOrLoad: (id: WorkspaceId) => Promise<WorldWorkspaceRuntime>
  readonly withRuntime: <T>(id: WorkspaceId, work: (runtime: WorldWorkspaceRuntime) => Promise<T>) => Promise<T>
  readonly getLoaded: (id: WorkspaceId) => WorldWorkspaceRuntime | undefined
  /**
   * Every provisioned Workspace's Simulation Run activity, from memory and one
   * Run directory listing per Workspace. It loads no Workspace runtime or Run
   * and changes no last-use order, lease or idle-close countdown.
   */
  readonly activity: () => Promise<ReadonlyArray<WorldWorkspaceActivity>>
  readonly close: (id: WorkspaceId) => Promise<boolean>
  readonly remove: (id: WorkspaceId) => Promise<boolean>
  readonly shutdown: () => Promise<void>
}

export const createWorldWorkspaceRuntimeRegistry = (config: {
  readonly dataDir: string
  readonly moduleState: WorldModuleState
  readonly scenarioRuntimeResolver: ScenarioRuntimeResolver
  readonly scenarioDefinitions: ReadonlyArray<ScenarioDefinition>
  readonly compileScenarioDefinition: (source: unknown) => Promise<CompiledScenario>
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly idleRuntimeCloseDelayMs?: number
  readonly procedureSourceService?: ProcedureSourceService
  readonly maxLoadedWorkspaces?: number
}): WorldWorkspaceRuntimeRegistry => {
  const loaded = new Map<WorkspaceId, WorldWorkspaceRuntime>()
  const storageBudget = createStorageBudget({ root: config.dataDir })
  const operations = new Map<WorkspaceId, ReturnType<typeof createOperationScope>>()
  // Insertion order is last-use order. Only containers without work can be reclaimed.
  const maxLoadedWorkspaces = config.maxLoadedWorkspaces ?? 64
  if (!Number.isSafeInteger(maxLoadedWorkspaces) || maxLoadedWorkspaces < 1) throw new Error('maxLoadedWorkspaces must be a positive integer')
  const lifecycle = createKeyedOperations<WorkspaceId>()
  let shuttingDown = false
  const build = (workspaceId: WorkspaceId): WorldWorkspaceRuntime => ({
    workspaceId,
    simulationRuns: createSimulationRunRegistry({
      dataDir: config.dataDir,
      workspaceId,
      storageBudget,
      scenarioRuntimeResolver: config.scenarioRuntimeResolver,
      scenarioDefinitions: config.scenarioDefinitions,
      compileScenarioDefinition: config.compileScenarioDefinition,
      scenarioAuthoringCatalog: config.scenarioAuthoringCatalog,
      runtimeAdapters: config.runtimeAdapters,
      ...(config.idleRuntimeCloseDelayMs === undefined ? {} : { idleRuntimeCloseDelayMs: config.idleRuntimeCloseDelayMs }),
      ...(config.procedureSourceService === undefined ? {} : { procedureSourceService: config.procedureSourceService }),
    }),
  })

  const loadNow = async (id: WorkspaceId): Promise<WorldWorkspaceRuntime> => {
    if (shuttingDown) throw new Error('World runtime registry is shutting down')
    const current = loaded.get(id)
    if (current) { loaded.delete(id); loaded.set(id, current); return current }
    if (!await config.moduleState.get(id)) throw new Error(`World Module not provisioned: ${id}`)
    while (loaded.size >= maxLoadedWorkspaces) {
      const candidate = [...loaded].find(([key, runtime]) => operations.get(key)!.activeCount() === 0 && runtime.simulationRuns.isIdle())
      if (!candidate) throw Object.assign(new Error(`World Workspace runtime capacity (${maxLoadedWorkspaces}) is occupied by active work`), { code: 'workspace_capacity_exceeded' })
      await lifecycle.run(candidate[0], async () => {
        const runtime = loaded.get(candidate[0])
        if (runtime && operations.get(candidate[0])!.activeCount() === 0 && runtime.simulationRuns.isIdle()) await closeLoaded(candidate[0])
      })
    }
    const runtime = build(id)
    operations.set(id, createOperationScope(`World Workspace ${id}`))
    loaded.set(id, runtime)
    return runtime
  }
  const getOrLoad = (id: WorkspaceId): Promise<WorldWorkspaceRuntime> => lifecycle.run(id, () => loadNow(id))
  const withRuntime = async <T>(id: WorkspaceId, work: (runtime: WorldWorkspaceRuntime) => Promise<T>): Promise<T> => {
    const { runtime, release } = await lifecycle.run(id, async () => {
      const runtime = await loadNow(id)
      return { runtime, release: operations.get(id)!.acquire() }
    })
    try { return await work(runtime) } finally { release() }
  }

  const provision = async (id: WorkspaceId) => {
    const provisioned = await config.moduleState.provision(id)
    return {
      runtime: loaded.get(id) ?? await getOrLoad(id),
      created: provisioned.created,
    }
  }

  const closeLoaded = async (id: WorkspaceId): Promise<boolean> => {
    const runtime = loaded.get(id)
    if (!runtime) return false
    // Waits on this Workspace's Runs end at once, so draining its requests does
    // not sit out a 20 s wait; every other request finishes before the Runs close.
    runtime.simulationRuns.beginClose()
    await operations.get(id)!.close()
    await runtime.simulationRuns.shutdown()
    loaded.delete(id)
    operations.delete(id)
    return true
  }
  const close = (id: WorkspaceId): Promise<boolean> => lifecycle.run(id, () => closeLoaded(id))

  const activityOf = async (workspaceId: WorkspaceId): Promise<WorldWorkspaceActivity> => {
    const stored = await listStoredSimulationRunIds(worldWorkspacePaths(config.dataDir, workspaceId).simulationRuns)
    // Read after the listing, so the loaded Runs are as current as the answer.
    const runtime = loaded.get(workspaceId)
    if (!runtime) return { workspaceId, storedRuns: stored.length, advancingRuns: 0 }
    const runs = runtime.simulationRuns.activity()
    return {
      workspaceId,
      storedRuns: new Set([...stored, ...runs.loadedRunIds]).size,
      advancingRuns: runs.advancingRunIds.length,
    }
  }

  const remove = (id: WorkspaceId): Promise<boolean> => lifecycle.run(id, async () => {
    await closeLoaded(id)
    return await config.moduleState.remove(id)
  })

  return {
    list: () => config.moduleState.list(),
    provision,
    getOrLoad,
    withRuntime,
    getLoaded: id => loaded.get(id),
    activity: async () => await mapWithConcurrency(await config.moduleState.list(), workspaceFanOutLimit, marker => activityOf(marker.workspaceId)),
    close,
    remove,
    shutdown: async () => {
      shuttingDown = true
      await lifecycle.drain()
      const results = await Promise.allSettled([...loaded.keys()].map(close))
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'World Workspace shutdown failed')
    },
  }
}
