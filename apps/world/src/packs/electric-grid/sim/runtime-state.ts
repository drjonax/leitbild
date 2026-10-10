import { z } from 'zod'
import type { IslandFrequencyState } from '../runtime/frequency/island-state.ts'
import type { GridRuntimeInstance, RestoredGridRuntimeState } from '../runtime/instance.ts'

const finite = z.number().finite()
const nonNegative = finite.nonnegative()

// Version 2 persists island identity and the full frequency-control state (governors, AGC, mFRR,
// LFDD latches and protection relays). Version 1 runs do not restore: there is no migration.
export const electricGridRuntimeStateSchemaVersion = 2

const reservesSchema = z.object({
  fcrNMw: nonNegative,
  fcrDUpMw: nonNegative,
  fcrDDownMw: nonNegative,
  afrrUpMw: nonNegative,
  afrrDownMw: nonNegative,
  mfrrUpMw: nonNegative,
  mfrrDownMw: nonNegative,
}).strict()

const unitFrequencyStateSchema = z.object({
  scheduledMw: finite,
  fcrNMw: finite,
  fcrDUpMw: finite,
  fcrDDownMw: finite,
  afrrMw: finite,
  mfrr: z.object({ fromMw: finite, toMw: finite, startedAtSeconds: finite }).strict(),
  protection: z.object({
    timersSeconds: z.record(z.string(), nonNegative),
    trip: z.object({ atSeconds: finite, elementId: z.string().min(1), cause: z.enum(['under-frequency', 'over-frequency', 'rocof']) }).strict().nullable(),
  }).strict(),
}).strict()

const islandFrequencyStateSchema = z.object({
  islandId: z.string().min(1),
  automationId: z.string().min(1),
  elapsedSeconds: nonNegative,
  frequencyHz: finite.positive().nullable(),
  rocofHzPerSecond: finite,
  units: z.record(z.string(), unitFrequencyStateSchema),
  storage: z.record(z.string(), z.object({
    responseMw: finite,
    stateOfChargeFraction: finite.min(0).max(1),
    operatingState: z.enum(['idle', 'charging', 'discharging', 'disconnected']),
    ffrPhase: z.enum(['armed', 'active', 'deactivating', 'recovering']),
    ffrPhaseStartedAtSeconds: finite,
  }).strict()),
  externals: z.record(z.string(), z.object({ fcrNMw: finite, fcrDUpMw: finite, fcrDDownMw: finite, afrrMw: finite }).strict()),
  agc: z.object({ requestMw: finite, previousErrorMw: finite, nextCycleAtSeconds: finite }).strict().nullable(),
  mfrr: z.object({ sustainedSeconds: nonNegative, sustainedDirection: z.enum(['up', 'down']).nullable() }).strict().nullable(),
  lfdd: z.object({
    stages: z.record(z.string(), z.object({
      status: z.enum(['armed', 'operated', 'disarmed']),
      belowThresholdSeconds: nonNegative,
      operatedAtSeconds: finite.nullable(),
      shedFractionByLoad: z.record(z.string(), finite.min(0).max(1)),
    }).strict()),
  }).strict(),
}).strict()

export const electricGridRuntimeStateSchema = z.object({
  schemaVersion: z.literal(electricGridRuntimeStateSchemaVersion),
  grids: z.array(z.object({
    gridId: z.string().min(1),
    definitionDigest: z.string().regex(/^[a-f0-9]{64}$/),
    elapsedMs: nonNegative,
    tick: z.number().int().nonnegative(),
    branches: z.array(z.object({
      id: z.string().min(1),
      state: z.enum(['closed', 'open']),
      availability: finite.min(0).max(1),
    }).strict()),
    generators: z.array(z.object({
      id: z.string().min(1),
      state: z.enum(['online', 'offline', 'starting', 'stopping', 'tripped']),
      availableMw: nonNegative,
      targetMw: nonNegative,
      reserves: reservesSchema,
      synchronisesAtElapsedMs: nonNegative.nullable(),
    }).strict()),
    loads: z.array(z.object({ id: z.string().min(1), nominalDemandMw: nonNegative, manualDemandLimitMw: nonNegative.nullable() }).strict()),
    storage: z.array(z.object({ id: z.string().min(1), stateOfChargeFraction: finite.min(0).max(1) }).strict()),
    externalSystems: z.array(z.object({ id: z.string().min(1), scheduledImportMw: finite }).strict()),
    hvdcLinks: z.array(z.object({ id: z.string().min(1), setpointMw: finite, transferMw: finite }).strict()),
    islands: z.array(z.object({ id: z.string().min(1), anchorBusId: z.string().min(1), frequency: islandFrequencyStateSchema.nullable() }).strict()),
    lossLoadByBusMw: z.array(nonNegative),
  }).strict()),
}).strict()
export type ElectricGridRuntimeState = z.infer<typeof electricGridRuntimeStateSchema>

/** Parses stored runtime state; a store written by another schema version fails with an explicit error. */
export const parseElectricGridRuntimeState = (raw: unknown): ElectricGridRuntimeState => {
  const version = typeof raw === 'object' && raw !== null ? (raw as { readonly schemaVersion?: unknown }).schemaVersion : undefined
  if (version !== electricGridRuntimeStateSchemaVersion) {
    throw new Error(`stored Electric Grid runtime state has schema version ${String(version)}; this runtime restores only version ${electricGridRuntimeStateSchemaVersion} (no migration)`)
  }
  return electricGridRuntimeStateSchema.parse(raw)
}

export const runtimeStateForElectricGrids = (grids: ReadonlyMap<string, GridRuntimeInstance>): ElectricGridRuntimeState => ({
  schemaVersion: electricGridRuntimeStateSchemaVersion,
  grids: [...grids.values()].map(grid => {
    const islands = grid.islandPlan
    if (!islands) throw new Error(`Grid ${grid.definition.gridId} has not advanced; its runtime state cannot be saved`)
    return {
      gridId: grid.definition.gridId,
      definitionDigest: grid.definition.definitionDigest,
      elapsedMs: grid.elapsedMs,
      tick: grid.tick,
      branches: [...grid.branches].map(([id, state]) => ({ id, state: state.state, availability: state.availability })),
      generators: [...grid.generators].map(([id, state]) => ({
        id,
        state: state.state,
        availableMw: state.availableMw,
        targetMw: state.targetMw,
        reserves: { ...state.reserves },
        synchronisesAtElapsedMs: state.synchronisesAtElapsedMs,
      })),
      loads: [...grid.loads].map(([id, state]) => ({ id, nominalDemandMw: state.nominalDemandMw, manualDemandLimitMw: state.manualDemandLimitMw })),
      storage: [...grid.storage].map(([id, state]) => ({ id, stateOfChargeFraction: state.stateOfChargeFraction })),
      externalSystems: [...grid.externalSystems].map(([id, state]) => ({ id, scheduledImportMw: state.scheduledImportMw })),
      hvdcLinks: [...grid.hvdcLinks].map(([id, state]) => ({ id, setpointMw: state.setpointMw, transferMw: state.transferMw })),
      islands: islands.islands.map(island => ({ id: island.id, anchorBusId: island.anchorBusId, frequency: island.frequency === null ? null : structuredClone(island.frequency) as ElectricGridRuntimeState['grids'][number]['islands'][number]['frequency'] })),
      lossLoadByBusMw: Array.from(grid.lossLoadByBusMw),
    }
  }),
})

export const restoredGridRuntimeStateFor = (
  state: ElectricGridRuntimeState | null,
  gridId: string,
  definitionDigest: string,
): RestoredGridRuntimeState | undefined => {
  const grid = state?.grids.find(candidate => candidate.gridId === gridId)
  if (!grid) return undefined
  if (grid.definitionDigest !== definitionDigest) throw new Error(`stored Grid ${gridId} does not match its resolved Model, Operating Point, and Automation definition`)
  return { ...grid, islands: grid.islands.map(island => ({ ...island, frequency: island.frequency as IslandFrequencyState | null })) }
}
