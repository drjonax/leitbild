import { equipmentKeyValues, readsAsMeasured, stopCommands, stopReadings } from '../ic/key-values.ts'
import type { VariablePath } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'
import { createProcessPlantRuntime } from '../runtime/index.ts'

// What each element's detail leads with (ruling Q22): its equipment key
// values, as the old detail display ranked them (equipmentKeyValues), other
// elements' values among them (a steam generator's feed line flows). The
// lists depend on the operating mode only, never on live state (a trip acted,
// a range silenced): each is ranked for the mode at the Plant's nominal state,
// its model's initial values, so a declaration's revision changes with the
// mode's lists and not with every trip, and the compose caches hold.
//
// An energy end a trip commands also declares what verifies its stop (D-E,
// amending D-86): its stop readings, led with once the commands of one trip
// commanding it read as that trip wrote them. Both are static; World reads
// the commands each sample, so after a trip the core leads with its rods on
// the bottom, both trip breakers and its flux, as E-0 verifies it.

const stops = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, ElementStop>>()

/** What verifies a component's stop, and the commands that say a trip commanding it has acted (each set one trip's). */
export interface ElementStop {
  readonly when: ReadonlyArray<ReadonlyArray<{ readonly path: VariablePath; readonly value: unknown }>>
  readonly lead: ReadonlyArray<VariablePath>
}

/** Each component's stop, by component id: those that declare stop readings, a trip commands and an operator reads. */
export const elementStops = (plant: CompiledProcessPlant): ReadonlyMap<string, ElementStop> => stops.get(plant) ?? (() => {
  const measured = (path: VariablePath): boolean => {
    const binding = plant.graph.signalBindingByPath.get(path)
    return binding !== undefined && readsAsMeasured(binding) && binding.simulatorOnly !== true
  }
  const found = new Map(plant.graph.components.flatMap(component => {
    const lead = stopReadings(plant, component.index).filter(measured)
    const when = stopCommands(plant, component.index)
    return lead.length === 0 || when.length === 0 ? [] : [[String(component.id), { when, lead }] as const]
  }))
  stops.set(plant, found)
  return found
})()

const nominalReads = new WeakMap<CompiledProcessPlant, ReadonlyMap<string, unknown>>()

/** The Plant's nominal state: each variable as a fresh runtime of its model and operating point starts it. */
const nominal = (plant: CompiledProcessPlant): ReadonlyMap<string, unknown> => nominalReads.get(plant) ?? (() => {
  const values = new Map(createProcessPlantRuntime({ system: plant }).snapshot().variables.map(variable => [String(variable.path), variable.value] as const))
  nominalReads.set(plant, values)
  return values
})()

const byMode = new WeakMap<CompiledProcessPlant, Map<string, ReadonlyMap<string, ReadonlyArray<VariablePath>>>>()

/** Each component's lead values in the mode, by component id; one that leads with none is left out. A Plant that declares no modes passes null. */
export const elementLeads = (plant: CompiledProcessPlant, mode: string | null): ReadonlyMap<string, ReadonlyArray<VariablePath>> => {
  const known = byMode.get(plant) ?? new Map<string, ReadonlyMap<string, ReadonlyArray<VariablePath>>>()
  byMode.set(plant, known)
  const key = mode ?? ''
  const cached = known.get(key)
  if (cached !== undefined) return cached
  const values = nominal(plant)
  const now = { mode, read: (path: VariablePath) => values.get(String(path)) }
  const leads = new Map(plant.graph.components.flatMap(component => {
    const lead = equipmentKeyValues(plant, [component.index], now)
    return lead.length === 0 ? [] : [[String(component.id), lead] as const]
  }))
  known.set(key, leads)
  return leads
}

const digests = new WeakMap<CompiledProcessPlant, Map<string, string>>()

/**
 * A short digest of the mode's lead lists (FNV-1a, 8 hex digits): equal lists in two modes give one revision. Kept per
 * mode like the lists it digests, since every declaration asked for computes its revision with it (each sample's).
 */
export const leadDigest = (plant: CompiledProcessPlant, mode: string | null): string => {
  const known = digests.get(plant) ?? new Map<string, string>()
  digests.set(plant, known)
  const cached = known.get(mode ?? '')
  if (cached !== undefined) return cached
  const text = JSON.stringify([...elementLeads(plant, mode)])
  let hash = 0x811c9dc5
  for (let at = 0; at < text.length; at += 1) {
    hash ^= text.charCodeAt(at)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  const digest = hash.toString(16).padStart(8, '0')
  known.set(mode ?? '', digest)
  return digest
}
