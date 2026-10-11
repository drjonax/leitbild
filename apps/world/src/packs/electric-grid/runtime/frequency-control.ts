import { resetIslandGeneratorProtection, type FrequencyAction } from './frequency/island-state.ts'
import { advanceIslandFrequency, type IslandFrequencyAdvance } from './frequency/island.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance } from './instance.ts'
import { gridGeneratorIsSynchronised, islandFrequencyInput } from './island-input.ts'

// Enough recent actions for an operator or Agent to see a cascade; older ones are in the journal.
const retainedFrequencyEvents = 200

const storageStateFor = (operatingState: string): 'idle' | 'charging' | 'discharging' | 'unavailable' =>
  operatingState === 'disconnected' ? 'unavailable' : operatingState as 'idle' | 'charging' | 'discharging'

const actionSummary = (action: FrequencyAction): string => {
  switch (action.kind) {
    case 'generator-trip': return `${action.unitId} tripped by ${action.cause} protection (${action.elementId})`
    case 'lfdd-stage-operated': return `LFDD ${action.stageId} shed ${action.shedMw.toFixed(1)} of ${action.requestedMw.toFixed(1)} MW`
    case 'mfrr-activated': return `mFRR activated ${action.activatedMw.toFixed(1)} MW (shortfall ${action.shortfallMw.toFixed(1)} MW)`
    case 'storage-state-changed': return `${action.storageId} ${action.from} → ${action.to}`
    case 'island-collapsed': return `island collapsed: ${action.cause}`
  }
}

const recordActions = (grid: GridRuntimeInstance, islandId: string, actions: ReadonlyArray<FrequencyAction>): void => {
  for (const action of actions) {
    grid.frequencyEvents.push({
      islandId, atElapsedSeconds: action.atSeconds, kind: action.kind, summary: actionSummary(action),
      ...(action.kind === 'generator-trip' ? { trip: { unitId: action.unitId, elementId: action.elementId, cause: action.cause } } : {}),
    })
  }
  if (grid.frequencyEvents.length > retainedFrequencyEvents) grid.frequencyEvents.splice(0, grid.frequencyEvents.length - retainedFrequencyEvents)
}

/** Writes one advance's mechanical outputs and latches into the Grid asset states; electrical outputs follow in the network solve. */
const applyAdvance = (grid: GridRuntimeInstance, island: GridIsland, advance: IslandFrequencyAdvance): void => {
  for (const unit of advance.units) {
    const state = grid.generators.get(unit.id)!
    state.scheduledMw = unit.synchronised ? unit.scheduledMw : 0
    state.fcrMw = unit.synchronised ? unit.fcrNMw + unit.fcrDMw : 0
    state.afrrMw = unit.synchronised ? unit.afrrMw : 0
    state.mfrrMw = unit.synchronised ? unit.mfrrMw : 0
  }
  for (const action of advance.actions) {
    if (action.kind !== 'generator-trip') continue
    const state = grid.generators.get(action.unitId)!
    state.state = 'tripped'
    state.targetMw = 0
    state.scheduledMw = 0
    state.fcrMw = 0
    state.afrrMw = 0
    state.mfrrMw = 0
  }
  for (const item of advance.storage) {
    const state = grid.storage.get(item.id)!
    state.dispatchMw = item.powerMw
    state.stateOfChargeFraction = item.stateOfChargeFraction
    state.state = storageStateFor(item.operatingState)
  }
  for (const load of advance.loads) {
    const state = grid.loads.get(load.id)!
    state.servedMw = load.servedMw
    state.lfddShedMw = load.lfddShedMw
  }
  for (const external of advance.externals) {
    const state = grid.externalSystems.get(external.id)!
    state.mechanicalMw = external.mechanicalMw
    state.fcrMw = external.fcrNMw + external.fcrDMw
    state.afrrMw = external.afrrMw
  }
  island.frequency = advance.state
  if (advance.state.frequencyHz === null) {
    island.energized = false
    island.frequency = null
    island.rocofHzPerSecond = null
    return
  }
  island.rocofHzPerSecond = advance.state.rocofHzPerSecond
  if (advance.extremes) {
    island.minimumHz = Math.min(island.minimumHz ?? advance.extremes.minimumHz, advance.extremes.minimumHz)
    island.maximumHz = Math.max(island.maximumHz ?? advance.extremes.maximumHz, advance.extremes.maximumHz)
  }
}

/**
 * A unit returned to service by command has had its trip reset by that command; the frequency
 * state's protection latch follows so the unit can synchronise again.
 */
const resetReturnedUnits = (grid: GridRuntimeInstance, island: GridIsland): void => {
  const frequency = island.frequency!
  for (const [unitId, unit] of Object.entries(frequency.units)) {
    if (unit.protection.trip && gridGeneratorIsSynchronised(grid.generators.get(unitId)!)) {
      island.frequency = resetIslandGeneratorProtection(grid.definition.automation, island.frequency!, unitId)
    }
  }
}

/**
 * Advances every energised island's swing equation, reserves, LFDD and protection by `seconds` in
 * the Automation's fixed sub-steps, against the demand and injections currently set on the Grid.
 */
export const advanceGridFrequencyControl = (grid: GridRuntimeInstance, islands: GridIslandPlan, seconds: number): void => {
  for (const island of islands.islands) {
    if (!island.energized || island.frequency === null) continue
    resetReturnedUnits(grid, island)
    const structure = islands.plan.islands[island.planIndex]!
    const advance = advanceIslandFrequency(grid.definition.automation, island.frequency!, islandFrequencyInput(grid, structure, island.id), seconds)
    recordActions(grid, island.id, advance.actions)
    applyAdvance(grid, island, advance)
  }
}
