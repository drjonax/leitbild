import type { CompiledPlantGraph, CompiledStateAspect, EquipmentFunction, ProcessSignalBinding, VariablePath } from '../graph/index.ts'

// A position a person sets anywhere between its ends: a modulating valve's
// position command whose position the model solves, over the command's hard
// range. What the controls offer as a demand (controls.ts) and what the
// protection hold lets through as a throttle (command-guard.ts) are both
// read from this, never from what the equipment is called.

export interface DemandSpan {
  readonly min: number
  readonly max: number
}

/** The span of an aspect's command a person sets by hand; null for any other command (a two-state one, a set point). */
export const modulatingDemandSpan = (aspect: CompiledStateAspect, equipmentFunction: EquipmentFunction | undefined, binding: ProcessSignalBinding): DemandSpan | null => {
  if (aspect.aspect !== 'position' || equipmentFunction !== 'modulating' || aspect.state?.reading !== 'value' || binding.quantity !== 'ratio') return null
  const range = binding.limits?.hardRange
  if (range === undefined) throw new Error(`modulating position command declares no hard range: ${binding.path}`)
  return { min: range.min, max: range.max }
}

/** The span of the command at a path, on the component or bundled device whose aspect it commands; null where it is no such command. */
export const demandSpanOf = (graph: CompiledPlantGraph, path: VariablePath): DemandSpan | null => {
  const binding = graph.signalBindingByPath.get(path)
  if (binding === undefined) return null
  for (const component of graph.components) {
    const groups = [
      { aspects: component.semantics.aspects, equipmentFunction: component.semantics.function },
      ...component.semantics.embedded.map(device => ({ aspects: device.aspects, equipmentFunction: device.function })),
    ]
    for (const group of groups) {
      const aspect = group.aspects.find(candidate => candidate.command === path)
      if (aspect !== undefined) return modulatingDemandSpan(aspect, group.equipmentFunction, binding)
    }
  }
  return null
}
