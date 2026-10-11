import type { IsoTimestamp } from '../../../../core/model/index.ts'

/** The branch protection element that operated. */
export type GridBranchTripElement = 'thermal' | 'emergency-duration' | 'instantaneous'

export interface GridBranchTrip {
  readonly element: GridBranchTripElement
  readonly at: IsoTimestamp
  readonly atElapsedMs: number
  /** Flow and loading (% of the derated continuous rating) the relay measured when it operated. */
  readonly flowMw: number
  readonly loadingPercent: number
  /** Thermal state when it operated, as (flow / derated rating)² in steady state. */
  readonly thermalLevel: number
}

/** Relay state of one branch; it persists with the Grid. */
export interface GridBranchProtectionState {
  /** First-order conductor heating towards (flow / derated rating)²; 1 is the steady state at the continuous rating. */
  thermalLevel: number
  /** Elapsed time of the first sample above the derated emergency rating in the current excursion; null below it. */
  overEmergencySinceElapsedMs: number | null
  /** The operation that tripped the branch; null unless the branch is tripped. */
  trip: GridBranchTrip | null
}

/** Grid-wide relay state. */
export interface GridProtectionState {
  /** Elapsed time of the last relay sample; null before the first. */
  lastSampleElapsedMs: number | null
  /** Thermal states start at their steady state for the flows of the Grid's first solve after its starting dispatch. */
  thermalInitialised: boolean
  /**
   * A fresh Grid whose connected systems have not reported yet: its starting dispatch is still to
   * come, so relays neither initialise nor sample (they would act on flows without the systems'
   * power). The adapter clears it once it has dispatched the Grid; it is never persisted.
   */
  startingDispatchPending: boolean
  /** Generators whose trip has been recorded as a protection event, with what tripped them; a reset removes them. */
  readonly recordedGeneratorTrips: Map<string, GridGeneratorTripRecord>
}

export interface GridGeneratorTripRecord {
  /** The frequency-protection cause, or command for trip-generator. */
  readonly element: 'under-frequency' | 'over-frequency' | 'rocof' | 'command'
  readonly elementId: string | null
}

export const createGridProtectionState = (restored?: {
  readonly lastSampleElapsedMs: number | null
  readonly thermalInitialised: boolean
  readonly recordedGeneratorTrips: ReadonlyArray<GridGeneratorTripRecord & { readonly generatorId: string }>
}): GridProtectionState => ({
  lastSampleElapsedMs: restored?.lastSampleElapsedMs ?? null,
  thermalInitialised: restored?.thermalInitialised ?? false,
  startingDispatchPending: false,
  recordedGeneratorTrips: new Map((restored?.recordedGeneratorTrips ?? []).map(item => [item.generatorId, { element: item.element, elementId: item.elementId }])),
})
