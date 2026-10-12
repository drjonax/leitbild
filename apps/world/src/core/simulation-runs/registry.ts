import { semanticVersionSchema,type WorkspaceId } from '@leitbild/contracts'
import { createOperationScope, createStorageBudget, type StorageBudget } from '@leitbild/module-runtime'
import { createCaptureAdmission } from '../../features/historian/capture-admission.ts'
import { lstat,readdir,rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z,ZodError } from 'zod'
import { openRunHistorian, recordedHistoryOf } from '../../features/historian/store.ts'
import { createProcedureSourceService,type ProcedureSourceService } from '../../features/procedures/source.ts'
import { capabilityJsonSchema } from '../../simulation/capabilities.ts'
import { worldCoreCapabilities } from '../../simulation/core-capabilities.ts'
import type { PackRuntimeAdapter, PackWorkspaceCapability } from '../../simulation/protocol.ts'
import { createRuntimeHub } from '../../simulation/runtime-hub.ts'
import type { CompiledScenario,IsoTimestamp,RunRoles,SimulationClockState,SimulationRunEvent,SimulationRunId } from '../model/index.ts'
import {
  newSimulationRunId,
  runRolesOf,
  simulationRunIdSchema,
} from '../model/index.ts'
import { createSimulationClock,nowIso } from '../model/time.ts'
import { scenarioPreviewFor,type ScenarioPreview } from '../scenarios/authoring-preview.ts'
import type { ScenarioAuthoringCatalog } from '../scenarios/authoring.ts'
import type { ScenarioDefinition } from '../scenarios/definition.ts'
import { createLocalScenarioLibrary,type ScenarioLibrary,type ScenarioRecord,type ScenarioRevision,type ScenarioRevisionId } from '../scenarios/library.ts'
import type { ScenarioRuntimeResolver } from '../scenarios/runtime-resolver.ts'
import { worldWorkspacePaths } from '../workspaces/paths.ts'
import { compiledScenarioDigest,createCompiledScenarioStore } from './compiled-scenario-store.ts'
import { readRunDisplayName,runDisplayNameSchema,writeRunDisplayName } from './display-name.ts'
import { createJsonlEventLog } from './event-log.ts'
import {
  createSimulationRunManifestStore,
  scenarioRevisionIdFromManifest,
  simulationRunManifestSchema,
  type SimulationRunManifest,
} from './manifest.ts'
import type { SimulationRunRuntimeMetricsSnapshot } from './runtime-metrics.ts'
import { defaultSimulationRunRuntimePolicy } from './runtime-persistence-policy.ts'
import { createJsonRuntimeStateStore } from './runtime-state-store.ts'
import { createExecutionStore } from './execution-store.ts'
import { accelerationStateSchema,executionAdvanceInputSchema,executionCheckpointWallIntervalMs,executionSetInputSchema,runCopyInputSchema,runExecutionStateSchema,type AccelerationState,type AdvanceCompletion,type ExecutionSetInput,type RunCopyOrigin,type RunExecutionState,type RunPace,type RunPlayback } from './execution.ts'
import type { SimulationRunCapabilities } from './runtime.ts'
import { createSimulationRunRuntime,type ActiveSimulationCapability,type SimulationRunRuntime } from './runtime.ts'
import { assertSimulationRunRecoveryNotRequired,createSimulationRunSnapshotStore } from './snapshot-store.ts'
import { createSimulationRunStateStore } from './state-store.ts'
import { createKeyedOperations } from '../storage/keyed-operations.ts'

const maxRestoredEventHistoryBytes = 8 * 1024 * 1024

export type SimulationRunLeaseKind = 'realtime' | 'api' | 'background' | 'maximum-pace'

export interface SimulationRunLeaseSummary {
  readonly simulationRunId: SimulationRunId
  readonly leaseCount: number
  readonly leasesByKind: Readonly<Record<SimulationRunLeaseKind, number>>
}

export interface SimulationRunSummary {
  readonly id: SimulationRunId
  readonly name: string | null
  readonly title: string
  readonly scenarioId: string | null
  readonly scenarioTitle: string | null
  readonly scenarioRevisionId: string | null
  readonly createdAt: string | null
  readonly loaded: boolean
  readonly snapshotSeq: number | null
  readonly objectCount: number | null
  readonly clock: SimulationClockState | null
  readonly activeCapabilityIds: ReadonlyArray<string>
  readonly origin: RunCopyOrigin | null
  /** The roles the Run declares; null in open mode or when unreadable. */
  readonly roles: RunRoles | null
  readonly loadError?: string
}

export interface SimulationRunRegistryStatus {
  readonly dataDir: string
  readonly storage: {
    readonly totalBytes: number
    readonly fileCount: number
    readonly directoryCount: number
  }
  readonly simulationRuns: ReadonlyArray<SimulationRunSummary>
  readonly loadedRuntimeMetrics: ReadonlyArray<SimulationRunRuntimeMetricsSnapshot>
  readonly leases: ReadonlyArray<SimulationRunLeaseSummary>
}

/** Arms one idle-close countdown and returns its disarm; the countdown's close settles when the Run is closed or kept. */
export type IdleRuntimeCloseTimer = (closeIfIdle: () => Promise<void>, delayMs: number) => () => void

const wallClockIdleRuntimeCloseTimer: IdleRuntimeCloseTimer = (closeIfIdle, delayMs) => {
  const timer = setTimeout(() => { void closeIfIdle() }, delayMs)
  timer.unref?.()
  return () => clearTimeout(timer)
}

interface MaximumPaceController {
  stopRequested: boolean
  destination: { playback: RunPlayback; pace: RunPace }
  preserveAcceleration: boolean
  readonly done: Promise<void>
}

export interface SimulationRunRegistry {
  readonly workspaceId: WorkspaceId
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly installedCapabilities: ReadonlyArray<ActiveSimulationCapability>
  readonly workspaceCapabilities: ReadonlyArray<PackWorkspaceCapability>
  readonly create: (config: { readonly scenarioId: string; readonly scenarioRevisionId?: ScenarioRevisionId }) => Promise<SimulationRunRuntime>
  readonly copy: (sourceId: SimulationRunId, input: { readonly name?: string }) => Promise<SimulationRunRuntime>
  readonly executionStatus: (id: SimulationRunId) => Promise<RunExecutionState>
  readonly executionOverview: (id: SimulationRunId) => Promise<RunExecutionState>
  readonly setExecution: (id: SimulationRunId, input: ExecutionSetInput) => Promise<RunExecutionState>
  readonly advanceExecution: (id: SimulationRunId, input: { readonly minutes: number; readonly onComplete?: AdvanceCompletion }) => Promise<RunExecutionState>
  readonly load: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly reset: (id: SimulationRunId) => Promise<SimulationRunRuntime>
  readonly delete: (id: SimulationRunId) => Promise<boolean>
  readonly rename: (id: SimulationRunId, name: string | null, expectedTitle: string) => Promise<SimulationRunSummary>
  readonly get: (id: SimulationRunId) => SimulationRunRuntime | undefined
  readonly list: () => ReadonlyArray<SimulationRunRuntime>
  readonly listKnown: () => Promise<ReadonlyArray<SimulationRunSummary>>
  readonly summary: (id: SimulationRunId) => Promise<SimulationRunSummary>
  /** The roles a Run declares, read from its pinned Compiled Scenario without loading it. */
  readonly runRoles: (id: SimulationRunId) => Promise<RunRoles | null>
  readonly status: () => Promise<SimulationRunRegistryStatus>
  readonly acquireLease: (id: SimulationRunId, kind: SimulationRunLeaseKind) => () => void
  readonly setBackgroundExecution: (id: SimulationRunId, enabled: boolean) => Promise<SimulationRunLeaseSummary>
  readonly leaseSummary: (id: SimulationRunId) => SimulationRunLeaseSummary
  readonly listScenarios: () => Promise<ReadonlyArray<ScenarioRecord>>
  readonly currentScenario: (id: string) => Promise<ScenarioRevision | undefined>
  readonly createScenario: (source: ScenarioDefinition) => Promise<ScenarioRevision>
  readonly previewScenario: (source: ScenarioDefinition) => Promise<ScenarioPreview>
  readonly updateScenario: (source: ScenarioDefinition, expectedRevisionId: ScenarioRevisionId) => Promise<ScenarioRevision>
  readonly deleteScenario: (id: string, revisionId: ScenarioRevisionId) => Promise<boolean>
  readonly scenarioRevisionForRun: (id: SimulationRunId) => Promise<ScenarioRevision | undefined>
  readonly compileScenarioRevision: (revision: ScenarioRevision) => Promise<CompiledScenario>
  readonly compiledScenarioForRun: (id: SimulationRunId) => Promise<CompiledScenario>
  /** The Compiled Scenario a loaded Run started from, read without I/O; throws for a Run that is not loaded. */
  readonly loadedCompiledScenario: (id: SimulationRunId) => CompiledScenario
  readonly shutdown: () => Promise<void>
  readonly close: (id: SimulationRunId) => Promise<boolean>
  readonly isIdle: () => boolean
}

export const createSimulationRunRegistry = (config: {
  readonly dataDir: string
  readonly workspaceId: WorkspaceId
  readonly runtimeAdapters: ReadonlyArray<PackRuntimeAdapter>
  readonly scenarioRuntimeResolver: ScenarioRuntimeResolver
  readonly scenarioDefinitions: ReadonlyArray<ScenarioDefinition>
  readonly compileScenarioDefinition: (source: unknown) => Promise<CompiledScenario>
  readonly scenarioAuthoringCatalog: ScenarioAuthoringCatalog
  readonly scenarioLibrary?: ScenarioLibrary
  readonly storageBudget?: StorageBudget
  readonly idleRuntimeCloseDelayMs?: number
  readonly idleRuntimeCloseTimer?: IdleRuntimeCloseTimer
  readonly procedureSourceService?: ProcedureSourceService
}): SimulationRunRegistry => {
  const simulationRuns = new Map<SimulationRunId, SimulationRunRuntime>()
  const loadedCompiledScenarios = new Map<SimulationRunId, CompiledScenario>()
  const lifecycle = createKeyedOperations<SimulationRunId>()
  let shuttingDown = false
  const definitionOperations = createOperationScope('World scenario library')
  const procedureSourceService = config.procedureSourceService ?? createProcedureSourceService()
  const creatingSimulationRuns = new Map<SimulationRunId, Promise<SimulationRunRuntime>>()
  const leasesBySimulationRun = new Map<SimulationRunId, Map<string, SimulationRunLeaseKind>>()
  const backgroundReleases = new Map<SimulationRunId, () => void>()
  const maximumPaceJobs = new Map<SimulationRunId, MaximumPaceController>()
  const executionStates = new Map<SimulationRunId, RunExecutionState>()
  const executionOperations = createKeyedOperations<SimulationRunId>()
  const familyOperations = createKeyedOperations<SimulationRunId>()
  const idleRuntimeCloseDisarms = new Map<SimulationRunId, () => void>()
  const idleRuntimeCloseDelayMs = config.idleRuntimeCloseDelayMs ?? defaultSimulationRunRuntimePolicy.idleRuntimeCloseDelayMs
  const armIdleRuntimeClose = config.idleRuntimeCloseTimer ?? wallClockIdleRuntimeCloseTimer
  let nextLeaseNumber = 0
  const workspacePaths = worldWorkspacePaths(config.dataDir, config.workspaceId)
  const workspaceRoot = workspacePaths.root
  const storageBudget = config.storageBudget ?? createStorageBudget({ root: config.dataDir })
  const simulationRunRoot = workspacePaths.simulationRuns
  const scenarioLibrary = config.scenarioLibrary ?? createLocalScenarioLibrary({
    workspaceId: config.workspaceId,
    rootDir: workspacePaths.scenarios,
  })
  let scenarioLibraryReady: Promise<void> | null = null
  const compiledScenarios = new Map<ScenarioRevisionId, Promise<CompiledScenario>>()
  // A Run's Compiled Scenario is immutable, so its title and roles are pinned
  // once read, independent of later edits to the authored Definition.
  const pinnedScenarioFacts = new Map<string, { readonly title: string; readonly roles: RunRoles | null }>()
  const installedCapabilities: ReadonlyArray<ActiveSimulationCapability> = [
    ...worldCoreCapabilities.map(capability => ({ packId: 'world', runtimeId: 'world.core', capability })),
    ...config.runtimeAdapters.flatMap(adapter =>
      adapter.capabilities.map(capability => ({ packId: adapter.packId, runtimeId: adapter.id, capability }))),
  ]

  const compileValidatedDefinition = async (source: unknown): Promise<CompiledScenario> => {
    let compiled: CompiledScenario
    try { compiled = await config.compileScenarioDefinition(source) }
    catch (error) {
      if (error instanceof z.ZodError) throw error
      throw new z.ZodError([{ code: 'custom', path: [], message: error instanceof Error ? error.message : String(error) }])
    }
    const resolved = config.scenarioRuntimeResolver.resolve(compiled)
    const runtimeIds = new Set(resolved.runtimes.map(runtime => runtime.runtimeId))
    const available = new Map(installedCapabilities.filter(entry => entry.runtimeId === 'world.core' || runtimeIds.has(entry.runtimeId)).map(entry => [entry.capability.id, entry.capability]))
    for (const runtime of resolved.runtimes) {
      const adapter = config.runtimeAdapters.find(adapter => adapter.id === runtime.runtimeId)!
      for (const queryId of adapter.requiredQueries?.(resolved.runtimeConfigByRuntimeId[runtime.runtimeId]) ?? []) {
        if (available.get(queryId)?.kind !== 'query') throw new z.ZodError([{ code: 'custom', path: ['packs', runtime.packId, 'config'], message: `${runtime.packId} requires an active query provider: ${queryId}` }])
      }
    }
    for (const [index, cue] of (compiled.timeline?.cues ?? []).entries()) {
      for (const [actionIndex, action] of cue.actions.entries()) {
        if (action.type !== 'invoke_capability') continue
        const capability = available.get(action.capabilityId)
        const path = ['timeline', 'cues', index, 'actions', actionIndex]
        if (!capability || capability.kind !== 'command' || capability.schedulable !== true) {
          throw new z.ZodError([{ code: 'custom', path, message: `Capability ${action.capabilityId} is not an active schedulable command` }])
        }
        const input = capability.input.safeParse(action.input)
        if (!input.success) throw new z.ZodError(input.error.issues.map(issue => ({ ...issue, path: [...path, 'input', ...issue.path] })))
      }
    }
    return compiled
  }

  const capabilityIdsForRuntimeIds = (runtimeIds: ReadonlyArray<string>): ReadonlyArray<string> => {
    const activeRuntimeIds = new Set(runtimeIds)
    return [...new Set(installedCapabilities
      .filter(entry => entry.runtimeId === 'world.core' || activeRuntimeIds.has(entry.runtimeId))
      .map(entry => entry.capability.id))].sort()
  }

  const ensureScenarioLibrary = (): Promise<void> => {
    scenarioLibraryReady ??= scenarioLibrary.seed(config.scenarioDefinitions)
    return scenarioLibraryReady
  }

  const compileRevision = (revision: ScenarioRevision): Promise<CompiledScenario> => {
    const existing = compiledScenarios.get(revision.id)
    if (existing) return existing
    const compiling = compileValidatedDefinition(revision.document)
    compiledScenarios.set(revision.id, compiling)
    // Revisions are immutable; keep only a small working set, not every edit forever.
    if (compiledScenarios.size > 32) compiledScenarios.delete(compiledScenarios.keys().next().value!)
    void compiling.catch(() => {
      if (compiledScenarios.get(revision.id) === compiling) compiledScenarios.delete(revision.id)
    })
    return compiling
  }

  const clearIdleRuntimeCloseTimer = (id: SimulationRunId): void => {
    const disarm = idleRuntimeCloseDisarms.get(id)
    if (!disarm) return
    disarm()
    idleRuntimeCloseDisarms.delete(id)
  }

  const leaseCountFor = (id: SimulationRunId): number =>
    leasesBySimulationRun.get(id)?.size ?? 0

  const leaseSummary = (id: SimulationRunId): SimulationRunLeaseSummary => {
    const leasesByKind: Record<SimulationRunLeaseKind, number> = {
      realtime: 0,
      api: 0,
      background: 0,
      'maximum-pace': 0,
    }
    const leases = leasesBySimulationRun.get(id)
    if (leases) for (const kind of leases.values()) leasesByKind[kind] += 1
    return { simulationRunId: id, leaseCount: leases?.size ?? 0, leasesByKind }
  }

  const scheduleIdleRuntimeCloseIfUnleased = (id: SimulationRunId): void => {
    clearIdleRuntimeCloseTimer(id)
    if (idleRuntimeCloseDelayMs < 0) return
    if (!simulationRuns.has(id)) return
    if (creatingSimulationRuns.has(id)) return
    if (leaseCountFor(id) > 0) return
    idleRuntimeCloseDisarms.set(id, armIdleRuntimeClose(async () => {
      idleRuntimeCloseDisarms.delete(id)
      if (leaseCountFor(id) > 0) return
      if (!simulationRuns.has(id)) return
      try {
        await lifecycle.run(id, async () => {
          if (leaseCountFor(id) === 0) await closeLoaded(id)
        })
      } catch (err) {
        console.error(`idle simulation run close failed for ${id}:`, err)
      }
    }, idleRuntimeCloseDelayMs))
  }

  const leaseSummaries = (): ReadonlyArray<SimulationRunLeaseSummary> =>
    [...leasesBySimulationRun.keys()]
      .map(leaseSummary)
      .sort((left, right) => left.simulationRunId.localeCompare(right.simulationRunId))

  const acquireLease = (id: SimulationRunId, kind: SimulationRunLeaseKind): (() => void) => {
    if (shuttingDown) throw new Error('Simulation Run registry is shutting down')
    clearIdleRuntimeCloseTimer(id)
    const leaseId = `${kind}:${++nextLeaseNumber}`
    const leases = leasesBySimulationRun.get(id) ?? new Map<string, SimulationRunLeaseKind>()
    leases.set(leaseId, kind)
    leasesBySimulationRun.set(id, leases)
    let released = false
    return () => {
      if (released) return
      released = true
      const current = leasesBySimulationRun.get(id)
      if (!current) return
      current.delete(leaseId)
      if (current.size === 0) leasesBySimulationRun.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    }
  }

  const capabilitiesFor = (
    scenarioRuntime: ReturnType<ScenarioRuntimeResolver['resolve']>,
    scenarioRevisionId: ScenarioRevision['id'],
  ): Omit<SimulationRunCapabilities, 'simulationRunId'> => {
    const activeRuntimeIds = new Set(scenarioRuntime.runtimes.map(runtime => runtime.runtimeId))
    const activeAdapters = config.runtimeAdapters.filter(adapter => activeRuntimeIds.has(adapter.id))
    const capabilities = [
      ...worldCoreCapabilities.map(capability => ({
        id: capability.id,
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        idempotent: capability.idempotent,
        ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
        inputSchema: capabilityJsonSchema(capability.input),
        outputSchema: capabilityJsonSchema(capability.output),
        packId: 'world',
        runtimeId: 'world.core',
      })),
      ...activeAdapters.flatMap(adapter => adapter.capabilities.map(capability => ({
        id: capability.id,
        kind: capability.kind,
        title: capability.title,
        description: capability.description,
        risk: capability.risk,
        idempotent: capability.idempotent,
        ...(capability.schedulable === undefined ? {} : { schedulable: capability.schedulable }),
        inputSchema: capabilityJsonSchema(capability.input),
        outputSchema: capabilityJsonSchema(capability.output),
        packId: adapter.packId,
        runtimeId: adapter.id,
      }))),
    ].sort((left, right) => left.id.localeCompare(right.id) || left.runtimeId.localeCompare(right.runtimeId))
    return {
      workspaceId: config.workspaceId,
      scenarioId: scenarioRuntime.scenarioId,
      scenarioRevisionId,
      activePackIds: [...scenarioRuntime.scenario.packs],
      runtimes: activeAdapters.map(adapter => ({
        id: adapter.id,
        packId: adapter.packId,
        clock: adapter.clock,
      })).sort((left, right) => left.id.localeCompare(right.id)),
      capabilities,
      wikiRefs: scenarioRuntime.packs.flatMap(pack => pack.knowledge?.wikiRefs ?? []),
      recording: {
        selections: scenarioRuntime.scenario.recording,
        profiles: scenarioRuntime.packs.flatMap(pack => {
          const runtimeId = scenarioRuntime.runtimes.find(runtime => runtime.packId === pack.descriptor.id)?.runtimeId
          if (runtimeId === undefined) return []
          return (pack.recording?.profiles ?? []).map(profile => ({
            ...profile,
            packId: pack.descriptor.id,
            runtimeId,
          }))
        }),
      },
    }
  }

  const validateRestoredEvents = (id: SimulationRunId, events: ReadonlyArray<SimulationRunEvent>): void => {
    let previousSeq = 0
    for (const event of events) {
      if (event.simulationRunId !== id) {
        throw new Error(`event log simulation run mismatch: expected ${id}, got ${event.simulationRunId}`)
      }
      if (event.seq <= previousSeq) {
        throw new Error(`event log sequence regression for ${id}: ${event.seq} after ${previousSeq}`)
      }
      previousSeq = event.seq
    }
  }

  const validateRestoredEventTail = (id: SimulationRunId, event: SimulationRunEvent | null): void => {
    if (event === null) return
    if (event.simulationRunId !== id) {
      throw new Error(`event log simulation run mismatch: expected ${id}, got ${event.simulationRunId}`)
    }
  }

  const isUnreadableSnapshotError = (err: unknown): boolean =>
    err instanceof SyntaxError || err instanceof ZodError

  const unreadableSnapshotMessage = (err: unknown): string => {
    const message = err instanceof Error ? err.message : 'snapshot could not be read'
    return message.length <= 2_000 ? message : `${message.slice(0, 1_997)}...`
  }

  const manifestStoreFor = (id: SimulationRunId) =>
    createSimulationRunManifestStore(join(simulationRunRoot, id, 'manifest.json'))

  const executionStoreFor = (id: SimulationRunId) =>
    createExecutionStore(join(simulationRunRoot, id, 'execution.json'))

  const resolveManifest = async (manifest: SimulationRunManifest): Promise<{
    readonly revision: ScenarioRevision
    readonly scenarioRuntime: NonNullable<ReturnType<ScenarioRuntimeResolver['resolve']>>
  }> => {
    if (manifest.workspaceId !== config.workspaceId) {
      throw new Error(`Simulation Run Workspace mismatch: expected ${config.workspaceId}, got ${manifest.workspaceId}`)
    }
    const revision = await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
    if (!revision) throw new Error(`Scenario Revision not found: ${manifest.scenario.revisionId}`)
    if (revision.definitionId !== manifest.scenario.id || revision.digest !== manifest.scenario.digest) {
      throw new Error(`Simulation Run Scenario Revision mismatch: ${manifest.id}`)
    }
    const compiledScenario = await createCompiledScenarioStore(join(simulationRunRoot, manifest.id, 'compiled-scenario.json')).load()
    if (compiledScenario.id !== revision.definitionId) {
      throw new Error(`Simulation Run Compiled Scenario mismatch for ${manifest.id}: expected ${revision.definitionId}, got ${compiledScenario.id}`)
    }
    if (compiledScenarioDigest(compiledScenario) !== manifest.scenario.compiledDigest) {
      throw new Error(`Simulation Run Compiled Scenario integrity mismatch: ${manifest.id}`)
    }
    const scenarioRuntime = config.scenarioRuntimeResolver.resolve(compiledScenario)
    const packVersions = new Map(scenarioRuntime.packs.map(pack => [pack.descriptor.id, pack.descriptor.version]))
    const installedAdapters = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
    const expectedPackIds = manifest.packs.map(pack => pack.id).sort()
    const resolvedPackIds = scenarioRuntime.packs.map(pack => pack.descriptor.id).sort()
    if (JSON.stringify(expectedPackIds) !== JSON.stringify(resolvedPackIds)) {
      throw new Error(`Simulation Run resolved Pack set mismatch: ${manifest.id}`)
    }
    const expectedRuntimeIds = manifest.runtimes.map(runtime => runtime.id).sort()
    const resolvedRuntimeIds = scenarioRuntime.runtimes.map(runtime => runtime.runtimeId).sort()
    if (JSON.stringify(expectedRuntimeIds) !== JSON.stringify(resolvedRuntimeIds)) {
      throw new Error(`Simulation Run resolved Pack Runtime set mismatch: ${manifest.id}`)
    }
    for (const pack of manifest.packs) {
      if (packVersions.get(pack.id) !== pack.version) {
        throw new Error(`Simulation Run Pack version mismatch for ${pack.id}: expected ${pack.version}, installed ${packVersions.get(pack.id) ?? 'missing'}`)
      }
    }
    for (const runtime of manifest.runtimes) {
      const installed = installedAdapters.get(runtime.id)
      if (installed?.version !== runtime.version) {
        throw new Error(`Simulation Run runtime version mismatch for ${runtime.id}: expected ${runtime.version}, installed ${installed?.version ?? 'missing'}`)
      }
      if (installed.packId !== runtime.packId || installed.clock !== runtime.clock) {
        throw new Error(`Simulation Run Pack Runtime contract mismatch for ${runtime.id}`)
      }
    }
    return { revision, scenarioRuntime }
  }

  const createManifest = async (id: SimulationRunId, scenarioId: string, scenarioRevisionId?: ScenarioRevisionId): Promise<{
    readonly manifest: SimulationRunManifest
    readonly compiledScenario: CompiledScenario
  }> => {
    await ensureScenarioLibrary()
    const revision = scenarioRevisionId === undefined
      ? await scenarioLibrary.currentRevision(scenarioId)
      : await scenarioLibrary.getRevision(scenarioRevisionId)
    if (!revision) throw new Error(`unknown Scenario: ${scenarioId}`)
    if (revision.definitionId !== scenarioId) throw new Error(`Scenario Revision does not belong to Scenario: ${scenarioId}`)
    const compiledScenario = await compileRevision(revision)
    const scenarioRuntime = config.scenarioRuntimeResolver.resolve(compiledScenario)
    const adaptersById = new Map(config.runtimeAdapters.map(adapter => [adapter.id, adapter]))
    const manifest = simulationRunManifestSchema.parse({
      schemaVersion: 1,
      id,
      workspaceId: config.workspaceId,
      scenario: {
        id: revision.definitionId,
        revisionId: revision.id,
        digest: revision.digest,
        compiledDigest: compiledScenarioDigest(compiledScenario),
      },
      packs: scenarioRuntime.packs.map(pack => ({
        id: pack.descriptor.id,
        version: semanticVersionSchema.parse(pack.descriptor.version),
      })),
      runtimes: scenarioRuntime.runtimes.map(runtime => {
        const adapter = adaptersById.get(runtime.runtimeId)
        if (!adapter) throw new Error(`missing Pack Runtime: ${runtime.runtimeId}`)
        return {
          id: runtime.runtimeId,
          version: semanticVersionSchema.parse(adapter.version),
          packId: runtime.packId,
          clock: adapter.clock,
        }
      }),
      createdAt: new Date().toISOString(),
    })
    return { manifest, compiledScenario }
  }

  const createRuntime = async (createConfig: {
    readonly manifest: SimulationRunManifest
    readonly initialSeq?: number
  }): Promise<SimulationRunRuntime> => {
    await ensureScenarioLibrary()
    const { scenarioRuntime } = await resolveManifest(createConfig.manifest)
    const interactionHandlers = scenarioRuntime.packs.flatMap(pack => pack.interactions?.handlers ?? [])
    const interactionHandlerIds = new Set<string>()
    for (const handler of interactionHandlers) {
      if (interactionHandlerIds.has(handler.id)) throw new Error(`duplicate active interaction handler id: ${handler.id}`)
      interactionHandlerIds.add(handler.id)
    }
    const id = createConfig.manifest.id
    const runDir = join(simulationRunRoot, id)
    const eventLog = createJsonlEventLog(join(runDir, 'events.jsonl'))
    const snapshotStore = createSimulationRunSnapshotStore({
      simulationRunId: id,
      path: join(runDir, 'snapshot.json'),
    })
    const runtimeStateStores = Object.fromEntries(scenarioRuntime.runtimes.map(runtime => [
      runtime.runtimeId,
      createJsonRuntimeStateStore({
        runtimeId: runtime.runtimeId,
        path: join(runDir, 'runtimes', `${runtime.runtimeId}.json`),
      }),
    ]))
    let restoredSnapshot
    try {
      restoredSnapshot = await snapshotStore.load()
    } catch (err) {
      if (err instanceof Error && 'code' in err && err.code === 'simulation_run_recovery_required') throw err
      throw new Error(`Simulation Run snapshot is unreadable for ${id}: ${unreadableSnapshotMessage(err)}`, { cause: err })
    }
    let restoredEvents: ReadonlyArray<SimulationRunEvent> = []
    let maxEventSeq = 0
    if (restoredSnapshot?.scenario?.scenarioId !== undefined && restoredSnapshot.scenario.scenarioId !== createConfig.manifest.scenario.id) {
      throw new Error(`Simulation Run snapshot Scenario mismatch for ${id}: expected ${createConfig.manifest.scenario.id}, got ${restoredSnapshot.scenario.scenarioId}`)
    }
    const eventLogBytes = await eventLog.sizeBytes()
    if (eventLogBytes <= maxRestoredEventHistoryBytes) {
      restoredEvents = await eventLog.readAll()
      validateRestoredEvents(id, restoredEvents)
      maxEventSeq = restoredEvents.at(-1)?.seq ?? 0
    } else {
      const lastEvent = await eventLog.readLast()
      validateRestoredEventTail(id, lastEvent)
      maxEventSeq = lastEvent?.seq ?? 0
      console.warn(`simulation run ${id} has a ${eventLogBytes} byte durable event log; restoring current state from snapshot without preloading full event history`)
    }
    if (restoredSnapshot && restoredSnapshot.seq < maxEventSeq) {
      throw new Error(`snapshot sequence ${restoredSnapshot.seq} is behind event log sequence ${maxEventSeq} for ${id}`)
    }
    const recordingByRuntimeId = Object.fromEntries(scenarioRuntime.scenario.recording.map(selection => {
      const runtime = scenarioRuntime.runtimes.find(candidate => candidate.packId === selection.packId)
      if (!runtime) throw new Error(`recording selection has no active Pack Runtime: ${selection.packId}`)
      return [runtime.runtimeId, selection]
    }))
    const historian = scenarioRuntime.scenario.recording.length === 0
      ? undefined
      : openRunHistorian(join(runDir, 'history.sqlite'), { captureAdmission: await createCaptureAdmission(storageBudget, workspaceRoot) })
    // Each recording runtime reads back only its own series, by simulation
    // time, as the displays it answers for read them.
    const recordedHistoryByRuntimeId = historian === undefined ? {} : Object.fromEntries(Object.keys(recordingByRuntimeId).map(runtimeId => [runtimeId, recordedHistoryOf(historian, runtimeId)]))
    let runtimeConnection
    const runClock = createSimulationClock({
      currentTime: restoredSnapshot?.clock?.currentTime ?? scenarioRuntime.scenario.world.startsAt,
      updatedAt: nowIso(), paused: true,
    })
    // The compiled artifact is deterministic authored startup, not an actual
    // observation. Stamp fresh shared objects when their Run is instantiated.
    const observedAt = nowIso()
    const initialObjects = scenarioRuntime.initialObjects.map(object => ({
      ...object,
      timestamps: { createdAt: observedAt, updatedAt: observedAt },
      spatial: { ...object.spatial, ...(object.spatial.position ? { position: { ...object.spatial.position, observedAt } } : {}) },
    }))
    // Runtime readers share the actual Run projection, not the Hub's delayed
    // observation mirror. A deletion is visible even while its journal flush
    // is awaiting I/O, so late route preparation cannot resurrect that object.
    const stateStore = createSimulationRunStateStore()
    stateStore.hydrate(restoredSnapshot ?? { objects: initialObjects, seq: createConfig.initialSeq ?? 0 })
    try {
      runtimeConnection = await createRuntimeHub(config.runtimeAdapters.filter(adapter => scenarioRuntime.runtimes.some(runtime => runtime.runtimeId === adapter.id))).connect({
        simulationRunId: id,
        workspace: { id: config.workspaceId, dataDir: workspaceRoot, storageBudget },
        runClock,
        objectById: stateStore.getObject,
        scenario: {
          scenarioId: scenarioRuntime.scenarioId,
          runtimeIds: scenarioRuntime.runtimes.map(runtime => runtime.runtimeId),
          world: scenarioRuntime.scenario.world,
          initialObjects,
          connections: scenarioRuntime.scenario.connections,
          runtimeConfigByRuntimeId: scenarioRuntime.runtimeConfigByRuntimeId,
          runtimeConfig: {},
        },
        ...(restoredSnapshot ? { initialObjects: restoredSnapshot.objects } : {}),
        runtimeStateStores,
        recordingByRuntimeId,
        recordedHistoryByRuntimeId,
      })
    } catch (error) {
      historian?.close()
      throw error
    }
    const scenarioRoles = runRolesOf(scenarioRuntime.scenario)
    let runtime
    try {
      runtime = await createSimulationRunRuntime({
        id,
        runtimeConnection,
        stateStore,
        runClock,
        eventLog,
        snapshotStore,
        ...(interactionHandlers.length === 0 ? {} : { interactionHandlers }),
        ...(restoredSnapshot ? { restoredSnapshot } : {}),
        ...(restoredEvents.length === 0 ? {} : { restoredEvents }),
        ...(createConfig?.initialSeq === undefined && maxEventSeq === 0 ? {} : { initialSeq: Math.max(createConfig.initialSeq ?? 0, maxEventSeq) }),
        scenario: {
          id: scenarioRuntime.scenarioId,
          startsAt: scenarioRuntime.scenario.world.startsAt,
          agentRestrictions: scenarioRuntime.scenario.agentRestrictions,
          ...(scenarioRoles === null ? {} : { roles: scenarioRoles }),
          ...(scenarioRuntime.scenario.timeline === undefined ? {} : { timeline: scenarioRuntime.scenario.timeline }),
        },
        capabilities: capabilitiesFor(scenarioRuntime, scenarioRevisionIdFromManifest(createConfig.manifest)),
        runtimeCapabilities: installedCapabilities.filter(entry =>
          entry.runtimeId === 'world.core'
          || scenarioRuntime.runtimes.some(runtime => runtime.runtimeId === entry.runtimeId)),
        procedureSourceService,
        runtimeStateLoaders: Object.fromEntries(Object.entries(runtimeStateStores).map(([runtimeId, store]) => [runtimeId, store.load])),
        ...(historian === undefined ? {} : { historian }),
      })
    } catch (error) {
      await runtimeConnection.close()
      historian?.close()
      throw error
    }
    simulationRuns.set(id, runtime)
    loadedCompiledScenarios.set(id, scenarioRuntime.scenario)
    const priorExecution = await executionStoreFor(id).load()
    if (priorExecution) executionStates.set(id, priorExecution)
    if (priorExecution?.acceleration?.status === 'failed') runtime.failStop(priorExecution.acceleration.error ?? 'maximum-pace execution failed')
    scheduleIdleRuntimeCloseIfUnleased(id)
    return runtime
  }

  const create = async (createConfig: { readonly scenarioId: string; readonly scenarioRevisionId?: ScenarioRevisionId }): Promise<SimulationRunRuntime> => {
    if (shuttingDown) throw new Error('Workspace runtime is closing')
    const requestedScenarioId = z.string().min(1).parse(createConfig.scenarioId)
    const id = newSimulationRunId()
    if (simulationRuns.has(id) || creatingSimulationRuns.has(id)) throw new Error(`simulation run already exists: ${id}`)
    // Conservative admission reservation for initial graphs/checkpoints; ongoing
    // observation growth is checked separately and never blocks control commands.
    const creating = storageBudget.withGrowth(workspaceRoot, 16 * 1024 * 1024, async () => {
      const { manifest, compiledScenario } = await createManifest(id, requestedScenarioId, createConfig?.scenarioRevisionId)
      await manifestStoreFor(id).create(manifest)
      await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).create(compiledScenario)
      return await createRuntime({ manifest })
    }).finally(() => {
      creatingSimulationRuns.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    })
    creatingSimulationRuns.set(id, creating)
    return await creating
  }

  const maximumPaceAvailabilityFor = (
    runtimes: ReadonlyArray<{ readonly id: string; readonly clock: 'simulation' | 'live' | 'none' }>,
  ): RunExecutionState['maximumPace'] => {
    const liveRuntimes = runtimes.filter(candidate => candidate.clock === 'live')
    return liveRuntimes.length === 0
      ? { available: true }
      : {
          available: false,
          reason: `Maximum pace cannot synthesize future live observations from: ${liveRuntimes.map(candidate => candidate.id).join(', ')}`,
        }
  }

  const maximumPaceAvailability = async (id: SimulationRunId): Promise<RunExecutionState['maximumPace']> => {
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
    return maximumPaceAvailabilityFor(manifest.runtimes)
  }

  const executionStatus = async (id: SimulationRunId): Promise<RunExecutionState> => {
    const runtime = await load(id)
    const clock = runtime.snapshot().clock
    if (!clock) throw new Error('Simulation Run clock is not initialized')
    const cached = executionStates.get(id) ?? await executionStoreFor(id).load()
    // The job remains registered while its terminal state is being persisted so
    // commands cannot start a competing worker. Once the acceleration itself is
    // terminal, expose that committed destination rather than briefly reporting
    // maximum/playing solely because final persistence is still in flight.
    const runningMaximum = maximumPaceJobs.has(id) && cached?.acceleration?.status === 'running'
    const state = runExecutionStateSchema.parse({
      playback: runningMaximum ? 'playing' : clock.paused ? 'paused' : 'playing',
      pace: runningMaximum ? 'maximum' : clock.paused ? cached?.pace ?? 'realtime' : 'realtime',
      currentSimulationTime: clock.currentTime,
      updatedAt: runningMaximum ? cached?.acceleration?.updatedAt ?? clock.updatedAt : clock.updatedAt,
      maximumPace: maximumPaceAvailabilityFor(runtime.capabilities().runtimes),
      acceleration: cached?.acceleration ?? null,
    })
    executionStates.set(id, state)
    return state
  }

  const executionOverview = async (id: SimulationRunId): Promise<RunExecutionState> => {
    if (simulationRuns.has(id)) return await executionStatus(id)
    const summary = await summaryFor(id)
    if (!summary.clock) throw new Error(`Simulation Run clock is unavailable: ${id}`)
    const cached = executionStates.get(id) ?? await executionStoreFor(id).load()
    const state = runExecutionStateSchema.parse({
      playback: summary.clock.paused ? 'paused' : 'playing',
      pace: summary.clock.paused ? cached?.pace ?? 'realtime' : 'realtime',
      currentSimulationTime: summary.clock.currentTime,
      updatedAt: summary.clock.updatedAt,
      maximumPace: await maximumPaceAvailability(id),
      acceleration: cached?.acceleration ?? null,
    })
    executionStates.set(id, state)
    return state
  }

  const startMaximumPace = async (
    id: SimulationRunId,
    configInput: {
      readonly targetSimulationTime: IsoTimestamp | null
      readonly onComplete: AdvanceCompletion
      readonly resume?: AccelerationState
    },
  ): Promise<RunExecutionState> => {
    if (maximumPaceJobs.has(id)) return await executionStatus(id)
    const runtime = await load(id)
    let currentClock = runtime.snapshot().clock
    if (!currentClock) throw new Error('Simulation Run clock is not initialized')
    const maximumPace = maximumPaceAvailabilityFor(runtime.capabilities().runtimes)
    if (!maximumPace.available) throw Object.assign(new Error(maximumPace.reason), { code: 'fast_forward_unsupported' })
    if (!currentClock.paused) currentClock = await runtime.setClock({ paused: true })
    const releaseLease = acquireLease(id, 'maximum-pace')
    let finishJob!: () => void
    const controller: MaximumPaceController = {
      stopRequested: false,
      destination: { playback: 'paused', pace: 'maximum' },
      preserveAcceleration: true,
      done: new Promise<void>(resolve => { finishJob = resolve }),
    }
    maximumPaceJobs.set(id, controller)
    const startedAt = configInput.resume?.startedAt ?? nowIso()
    const startedSimulationTime = configInput.resume?.startedSimulationTime ?? currentClock.currentTime
    const priorActiveWallMs = configInput.resume?.activeWallMs ?? 0
    let acceleration = accelerationStateSchema.parse({
      kind: configInput.targetSimulationTime === null ? 'continuous' : 'timed',
      status: 'running',
      startedSimulationTime,
      ...(configInput.targetSimulationTime === null ? {} : { targetSimulationTime: configInput.targetSimulationTime }),
      currentSimulationTime: currentClock.currentTime,
      onComplete: configInput.onComplete,
      startedAt,
      updatedAt: nowIso(),
      activeWallMs: priorActiveWallMs,
      simulatedMs: Date.parse(currentClock.currentTime) - Date.parse(startedSimulationTime),
      measuredSpeed: 0,
    })
    let state = runExecutionStateSchema.parse({
      playback: 'playing', pace: 'maximum', currentSimulationTime: currentClock.currentTime,
      updatedAt: acceleration.updatedAt, maximumPace, acceleration,
    })
    executionStates.set(id, state)
    try { await executionStoreFor(id).save(state) }
    catch (error) {
      maximumPaceJobs.delete(id)
      executionStates.delete(id)
      releaseLease()
      finishJob()
      throw error
    }
    const wallStart = performance.now()
    let lastPersistedAt = wallStart
    const work = runtime.runMaximumPace(configInput.targetSimulationTime, {
      shouldStop: () => controller.stopRequested,
      onProgress: async currentSimulationTime => {
        const wallTime = performance.now()
        const activeWallMs = priorActiveWallMs + wallTime - wallStart
        const simulatedMs = Date.parse(currentSimulationTime) - Date.parse(startedSimulationTime)
        acceleration = accelerationStateSchema.parse({
          ...acceleration, currentSimulationTime, updatedAt: nowIso(), activeWallMs, simulatedMs,
          measuredSpeed: activeWallMs > 0 ? simulatedMs / activeWallMs : 0,
        })
        state = runExecutionStateSchema.parse({ ...state, currentSimulationTime, updatedAt: acceleration.updatedAt, acceleration })
        executionStates.set(id, state)
        if (wallTime - lastPersistedAt >= executionCheckpointWallIntervalMs) {
          lastPersistedAt = wallTime
          await executionStoreFor(id).save(state)
        }
      },
    }).then(async result => {
      const completedTarget = !result.stoppedEarly && configInput.targetSimulationTime !== null
      const destination = completedTarget
        ? { playback: configInput.onComplete === 'pause' ? 'paused' : 'playing', pace: 'realtime' } as const
        : controller.destination
      if (destination.playback === 'playing' && destination.pace === 'realtime') await runtime.setClock({ paused: false })
      const status = completedTarget ? 'completed' : controller.preserveAcceleration ? 'paused' : 'stopped'
      acceleration = accelerationStateSchema.parse({
        ...acceleration, status, currentSimulationTime: result.currentSimulationTime, updatedAt: nowIso(),
      })
      state = runExecutionStateSchema.parse({
        ...state, ...destination, currentSimulationTime: result.currentSimulationTime,
        updatedAt: acceleration.updatedAt, acceleration,
      })
      executionStates.set(id, state)
      await executionStoreFor(id).save(state)
    }).catch(async error => {
      const reason = error instanceof Error ? error.message : String(error)
      runtime.failStop(reason)
      const currentSimulationTime = runtime.snapshot().clock?.currentTime ?? acceleration.currentSimulationTime
      acceleration = accelerationStateSchema.parse({ ...acceleration, status: 'failed', currentSimulationTime, updatedAt: nowIso(), error: reason })
      state = runExecutionStateSchema.parse({
        ...state, playback: 'paused', currentSimulationTime, updatedAt: acceleration.updatedAt, acceleration,
      })
      executionStates.set(id, state)
      try { await executionStoreFor(id).save(state) }
      catch (persistError) { console.error(`failed to persist maximum-pace failure for ${id}`, persistError) }
    }).finally(() => {
      maximumPaceJobs.delete(id)
      releaseLease()
      finishJob()
    })
    void work
    return state
  }

  const applyExecution = async (id: SimulationRunId, input: ExecutionSetInput): Promise<RunExecutionState> => {
    let current = await executionStatus(id)
    let active = maximumPaceJobs.get(id)
    if (current.playback === 'playing' && current.pace === 'maximum' && !active) {
      current = await executionStatus(id)
      active = maximumPaceJobs.get(id)
    }
    const destination = {
      playback: input.playback ?? current.playback,
      pace: input.pace ?? current.pace,
    }
    if (destination.playback === current.playback && destination.pace === current.pace) return current
    if (active) {
      active.destination = destination
      active.preserveAcceleration = destination.playback === 'paused' && destination.pace === 'maximum'
      active.stopRequested = true
      await active.done
      return await executionStatus(id)
    }
    const runtime = await load(id)
    if (destination.pace === 'maximum' && destination.playback === 'playing') {
      const resumable = current.acceleration?.status === 'paused' ? current.acceleration : undefined
      return await startMaximumPace(id, {
        targetSimulationTime: resumable?.targetSimulationTime ?? null,
        onComplete: resumable?.onComplete ?? 'pause',
        ...(resumable === undefined ? {} : { resume: resumable }),
      })
    }
    const clock = await runtime.setClock({ paused: destination.playback === 'paused' })
    const stoppedAcceleration = current.acceleration === null || current.pace !== 'maximum' || destination.pace === 'maximum'
      ? current.acceleration
      : accelerationStateSchema.parse({ ...current.acceleration, status: 'stopped', currentSimulationTime: clock.currentTime, updatedAt: nowIso() })
    const state = runExecutionStateSchema.parse({
      ...current, ...destination, currentSimulationTime: clock.currentTime, updatedAt: nowIso(), acceleration: stoppedAcceleration,
    })
    executionStates.set(id, state)
    await executionStoreFor(id).save(state)
    return state
  }

  const setExecution = async (id: SimulationRunId, rawInput: ExecutionSetInput): Promise<RunExecutionState> => {
    const input = executionSetInputSchema.parse(rawInput)
    return await executionOperations.run(id, async () => await applyExecution(id, input))
  }

  const advanceExecution = async (id: SimulationRunId, rawInput: { readonly minutes: number; readonly onComplete?: AdvanceCompletion }): Promise<RunExecutionState> => {
    const input = executionAdvanceInputSchema.parse(rawInput)
    return await executionOperations.run(id, async () => {
      const active = maximumPaceJobs.get(id)
      if (active) {
        active.destination = { playback: 'paused', pace: 'maximum' }
        active.preserveAcceleration = false
        active.stopRequested = true
        await active.done
      }
      const runtime = await load(id)
      const clock = runtime.snapshot().clock
      if (!clock) throw new Error('Simulation Run clock is not initialized')
      const targetSimulationTime = new Date(Date.parse(clock.currentTime) + input.minutes * 60_000).toISOString() as IsoTimestamp
      return await startMaximumPace(id, { targetSimulationTime, onComplete: input.onComplete })
    })
  }

  const copyRun = async (sourceId: SimulationRunId, rawInput: { readonly name?: string }) => {
    const input = runCopyInputSchema.parse(rawInput)
    const sourceManifest = await manifestStoreFor(sourceId).load()
    if (!sourceManifest) throw new Error(`Simulation Run not found: ${sourceId}`)
    const familyId = sourceManifest.origin?.familyId ?? sourceId
    return await familyOperations.run(familyId, async () => {
      const source = await load(sourceId)
      const checkpoint = await source.checkpointForCopy()
      const ids = await listPersistedIds()
      const manifests = (await Promise.all(ids.map(id => manifestStoreFor(id).load()))).filter((manifest): manifest is SimulationRunManifest => manifest !== null)
      const copyNumber = Math.max(0, ...manifests
        .filter(manifest => manifest.origin?.familyId === familyId)
        .map(manifest => manifest.origin?.copyNumber ?? 0)) + 1
      const id = newSimulationRunId()
      const copiedAt = nowIso()
      const manifest = simulationRunManifestSchema.parse({
        ...sourceManifest,
        id,
        createdAt: copiedAt,
        origin: { kind: 'copy', familyId, copyNumber, sourceRunId: sourceId, sourceSequence: checkpoint.snapshot.seq, copiedAt },
      })
      const compiledScenario = await createCompiledScenarioStore(join(simulationRunRoot, sourceId, 'compiled-scenario.json')).load()
      await storageBudget.withGrowth(workspaceRoot, 32 * 1024 * 1024, async () => {
        await manifestStoreFor(id).create(manifest)
        await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).create(compiledScenario)
        await createSimulationRunSnapshotStore({ simulationRunId: id, path: join(simulationRunRoot, id, 'snapshot.json') }).save({
          ...checkpoint.snapshot,
          seq: 0,
          ...(checkpoint.snapshot.clock ? { clock: { ...checkpoint.snapshot.clock, paused: true } } : {}),
        })
        for (const [runtimeId, runtimeState] of Object.entries(checkpoint.runtimeStates)) {
          await createJsonRuntimeStateStore({ runtimeId, path: join(simulationRunRoot, id, 'runtimes', `${runtimeId}.json`) }).save(runtimeState)
        }
        const sourceSummary = await summaryFor(sourceId)
        await writeRunDisplayName(join(simulationRunRoot, id, 'display-name.json'), input.name ?? `${sourceSummary.title} - copy ${copyNumber}`)
      })
      return await createRuntime({ manifest })
    })
  }

  const load = (id: SimulationRunId): Promise<SimulationRunRuntime> => lifecycle.run(id, async () => {
    if (shuttingDown) throw new Error('Workspace runtime is closing')
    const existing = simulationRuns.get(id)
    if (existing) {
      scheduleIdleRuntimeCloseIfUnleased(id)
      return existing
    }
    const creating = creatingSimulationRuns.get(id)
    if (creating) return await creating
    const loading = (async (): Promise<SimulationRunRuntime> => {
      const manifest = await manifestStoreFor(id).load()
      if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
      return await createRuntime({ manifest })
    })().finally(() => {
      creatingSimulationRuns.delete(id)
      scheduleIdleRuntimeCloseIfUnleased(id)
    })
    creatingSimulationRuns.set(id, loading)
    return await loading
  })

  const closeLoaded = async (id: SimulationRunId): Promise<boolean> => {
    // A failed construction has already released its resources; close still succeeds as a no-op.
    await creatingSimulationRuns.get(id)?.catch(() => undefined)
    const runtime = simulationRuns.get(id)
    if (!runtime) return false
    const leases = leaseSummary(id).leasesByKind
    if (!shuttingDown && leases.api > 0) throw Object.assign(new Error('Simulation Run has active requests; retry after they complete'), { code: 'simulation_run_busy' })
    if (!shuttingDown && leases['maximum-pace'] > 0) throw Object.assign(new Error('Simulation Run is playing at maximum pace; pause it before closing'), { code: 'simulation_run_busy' })
    backgroundReleases.get(id)?.()
    backgroundReleases.delete(id)
    clearIdleRuntimeCloseTimer(id)
    leasesBySimulationRun.delete(id)
    await runtime.close()
    simulationRuns.delete(id)
    loadedCompiledScenarios.delete(id)
    return true
  }
  const close = (id: SimulationRunId): Promise<boolean> => lifecycle.run(id, () => closeLoaded(id))

  const reset = (id: SimulationRunId): Promise<SimulationRunRuntime> => lifecycle.run(id, async () => {
    await assertSimulationRunRecoveryNotRequired(join(simulationRunRoot, id, 'snapshot.json'))
    const leases = leaseSummary(id).leasesByKind
    if (leases.api > 0) throw Object.assign(new Error('Simulation Run has active requests; retry after they complete'), { code: 'simulation_run_busy' })
    if (leases['maximum-pace'] > 0) throw Object.assign(new Error('Simulation Run is playing at maximum pace; pause it before resetting'), { code: 'simulation_run_busy' })
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) throw new Error(`Simulation Run not found: ${id}`)
    const existing = simulationRuns.get(id)
    const resetEvent = existing
      ? await existing.publishResetBoundary({ scenarioId: manifest.scenario.id })
      : undefined
    await closeLoaded(id)
    const runDir = join(simulationRunRoot, id)
    await Promise.all([
      rm(join(runDir, 'snapshot.json'), { force: true }),
      rm(join(runDir, 'events.jsonl'), { force: true }),
      rm(join(runDir, 'runtimes'), { recursive: true, force: true }),
      rm(join(runDir, 'history.sqlite'), { force: true }),
      rm(join(runDir, 'history.sqlite-wal'), { force: true }),
      rm(join(runDir, 'history.sqlite-shm'), { force: true }),
      rm(join(runDir, 'execution.json'), { force: true }),
    ])
    return createRuntime({
      manifest,
      ...(resetEvent === undefined ? {} : { initialSeq: resetEvent.seq + 1 }),
    })
  })

  const deleteSimulationRun = (id: SimulationRunId): Promise<boolean> => lifecycle.run(id, async () => {
    const maximumPaceJob = maximumPaceJobs.get(id)
    if (maximumPaceJob) {
      maximumPaceJob.destination = { playback: 'paused', pace: 'realtime' }
      maximumPaceJob.preserveAcceleration = false
      maximumPaceJob.stopRequested = true
      await maximumPaceJob.done
    }
    const wasLoaded = await closeLoaded(id)
    pinnedScenarioFacts.delete(id)
    executionStates.delete(id)
    const runDir = join(simulationRunRoot, id)
    let existedOnDisk = true
    try {
      await lstat(runDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      existedOnDisk = false
    }
    if (existedOnDisk) await rm(runDir, { recursive: true, force: true })
    return wasLoaded || existedOnDisk
  })

  const listPersistedIds = async (): Promise<ReadonlyArray<SimulationRunId>> => {
    let entries: ReadonlyArray<{ readonly isDirectory: () => boolean; readonly name: string }>
    try {
      entries = await readdir(simulationRunRoot, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw err
    }
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => simulationRunIdSchema.safeParse(entry.name))
      .filter((result): result is { readonly success: true; readonly data: SimulationRunId } => result.success)
      .map(result => result.data)
      .sort()
  }

  const unavailableSummary = (id: SimulationRunId, loadError: string): SimulationRunSummary => ({
    id, name: null, title: id, scenarioId: null, scenarioTitle: null,
    scenarioRevisionId: null, createdAt: null, loaded: false,
    snapshotSeq: null, objectCount: null, clock: null, activeCapabilityIds: [], origin: null, roles: null, loadError,
  })

  const pinnedScenarioFactsFor = async (id: SimulationRunId): Promise<{ readonly title: string; readonly roles: RunRoles | null }> => {
    const pinned = pinnedScenarioFacts.get(id)
    if (pinned) return pinned
    const scenario = await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).load()
    const facts = { title: scenario.title, roles: runRolesOf(scenario) }
    pinnedScenarioFacts.set(id, facts)
    return facts
  }

  const runRoles = async (id: SimulationRunId): Promise<RunRoles | null> => {
    const loaded = simulationRuns.get(id)
    if (loaded) return loaded.roles()
    if (!await manifestStoreFor(id).load()) throw new Error(`Simulation Run not found: ${id}`)
    return (await pinnedScenarioFactsFor(id)).roles
  }

  const readSummary = async (id: SimulationRunId): Promise<SimulationRunSummary> => {
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) return unavailableSummary(id, 'Simulation Run Manifest is missing')
    const loaded = simulationRuns.get(id)
    // Names must not follow a mutable or deleted catalog entry. Read the pinned
    // compiled artifact independently of the authored revision.
    const { title: scenarioTitle, roles } = await pinnedScenarioFactsFor(id)
    const name = await readRunDisplayName(join(simulationRunRoot, id, 'display-name.json'))
    const title = name ?? scenarioTitle
    if (loaded) {
      const snapshot = loaded.snapshot()
      return {
        id,
        name,
        title,
        scenarioId: manifest.scenario.id,
        scenarioTitle,
        scenarioRevisionId: manifest.scenario.revisionId,
        createdAt: manifest.createdAt,
        loaded: true,
        snapshotSeq: snapshot.seq,
        objectCount: snapshot.objects.length,
        clock: snapshot.clock ?? null,
        activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
        origin: manifest.origin ?? null,
        roles,
      }
    }
    const snapshotStore = createSimulationRunSnapshotStore({
      simulationRunId: id,
      path: join(simulationRunRoot, id, 'snapshot.json'),
    })
    let snapshot
    let loadError: string | undefined
    try {
      snapshot = await snapshotStore.load()
    } catch (err) {
      if (!isUnreadableSnapshotError(err)) throw err
      loadError = unreadableSnapshotMessage(err)
      snapshot = null
    }
    return {
      id,
      name,
      title,
      scenarioId: manifest.scenario.id,
      scenarioTitle,
      scenarioRevisionId: manifest.scenario.revisionId,
      createdAt: manifest.createdAt,
      loaded: false,
      snapshotSeq: snapshot?.seq ?? null,
      objectCount: snapshot?.objects.length ?? null,
      clock: snapshot?.clock ?? null,
      activeCapabilityIds: capabilityIdsForRuntimeIds(manifest.runtimes.map(runtime => runtime.id)),
      origin: manifest.origin ?? null,
      roles,
      ...(loadError === undefined ? {} : { loadError }),
    }
  }

  const summaryFor = async (id: SimulationRunId): Promise<SimulationRunSummary> => {
    try { return await readSummary(id) }
    catch (error) {
      // One damaged/unsupported retained resource must not hide the workspace.
      // Its state remains untouched, and loading still rejects the real error.
      const reason = error instanceof ZodError
        ? error.issues.slice(0, 3).map(issue => `${issue.path.join('.') || 'state'}: ${issue.message}`).join('; ')
        : error instanceof Error ? error.message : String(error)
      return unavailableSummary(id, `Simulation Run is unreadable: ${reason}`)
    }
  }

  const listKnown = async (): Promise<ReadonlyArray<SimulationRunSummary>> => {
    const ids = new Set<SimulationRunId>([...simulationRuns.keys(), ...await listPersistedIds()])
    const summaries: SimulationRunSummary[] = []
    for (const id of [...ids].sort()) summaries.push(await summaryFor(id))
    return summaries
  }

  const renameRun = (id: SimulationRunId, name: string | null, expectedTitle: string): Promise<SimulationRunSummary> => {
    return lifecycle.run(id, async () => {
      runDisplayNameSchema.parse(name)
      const current = await summaryFor(id)
      if (current.scenarioId === null) throw new Error(`Simulation Run not found: ${id}`)
      if (current.title !== expectedTitle) throw Object.assign(new Error('Simulation Run name changed; refresh before renaming'), { code: 'simulation_run_name_changed' })
      await writeRunDisplayName(join(simulationRunRoot, id, 'display-name.json'), name)
      return await summaryFor(id)
    })
  }

  const scenarioRevisionForRun = async (id: SimulationRunId): Promise<ScenarioRevision | undefined> => {
    await ensureScenarioLibrary()
    const manifest = await manifestStoreFor(id).load()
    if (!manifest) return undefined
    return await scenarioLibrary.getRevision(scenarioRevisionIdFromManifest(manifest))
  }

  const measureDirectory = async (path: string): Promise<SimulationRunRegistryStatus['storage']> => {
    let totalBytes = 0
    let fileCount = 0
    let directoryCount = 0
    const visit = async (entryPath: string): Promise<void> => {
      let entryStats
      try {
        entryStats = await lstat(entryPath)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
        throw err
      }
      if (entryStats.isDirectory()) {
        directoryCount += 1
        for (const entry of await readdir(entryPath)) await visit(join(entryPath, entry))
        return
      }
      if (entryStats.isFile()) {
        fileCount += 1
        totalBytes += entryStats.size
      }
    }
    await visit(workspaceRoot)
    return { totalBytes, fileCount, directoryCount }
  }

  const status = async (): Promise<SimulationRunRegistryStatus> => ({
    dataDir: workspaceRoot,
    storage: await measureDirectory(workspaceRoot),
    simulationRuns: await listKnown(),
    loadedRuntimeMetrics: [...simulationRuns.values()].map(runtime => runtime.metrics()),
    leases: leaseSummaries(),
  })

  return {
    workspaceId: config.workspaceId,
    scenarioAuthoringCatalog: {
      ...config.scenarioAuthoringCatalog,
      commands: installedCapabilities.filter(entry => entry.capability.kind === 'command' && entry.capability.schedulable).map(entry => ({
        id: entry.capability.id, title: entry.capability.title, description: entry.capability.description,
        packId: entry.packId, runtimeId: entry.runtimeId, inputSchema: z.toJSONSchema(entry.capability.input, { io: 'input' }),
      })),
    },
    installedCapabilities,
    workspaceCapabilities: config.runtimeAdapters.flatMap(adapter => adapter.workspaceCapabilities ?? []),
    create,
    copy: copyRun,
    executionStatus,
    executionOverview,
    setExecution,
    advanceExecution,
    load,
    reset,
    delete: deleteSimulationRun,
    rename: renameRun,
    get: (id: SimulationRunId) => simulationRuns.get(id),
    list: () => [...simulationRuns.values()],
    listKnown,
    summary: summaryFor,
    runRoles,
    status,
    acquireLease,
    compiledScenarioForRun: async id => {
      const stored = await createCompiledScenarioStore(join(simulationRunRoot, id, 'compiled-scenario.json')).load()
      const manifest = await manifestStoreFor(id).load()
      if (!manifest || manifest.workspaceId !== config.workspaceId || stored.id !== manifest.scenario.id || compiledScenarioDigest(stored) !== manifest.scenario.compiledDigest) throw new Error(`Compiled Scenario integrity mismatch: ${id}`)
      return stored
    },
    loadedCompiledScenario: id => {
      const scenario = loadedCompiledScenarios.get(id)
      if (!scenario) throw new Error(`Simulation Run is not loaded: ${id}`)
      return scenario
    },
    setBackgroundExecution: async (id, enabled) => {
      await load(id)
      return lifecycle.run(id, async () => {
        if (!simulationRuns.has(id)) throw new Error(`Simulation Run not loaded: ${id}`)
        if (enabled && !backgroundReleases.has(id)) backgroundReleases.set(id, acquireLease(id, 'background'))
        if (!enabled) { backgroundReleases.get(id)?.(); backgroundReleases.delete(id) }
        return leaseSummary(id)
      })
    },
    shutdown: async () => {
      shuttingDown = true
      for (const job of maximumPaceJobs.values()) job.stopRequested = true
      await Promise.allSettled([...maximumPaceJobs.values()].map(job => job.done))
      await executionOperations.drain()
      await definitionOperations.close()
      await Promise.allSettled([...creatingSimulationRuns.values()])
      await lifecycle.drain()
      const results = await Promise.allSettled([...simulationRuns.keys()].map(close))
      compiledScenarios.clear()
      pinnedScenarioFacts.clear()
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Simulation Run shutdown failed')
    },
    leaseSummary,
    isIdle: () => simulationRuns.size === 0 && creatingSimulationRuns.size === 0 && definitionOperations.activeCount() === 0 && leasesBySimulationRun.size === 0,
    listScenarios: () => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.list()
    }),
    currentScenario: (id: string) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      return await scenarioLibrary.currentRevision(id)
    }),
    createScenario: source => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      await compileValidatedDefinition(source)
      return await storageBudget.withGrowth(workspaceRoot, Buffer.byteLength(JSON.stringify(source)) * 2, () => scenarioLibrary.create(source))
    }),
    previewScenario: source => definitionOperations.run(async () => {
      const compiled = await compileValidatedDefinition(source)
      return scenarioPreviewFor(compiled, config.scenarioRuntimeResolver.resolve(compiled).packs)
    }),
    updateScenario: (source, expectedRevisionId) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      await compileValidatedDefinition(source)
      return await storageBudget.withGrowth(workspaceRoot, Buffer.byteLength(JSON.stringify(source)) * 2, () => scenarioLibrary.update(source, expectedRevisionId))
    }),
    deleteScenario: (id: string, revisionId: ScenarioRevisionId) => definitionOperations.run(async () => {
      await ensureScenarioLibrary()
      const current = await scenarioLibrary.currentRevision(id)
      if (!current || current.id !== revisionId) return false
      return await scenarioLibrary.delete(id, revisionId)
    }),
    scenarioRevisionForRun,
    compileScenarioRevision: compileRevision,
    close,
  }
}
