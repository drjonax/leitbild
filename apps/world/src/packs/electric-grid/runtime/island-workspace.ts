import type { IslandFrequencyState } from './frequency/island-state.ts'
import { createFrequencyWorkspace, loadFrequencyState, type IslandFrequencyWorkspace } from './frequency/workspace.ts'
import { governorForGenerator } from './generator-dynamics.ts'
import type { GridRuntimeInstance, GridTopologyIsland } from './instance.ts'
import { externalFrequencyEquivalent, generatorSynchronisedAt, islandFixedInjectionMw, islandLossesMw, storageFrequencyUnit } from './island-input.ts'
import { connectedGridLoadMw } from './load-service.ts'
import { generatorOnline, generatorStopping } from './state/arrays.ts'
import { generatorMinimumStableMw } from './unit-commitment.ts'

// The frequency workspace of a stable island, aligned with its topology island's generators,
// storage, external systems and loads. Its inputs are those islandFrequencyInput gives, written
// field by field from the Grid's arrays before every advance.

/**
 * A workspace for the members of `structure` holding `state`. The members' static data (machine
 * ratings, governor classes, storage ratings, external equivalents, load priorities) is set here.
 */
export const islandWorkspaceHolding = (grid: GridRuntimeInstance, structure: GridTopologyIsland, state: IslandFrequencyState): IslandFrequencyWorkspace => {
  const { model, index } = grid.definition
  const generators = Array.from(structure.generatorIndices, generator => model.generators[generator]!)
  const loads = Array.from(structure.loadIndices, load => model.loads[load]!)
  const externals = Array.from(structure.externalIndices, system => externalFrequencyEquivalent(grid, index.externalSystems[system]!))
  const storage = Array.from(structure.storageIndices, item => storageFrequencyUnit(model.storage[item]!))
  const workspace = createFrequencyWorkspace({
    automation: grid.definition.automation,
    islandId: state.islandId,
    unitIds: generators.map(definition => definition.id),
    governorClasses: generators.map(definition => governorForGenerator(definition).governorClass),
    storageIds: storage.map(unit => unit.id),
    externalIds: externals.map(external => external.id),
    loadIds: loads.map(definition => definition.id),
    loadPriority: loads.map(definition => definition.priority),
    loadProtectedMw: loads.map(definition => definition.criticalMw),
  })
  loadFrequencyState(workspace, state)
  const units = workspace.units
  generators.forEach((definition, position) => {
    units.synchronous[position] = definition.synchronous ? 1 : 0
    units.ratedMva[position] = definition.ratedMva
    units.inertiaConstantSeconds[position] = definition.inertiaSeconds
    units.rampRateMwPerSecond[position] = definition.rampRateMwPerMinute / 60
  })
  storage.forEach((unit, position) => { workspace.storageUnits[position] = unit })
  externals.forEach((external, position) => { workspace.externalEquivalents[position] = external })
  return workspace
}

/** Whether `workspace` was built for exactly the members of `structure`, in its order. */
export const islandWorkspaceFits = (grid: GridRuntimeInstance, structure: GridTopologyIsland, workspace: IslandFrequencyWorkspace): boolean => {
  const { model, index } = grid.definition
  const same = (indices: Int32Array, ids: ReadonlyArray<string>, idOf: (item: number) => string): boolean => {
    if (indices.length !== ids.length) return false
    for (let position = 0; position < indices.length; position += 1) if (idOf(indices[position]!) !== ids[position]) return false
    return true
  }
  return same(structure.generatorIndices, workspace.unitIds, generator => model.generators[generator]!.id)
    && same(structure.storageIndices, workspace.storageIds, item => model.storage[item]!.id)
    && same(structure.externalIndices, workspace.externalIds, system => index.externalSystems[system]!.id)
    && same(structure.loadIndices, workspace.loadIds, load => model.loads[load]!.id)
}

/**
 * Writes the island's inputs for the next advance from the Grid's arrays, as islandFrequencyInput
 * gives them: only an online unit runs between its minimum stable generation and its
 * availability; a stopping unit unloads to 0 MW and holds no reserve.
 */
export const refreshIslandWorkspaceInputs = (grid: GridRuntimeInstance, structure: GridTopologyIsland, workspace: IslandFrequencyWorkspace): void => {
  const definitions = grid.definition.model.generators
  const generators = grid.arrays.generators
  const units = workspace.units
  for (let position = 0; position < structure.generatorIndices.length; position += 1) {
    const generator = structure.generatorIndices[position]!
    const lifecycle = generators.lifecycle[generator]!
    const reserved = lifecycle !== generatorStopping
    units.synchronised[position] = generatorSynchronisedAt(generators, generator) ? 1 : 0
    units.minimumMw[position] = lifecycle === generatorOnline ? generatorMinimumStableMw(definitions[generator]!) : 0
    units.maximumMw[position] = generators.availableMw[generator]!
    units.targetMw[position] = generators.targetMw[generator]!
    units.fcrNReserveMw[position] = reserved ? generators.fcrNReserveMw[generator]! : 0
    units.fcrDUpReserveMw[position] = reserved ? generators.fcrDUpReserveMw[generator]! : 0
    units.fcrDDownReserveMw[position] = reserved ? generators.fcrDDownReserveMw[generator]! : 0
    units.afrrUpReserveMw[position] = reserved ? generators.afrrUpReserveMw[generator]! : 0
    units.afrrDownReserveMw[position] = reserved ? generators.afrrDownReserveMw[generator]! : 0
    units.mfrrUpReserveMw[position] = reserved ? generators.mfrrUpReserveMw[generator]! : 0
    units.mfrrDownReserveMw[position] = reserved ? generators.mfrrDownReserveMw[generator]! : 0
  }
  const loads = grid.arrays.loads
  for (let position = 0; position < structure.loadIndices.length; position += 1) {
    workspace.loadDemandMw[position] = connectedGridLoadMw(loads, structure.loadIndices[position]!)
  }
  // An external equivalent changes only with its scheduled import; the rest follows from its definition.
  for (let position = 0; position < structure.externalIndices.length; position += 1) {
    const scheduledImportMw = grid.arrays.externalSystems[structure.externalIndices[position]!]!.scheduledImportMw
    const equivalent = workspace.externalEquivalents[position]!
    if (!Object.is(equivalent.scheduledImportMw, scheduledImportMw)) workspace.externalEquivalents[position] = { ...equivalent, scheduledImportMw }
  }
  workspace.lossesMw = islandLossesMw(grid, structure)
  workspace.fixedInjectionMw = islandFixedInjectionMw(grid, structure)
}
