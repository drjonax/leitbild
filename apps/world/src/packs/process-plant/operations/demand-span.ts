import type { CompiledPlantGraph, CompiledStateAspect, EquipmentFunction, ProcessSignalBinding, VariablePath } from '../graph/index.ts'
import type { ProcessPlantIcRule } from '../runtime/index.ts'
import { resolveProcessPlantSignalBinding } from '../signals.ts'

// A position a person sets anywhere between its ends: a modulating valve's
// position command whose position the model solves, over the command's hard
// range. What the controls offer as a demand (controls.ts) and what the
// protection hold lets through as a throttle (command-guard.ts) are both
// read from this, never from what the equipment is called.

export interface DemandSpan {
  readonly min: number
  readonly max: number
}

/** A demand is set in hundredths of its span: a valve in whole percent of its stroke. */
const DEMAND_STEP_SHARE = 0.01

/** The finest step a demand is set in, in its own unit. */
export const demandStepOf = (span: DemandSpan): number => Number(((span.max - span.min) * DEMAND_STEP_SHARE).toPrecision(12))

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

/**
 * Holds each declared throttle floor to what it can mean: a rule declaring
 * one drives at least one demand a person sets in its span, each to its
 * open end, and the floor lies strictly between that span's ends.
 */
export const assertThrottleFloorsValid = (graph: CompiledPlantGraph, rules: ReadonlyArray<ProcessPlantIcRule>): void => {
  for (const rule of rules) {
    if (rule.throttleFloor === undefined) continue
    const floor = rule.throttleFloor.value
    const driven = rule.effects.flatMap(effect => {
      if (effect.type !== 'writeSignal') return []
      const path = resolveProcessPlantSignalBinding(graph, effect.signal).path
      const span = demandSpanOf(graph, path)
      return span === null ? [] : [{ path, span, value: effect.value }]
    })
    if (driven.length === 0) throw new Error(`I&C rule ${rule.id} declares a throttle floor but drives no demand a person sets in its span`)
    for (const { path, span, value } of driven) {
      if (value !== span.max) throw new Error(`I&C rule ${rule.id} declares a throttle floor but drives ${path} to ${String(value)}, not its open end ${span.max}`)
      if (!(floor > span.min && floor < span.max)) throw new Error(`I&C rule ${rule.id} declares throttle floor ${floor} outside ${path}'s span ${span.min}..${span.max}`)
    }
  }
}
