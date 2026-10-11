import { advanceFrequencyWorkspace } from './frequency/advance.ts'
import { validateIslandInput, type FrequencyAction } from './frequency/island-state.ts'
import { frequencyStateOf, resetWorkspaceUnitProtection, type IslandFrequencyWorkspace } from './frequency/workspace.ts'
import type { GridIsland, GridIslandPlan, GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { allocateGridIslandReserves } from './island-reserves.ts'
import { generatorSynchronisedAt, islandFrequencyInput } from './island-input.ts'
import { refreshIslandWorkspaceInputs } from './island-workspace.ts'
import { generatorTripped } from './state/arrays.ts'
import { gridTablesFor } from './state/tables.ts'

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

/**
 * Writes the island's last advance from its workspace into the Grid asset states: mechanical
 * outputs and latches; electrical outputs follow in the network solve. The workspace lists units,
 * storage, loads and externals in the island's order.
 */
const applyAdvance = (grid: GridRuntimeInstance, island: GridIsland, structure: GridTopologyIsland, workspace: IslandFrequencyWorkspace): void => {
  const generators = grid.arrays.generators
  for (let position = 0; position < structure.generatorIndices.length; position += 1) {
    const generator = structure.generatorIndices[position]!
    const synchronised = workspace.outputSynchronised[position] === 1
    generators.scheduledMw[generator] = synchronised ? workspace.scheduledMw[position]! : 0
    generators.fcrMw[generator] = synchronised ? workspace.outputFcrNMw[position]! + workspace.outputFcrDMw[position]! : 0
    generators.afrrMw[generator] = synchronised ? workspace.afrrMw[position]! : 0
    generators.mfrrMw[generator] = synchronised ? workspace.outputMfrrMw[position]! : 0
  }
  for (const action of workspace.actions) {
    if (action.kind !== 'generator-trip') continue
    const generator = gridTablesFor(grid.definition).generatorIndexById.get(action.unitId)!
    generators.lifecycle[generator] = generatorTripped
    generators.targetMw[generator] = 0
    generators.scheduledMw[generator] = 0
    generators.fcrMw[generator] = 0
    generators.afrrMw[generator] = 0
    generators.mfrrMw[generator] = 0
  }
  for (let position = 0; position < structure.storageIndices.length; position += 1) {
    const item = workspace.storageOutputs[position]!
    const state = grid.arrays.storage[structure.storageIndices[position]!]!
    state.dispatchMw = item.powerMw
    state.stateOfChargeFraction = item.stateOfChargeFraction
    state.state = storageStateFor(item.operatingState)
  }
  const loads = grid.arrays.loads
  for (let position = 0; position < structure.loadIndices.length; position += 1) {
    const load = structure.loadIndices[position]!
    loads.servedMw[load] = workspace.loadServedMw[position]!
    loads.lfddShedMw[load] = workspace.loadLfddShedMw[position]!
  }
  for (let position = 0; position < structure.externalIndices.length; position += 1) {
    const external = workspace.externalOutputs[position]!
    const state = grid.arrays.externalSystems[structure.externalIndices[position]!]!
    state.mechanicalMw = external.mechanicalMw
    state.fcrMw = external.fcrNMw + external.fcrDMw
    state.afrrMw = external.afrrMw
  }
  if (workspace.frequencyHz === null) {
    island.energized = false
    island.workspace = null
    island.rocofHzPerSecond = null
    return
  }
  island.rocofHzPerSecond = workspace.rocofHzPerSecond
  if (workspace.hasExtremes) {
    const extremes = workspace.extremes
    island.minimumHz = Math.min(island.minimumHz ?? extremes.minimumHz, extremes.minimumHz)
    island.maximumHz = Math.max(island.maximumHz ?? extremes.maximumHz, extremes.maximumHz)
  }
}

/**
 * A unit returned to service by command has had its trip reset by that command; the frequency
 * state's protection latch follows so the unit can synchronise again.
 */
const resetReturnedUnits = (grid: GridRuntimeInstance, structure: GridTopologyIsland, workspace: IslandFrequencyWorkspace): void => {
  for (let position = 0; position < structure.generatorIndices.length; position += 1) {
    if (workspace.protection[position]!.trip && generatorSynchronisedAt(grid.arrays.generators, structure.generatorIndices[position]!)) {
      resetWorkspaceUnitProtection(grid.definition.automation, workspace, position)
    }
  }
}

/**
 * Advances every energised island's swing equation, reserves, LFDD and protection by `seconds` in
 * the Automation's fixed sub-steps, against the demand and injections currently set on the Grid.
 * Each island's workspace advances in place; inputs that fail the common-case checks are validated
 * in detail against the island's IslandFrequencyInput, which names the offending member.
 */
export const advanceGridFrequencyControl = (grid: GridRuntimeInstance, islands: GridIslandPlan, seconds: number): void => {
  const automation = grid.definition.automation
  for (const island of islands.islands) {
    const workspace = island.workspace
    if (!island.energized || workspace === null) continue
    const structure = islands.plan.islands[island.planIndex]!
    resetReturnedUnits(grid, structure, workspace)
    allocateGridIslandReserves(grid, structure)
    refreshIslandWorkspaceInputs(grid, structure, workspace)
    advanceFrequencyWorkspace(automation, workspace, seconds, {
      inputsValidated: false,
      validateInDetail: () => validateIslandInput(automation, frequencyStateOf(workspace), islandFrequencyInput(grid, structure, island.id)),
    })
    recordActions(grid, island.id, workspace.actions)
    applyAdvance(grid, island, structure, workspace)
  }
}
