import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { COMPOSED_READOUTS_MAX_SIGNALS } from './composition.ts'
import { icTripWatchedPaths, icWatchedPaths } from './ic-thresholds.ts'

const readableIn = (plant: CompiledProcessPlant) => (path: VariablePath): boolean => {
  const binding = plant.graph.signalBindingByPath.get(path)
  return binding !== undefined && !binding.writable && binding.published
}

// The few values a unit overview leads with, chosen by what the Plant
// declares rather than by name: each signal a trip rule judges on equipment
// outside the loops (a reactor's power, a pressurizer's pressure, a
// containment's pressure; per-loop values stay on their loop's symbols), then
// the first key value of each energy source and sink (a core's outlet
// temperature, a generator's output). Unpublished signals are left out; so
// are writable ones, which would show a demand, and the states symbols draw
// (a turbine stop valve's position, a breaker's contacts).
export const overviewKeyValues = (plant: CompiledProcessPlant): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (path: VariablePath) => {
    const binding = graph.signalBindingByPath.get(path)
    return binding?.owner.type === 'component' ? graph.components[binding.owner.componentIndex] : undefined
  }
  const readable = readableIn(plant)
  const drawn = new Set(graph.components.flatMap(component => [...component.semantics.aspects, ...component.semantics.embedded.flatMap(device => device.aspects)])
    .flatMap(aspect => aspect.state === undefined ? [] : [aspect.state.path]))
  const tripWatched = icTripWatchedPaths(plant).filter(path => {
    const owner = ownerOf(path)
    return owner !== undefined && owner.metadata?.loopId === undefined && !drawn.has(path)
  })
  const energyEnds = graph.components
    .filter(component => component.semantics.energy.some(role => role.role === 'source' || role.role === 'sink'))
    .flatMap(component => component.semantics.keyValues.slice(0, 1))
  return [...new Set([...tripWatched, ...energyEnds])].filter(readable).slice(0, COMPOSED_READOUTS_MAX_SIGNALS)
}

/**
 * The values a detail of some equipment leads with: its signals an alarm or
 * trip rule judges (trips first), then the key values its kind declares, then
 * its instruments (signals with a tag). Each is taken in turn from every
 * item, so parallel equipment is compared value by value.
 */
export const equipmentKeyValues = (plant: CompiledProcessPlant, components: ReadonlyArray<number>): ReadonlyArray<VariablePath> => {
  const graph = plant.graph
  const ownerOf = (binding: { readonly owner: { readonly type: string; readonly componentIndex?: number } } | undefined) =>
    binding?.owner.type === 'component' ? binding.owner.componentIndex : undefined
  const watched = icWatchedPaths(plant)
  const readable = readableIn(plant)
  const inTurn = (listOf: (component: number) => ReadonlyArray<VariablePath>): ReadonlyArray<VariablePath> => {
    const lists = components.map(component => listOf(component).filter(readable))
    return Array.from({ length: Math.max(0, ...lists.map(list => list.length)) }, (_, rank) => lists.flatMap(list => list.slice(rank, rank + 1))).flat()
  }
  return [...new Set([
    ...inTurn(component => watched.filter(path => ownerOf(graph.signalBindingByPath.get(path)) === component)),
    ...inTurn(component => graph.components[component]!.semantics.keyValues),
    ...inTurn(component => graph.signalBindings.filter(binding => binding.tagId !== undefined && ownerOf(binding) === component).map(binding => binding.path)),
  ])].slice(0, COMPOSED_READOUTS_MAX_SIGNALS)
}
