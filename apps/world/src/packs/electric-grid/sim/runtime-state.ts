import { z } from 'zod'
import type { IslandFrequencyState } from '../runtime/frequency/island-state.ts'
import type { IsoTimestamp } from '../../../core/model/index.ts'
import { persistedGridAlarmState } from '../runtime/alarms.ts'
import type { GridRuntimeInstance, RestoredGridRuntimeState } from '../runtime/instance.ts'
import { branchStatusCodes, generatorLifecycleCodes, publishedNullable } from '../runtime/state/arrays.ts'
import { readReserves } from '../runtime/state/views.ts'

const finite = z.number().finite()
const nonNegative = finite.nonnegative()

// Version 5 persists island identity, the full frequency-control state (governors, AGC, mFRR,
// LFDD latches and generator relays), branch relay state, alarm records, whether a manual
// shedding limit is emergency shedding, and each HVDC link's operating state and trip. Earlier
// runs do not restore: there is no migration.
export const electricGridRuntimeStateSchemaVersion = 5

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

const isoTimestamp = z.iso.datetime({ offset: true }).transform(value => value as IsoTimestamp)

const branchProtectionStateSchema = z.object({
  thermalLevel: nonNegative,
  overEmergencySinceElapsedMs: nonNegative.nullable(),
  trip: z.object({
    element: z.enum(['thermal', 'emergency-duration', 'instantaneous']),
    at: isoTimestamp,
    atElapsedMs: nonNegative,
    flowMw: finite,
    loadingPercent: nonNegative,
    thermalLevel: nonNegative,
  }).strict().nullable(),
}).strict()

const hvdcLinkStateSchema = z.object({
  id: z.string().min(1),
  state: z.enum(['deblocked', 'blocked', 'tripped']),
  setpointMw: finite,
  transferMw: finite,
  trip: z.object({ cause: z.enum(['command', 'ac-voltage-loss']), atElapsedMs: nonNegative, transferMw: finite }).strict().nullable(),
}).strict()

const alarmRecordSchema = z.object({
  id: z.string().min(1),
  scope: z.enum(['island', 'branch', 'generator', 'hvdc', 'external']),
  assetId: z.string().min(1),
  condition: z.string().min(1),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  title: z.string().min(1),
  message: z.string().min(1),
  islandId: z.string().min(1).nullable(),
  value: finite.nullable(),
  limit: finite.nullable(),
  unit: z.enum(['Hz', '%', 'MW']).nullable(),
  active: z.boolean(),
  raisedAt: isoTimestamp,
  raisedAtElapsedMs: nonNegative,
  clearedAt: isoTimestamp.nullable(),
  clearedAtElapsedMs: nonNegative.nullable(),
  acknowledged: z.boolean(),
  acknowledgedAt: isoTimestamp.nullable(),
  shelvedUntil: isoTimestamp.nullable(),
  shelvedUntilElapsedMs: nonNegative.nullable(),
  clearSinceElapsedMs: nonNegative.nullable(),
  clearDelayMs: nonNegative,
  lastTransitionElapsedMs: nonNegative,
  occurrences: z.number().int().positive(),
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
      state: z.enum(['closed', 'open', 'tripped']),
      availability: finite.min(0).max(1),
      protection: branchProtectionStateSchema,
    }).strict()),
    generators: z.array(z.object({
      id: z.string().min(1),
      state: z.enum(['online', 'offline', 'starting', 'stopping', 'tripped']),
      availableMw: nonNegative,
      targetMw: nonNegative,
      reserves: reservesSchema,
      synchronisesAtElapsedMs: nonNegative.nullable(),
    }).strict()),
    loads: z.array(z.object({ id: z.string().min(1), nominalDemandMw: nonNegative, manualDemandLimitMw: nonNegative.nullable(), manualShedEmergency: z.boolean() }).strict()),
    storage: z.array(z.object({ id: z.string().min(1), stateOfChargeFraction: finite.min(0).max(1) }).strict()),
    externalSystems: z.array(z.object({ id: z.string().min(1), scheduledImportMw: finite, targetImportMw: finite, exchangeVoided: z.boolean() }).strict()),
    hvdcLinks: z.array(hvdcLinkStateSchema),
    islands: z.array(z.object({ id: z.string().min(1), anchorBusId: z.string().min(1), frequency: islandFrequencyStateSchema.nullable() }).strict()),
    lossLoadByBusMw: z.array(nonNegative),
    protection: z.object({
      lastSampleElapsedMs: nonNegative.nullable(),
      thermalInitialised: z.boolean(),
      recordedGeneratorTrips: z.array(z.object({
        generatorId: z.string().min(1),
        element: z.enum(['under-frequency', 'over-frequency', 'rocof', 'command']),
        elementId: z.string().min(1).nullable(),
      }).strict()),
    }).strict(),
    alarms: z.object({
      records: z.array(alarmRecordSchema),
      pending: z.array(z.object({ id: z.string().min(1), sinceElapsedMs: nonNegative }).strict()),
      baseIslandIds: z.array(z.string().min(1)).nullable(),
      clock: z.object({ at: isoTimestamp, elapsedMs: nonNegative }).strict().nullable(),
    }).strict(),
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

// Branch, generator and load state is read from the Grid's arrays by model index; the shapes are
// those of the state views (runtime/state/views.ts).
export const runtimeStateForElectricGrids = (grids: ReadonlyMap<string, GridRuntimeInstance>): ElectricGridRuntimeState => ({
  schemaVersion: electricGridRuntimeStateSchemaVersion,
  grids: [...grids.values()].map(grid => {
    const islands = grid.islandPlan
    if (!islands) throw new Error(`Grid ${grid.definition.gridId} has not advanced; its runtime state cannot be saved`)
    const { model } = grid.definition
    const { branches, generators, loads } = grid.arrays
    return {
      gridId: grid.definition.gridId,
      definitionDigest: grid.definition.definitionDigest,
      elapsedMs: grid.elapsedMs,
      tick: grid.tick,
      branches: model.branches.map((branch, index) => {
        const trip = branches.trip[index]!
        return {
          id: branch.id,
          state: branchStatusCodes[branches.status[index]!]!,
          availability: branches.availability[index]!,
          protection: {
            thermalLevel: branches.thermalLevel[index]!,
            overEmergencySinceElapsedMs: publishedNullable(branches.overEmergencySinceElapsedMs[index]!),
            trip: trip === null ? null : structuredClone(trip),
          },
        }
      }),
      generators: model.generators.map((generator, index) => ({
        id: generator.id,
        state: generatorLifecycleCodes[generators.lifecycle[index]!]!,
        availableMw: generators.availableMw[index]!,
        targetMw: generators.targetMw[index]!,
        reserves: readReserves(generators, index),
        synchronisesAtElapsedMs: publishedNullable(generators.synchronisesAtElapsedMs[index]!),
      })),
      loads: model.loads.map((load, index) => ({
        id: load.id,
        nominalDemandMw: loads.nominalDemandMw[index]!,
        manualDemandLimitMw: publishedNullable(loads.manualDemandLimitMw[index]!),
        manualShedEmergency: loads.manualShedEmergency[index] === 1,
      })),
      storage: [...grid.storage].map(([id, state]) => ({ id, stateOfChargeFraction: state.stateOfChargeFraction })),
      externalSystems: [...grid.externalSystems].map(([id, state]) => ({ id, scheduledImportMw: state.scheduledImportMw, targetImportMw: state.targetImportMw, exchangeVoided: state.exchangeVoided })),
      hvdcLinks: [...grid.hvdcLinks].map(([id, state]) => ({ id, state: state.state, setpointMw: state.setpointMw, transferMw: state.transferMw, trip: state.trip === null ? null : { ...state.trip } })),
      islands: islands.islands.map(island => ({ id: island.id, anchorBusId: island.anchorBusId, frequency: island.frequency === null ? null : structuredClone(island.frequency) as ElectricGridRuntimeState['grids'][number]['islands'][number]['frequency'] })),
      lossLoadByBusMw: Array.from(grid.lossLoadByBusMw),
      protection: {
        lastSampleElapsedMs: grid.protection.lastSampleElapsedMs,
        thermalInitialised: grid.protection.thermalInitialised,
        recordedGeneratorTrips: [...grid.protection.recordedGeneratorTrips].map(([generatorId, trip]) => ({ generatorId, ...trip })),
      },
      alarms: persistedGridAlarmState(grid.alarms),
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
