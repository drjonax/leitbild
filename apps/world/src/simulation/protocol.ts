import type { z } from 'zod'
import type { ActorId,ClientId,CommandEnvelope,CommandResult,ElectricalConnectionDefinition,InteractionSignal,IsoTimestamp,ObjectId,OperationalObject,PackRuntimeRecordingBatch,Provenance,RecordedSample,RunViewer,ScenarioRecordingSelection,ScenarioRole,ScenarioSide,ScenarioWorldDefinition,SimulationClockState,SimulationRunEvent,SimulationRunId,TelemetryState } from '../core/model/index.ts'
import type { PackRuntimeClock } from '../core/packs/protocol.ts'

export interface PackRuntimeSnapshot {
  readonly simulationRunId: SimulationRunId
  readonly objects: ReadonlyArray<OperationalObject>
  readonly capturedAt: IsoTimestamp
}

export type PackRuntimeEventHistory = 'record' | 'snapshot-only'

interface PackRuntimeEventBase {
  readonly at: IsoTimestamp
  readonly provenance: Provenance
}

export type PackRuntimeEvent =
  | (PackRuntimeEventBase & {
      readonly type: 'object.upserted'
      readonly object: OperationalObject
      readonly history: PackRuntimeEventHistory
    })
  | (PackRuntimeEventBase & {
      readonly type: 'object.deleted'
      readonly objectId: ObjectId
      readonly history: PackRuntimeEventHistory
    })
  | (PackRuntimeEventBase & {
      readonly type: 'telemetry.sampled'
      readonly objectId: ObjectId
      readonly telemetry: TelemetryState
      readonly history: 'snapshot-only'
    })
  | (PackRuntimeEventBase & {
      readonly type: 'interaction.signal'
      readonly signal: InteractionSignal
    })

export interface PackRuntimeRealtimeMessage {
  readonly type: string
  readonly at: IsoTimestamp
  readonly payload: unknown
}

export interface PackRuntimeRealtimeInput {
  readonly type: string
  readonly at: IsoTimestamp
  readonly actorId?: ActorId
  readonly clientId?: ClientId
  readonly payload: unknown
}

export interface PackRuntimeEmission {
  readonly type: 'event.emission'
  readonly events: ReadonlyArray<PackRuntimeEvent>
  readonly realtimeMessages?: ReadonlyArray<PackRuntimeRealtimeMessage>
  readonly recording?: PackRuntimeRecordingBatch
  readonly emittedAt: IsoTimestamp
  readonly runtimeId: string
}

export interface PackRuntimeHealth {
  readonly runtimeId: string
  readonly state: 'ready' | 'degraded' | 'failed'
  readonly failureCount: number
  readonly lastSuccessfulInteractionAt: IsoTimestamp
  readonly lastFailure?: {
    readonly at: IsoTimestamp
    readonly operation: string
    readonly message: string
  }
}

export type PackRuntimeEventHandler = (emission: PackRuntimeEmission) => void

export interface PackRuntimeConnection {
  readonly getSnapshot: () => Promise<PackRuntimeSnapshot>
  readonly subscribe: (handler: PackRuntimeEventHandler) => () => void
  readonly sendCommand: (command: CommandEnvelope, context: PackCommandContext) => Promise<CommandResult>
  readonly receiveRealtimeInput?: (input: PackRuntimeRealtimeInput) => Promise<void>
  readonly commandEventHistory?: (command: CommandEnvelope) => PackRuntimeEventHistory
  readonly invokeQuery: (query: PackRuntimeQuery) => Promise<unknown>
  readonly observeCommittedEvents: (events: ReadonlyArray<SimulationRunEvent>) => Promise<void>
  /** Read peer providers only after every Pack has applied this committed batch.
   * Emitted consequences are a new batch, never a recursive partial commit. */
  readonly afterCommittedEvents?: (events: ReadonlyArray<SimulationRunEvent>) => Promise<void>
  readonly observeInitialSnapshot?: (objects: ReadonlyArray<OperationalObject>) => Promise<void>
  /** Pure pre-commit constraint check against canonical candidate state. Packs
   * without cross-object deletion constraints deliberately omit this hook. */
  readonly validateObjectDeletion?: (objectId: ObjectId, objects: ReadonlyArray<OperationalObject>) => void
  readonly setClock: (clock: SimulationClockState) => Promise<void>
  /** Advance simulated mechanics exactly to this paused Run boundary. This is
   * distinct from changing wall-paced clock controls. */
  readonly advanceTo?: (clock: SimulationClockState) => Promise<void>
  /** Flush all private mechanics needed to reconstruct this exact boundary. */
  readonly checkpoint?: () => Promise<void>
  /** Reject unsupported time changes before any runtime or the shared clock is mutated. */
  readonly validateClock?: (clock: SimulationClockState) => Promise<void>
  readonly health?: () => ReadonlyArray<PackRuntimeHealth>
  readonly close: () => Promise<void>
}

/** Private runtime invocation. Public callers use the same Capability id and
 * schemas through the Workspace Capability Broker. */
export interface PackRuntimeQuery {
  readonly capabilityId: string
  readonly input: unknown
  /**
   * The caller's role view in a Run that declares roles, stamped by core from
   * the caller's connection, never from input. Absent in open mode, for the
   * Scenario timeline and for queries between Packs.
   */
  readonly viewer?: RunViewer
}

/** What core tells a Pack about a command's caller beyond the journaled envelope. */
export interface PackCommandContext {
  /** As PackRuntimeQuery.viewer: from the caller's connection, absent in open mode and for the timeline. */
  readonly viewer?: RunViewer
}

export interface PackRuntimeStateStore {
  readonly load: () => Promise<unknown | null>
  readonly save: (state: unknown) => Promise<void>
}

export type SimulationCapabilityKind = 'command' | 'query'

/** Canonical callable surface contributed by a World Pack Runtime. The same
 * id and schemas are used by the runtime router, Scenario timeline, UI, and
 * Workspace Capability Broker. */
export interface SimulationCapability {
  readonly id: string
  readonly kind: SimulationCapabilityKind
  readonly title: string
  readonly description: string
  /** Optional Pack-owned vocabulary used only to find this Capability. */
  readonly searchTerms?: ReadonlyArray<string>
  readonly risk: 'read' | 'write' | 'destructive'
  readonly idempotent: boolean
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly schedulable?: boolean
  /** Objects whose detailed state a query inspects. Broad discovery/list
   * operations deliberately omit this: they may reveal that an object exists,
   * but not bypass a restriction on detailed inspection. */
  readonly inspectObjectIds?: (input: unknown) => ReadonlyArray<ObjectId>
  readonly buildCommand?: (input: unknown) => {
    readonly targetObjectIds: ReadonlyArray<ObjectId>
    readonly payload: unknown
  }
}

export interface PackRuntimeAdapter {
  readonly id: string
  readonly version: string
  readonly packId: string
  readonly clock: PackRuntimeClock
  readonly capabilities: ReadonlyArray<SimulationCapability>
  /** Pack-owned operations needed before a Run exists, such as validating a source. */
  readonly workspaceCapabilities?: ReadonlyArray<PackWorkspaceCapability>
  /** Conditional read-only dependencies, validated before saving or loading. */
  readonly requiredQueries?: (runtimeConfig: unknown) => ReadonlyArray<string>
  readonly realtimeInputTypes?: ReadonlyArray<string>
  readonly commandEventHistory?: Readonly<Record<string, PackRuntimeEventHistory>>
  readonly connect: (config: PackRuntimeConnectionConfig) => Promise<PackRuntimeConnection>
}

export interface PackWorkspaceCapability {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly searchTerms?: ReadonlyArray<string>
  readonly kind: 'query' | 'command'
  readonly risk: 'read' | 'write' | 'destructive'
  readonly idempotent: boolean
  readonly input: z.ZodType
  readonly output: z.ZodType
  readonly invoke: (input: unknown) => Promise<unknown>
}

export interface PackScenarioRuntimeConfig {
  readonly scenarioId: string
  readonly runtimeIds: ReadonlyArray<string>
  readonly world: ScenarioWorldDefinition
  readonly initialObjects: ReadonlyArray<OperationalObject>
  readonly connections: ReadonlyArray<ElectricalConnectionDefinition>
  readonly runtimeConfigByRuntimeId?: Readonly<Record<string, unknown>>
  readonly runtimeConfig: unknown
  /**
   * The Scenario's roles and sides, fixed for the Run's lifetime, for a
   * role-aware runtime that words and judges by them. Each is absent when the
   * Scenario declares none.
   */
  readonly roles?: ReadonlyArray<ScenarioRole>
  readonly sides?: ReadonlyArray<ScenarioSide>
}

/**
 * The samples this runtime recorded in its Run's historian, read by
 * simulation time: one series and window per read, the newest up to the
 * limit. The host binds it to the runtime, so a Pack reads only what it
 * recorded itself.
 */
export interface PackRuntimeRecordedHistory {
  readonly read: (query: {
    readonly seriesId: string
    readonly from: IsoTimestamp
    readonly to: IsoTimestamp
    readonly limit: number
  }) => ReadonlyArray<RecordedSample>
}

export interface PackRuntimeQueries {
  readonly has: (capabilityId: string) => boolean
  /** A query between Packs carries no viewer: only core stamps one, from a caller's connection. */
  readonly invoke: (query: Omit<PackRuntimeQuery, 'viewer'>) => Promise<unknown>
}
export interface PackRuntimeConnectionConfig {
  /** Workspace-owned persistence scope. Required only by adapters with shared local data. */
  readonly workspace?: { readonly id: string; readonly dataDir: string; readonly storageBudget?: import('@leitbild/module-runtime').StorageBudget }
  /** Provider execution availability, independent of physical signal age or simulation pause. */
  readonly isObjectProviderAvailable?: (objectId: ObjectId) => boolean
  /** Current committed object projection, including other Packs. Never mutable peer mechanics. */
  readonly objectById?: (objectId: ObjectId) => OperationalObject | undefined
  /** The owning Run's clock. Standalone Pack hosts may own a local clock instead. */
  readonly runClock?: import('../core/model/time.ts').SimulationClockReader
  /** Read-only, schema-validated access to active providers within this run. */
  readonly queries?: PackRuntimeQueries
  readonly simulationRunId: SimulationRunId
  readonly scenario: PackScenarioRuntimeConfig
  /** Restored Pack objects when resuming a run. Fresh runs use the compiled
   * Scenario objects in `scenario.initialObjects`. */
  readonly initialObjects?: ReadonlyArray<OperationalObject>
  /** Initial read-only projection of every active Pack's objects. Pack runtimes
   * may use this for discovery, but may only return mutations for owned objects. */
  readonly initialWorldObjects?: ReadonlyArray<OperationalObject>
  readonly runtimeStateStore?: PackRuntimeStateStore
  readonly runtimeStateStores?: Readonly<Record<string, PackRuntimeStateStore>>
  readonly recording?: ScenarioRecordingSelection
  readonly recordingByRuntimeId?: Readonly<Record<string, ScenarioRecordingSelection>>
  /** What this runtime has recorded so far; present with `recording` where the Run keeps a historian. */
  readonly recordedHistory?: PackRuntimeRecordedHistory
  readonly recordedHistoryByRuntimeId?: Readonly<Record<string, PackRuntimeRecordedHistory>>
}
