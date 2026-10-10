import type { CompiledComponent } from '../graph/index.ts'
import type { CompiledProcessPlant } from '../plant-compiler.ts'

// Behaviors look these up every solver step; a Plant's components never change.
const uniqueComponentCache = new WeakMap<CompiledProcessPlant, Map<string, CompiledComponent | null>>()

const uniqueComponentByKind = (
  plant: CompiledProcessPlant,
  kind: string,
): CompiledComponent | null => {
  let byKind = uniqueComponentCache.get(plant)
  if (byKind === undefined) {
    byKind = new Map()
    uniqueComponentCache.set(plant, byKind)
  }
  const cached = byKind.get(kind)
  if (cached !== undefined) return cached
  const matches = plant.graph.components.filter(component => String(component.kind) === kind)
  if (matches.length > 1) {
    throw new Error(`process plant ${plant.id} has multiple ${kind} components; declare explicit coupling before using this behavior`)
  }
  const component = matches[0] ?? null
  byKind.set(kind, component)
  return component
}

export const primarySystemPressurizer = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'pressurizer')

export const primarySystemReactorVessel = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'reactorVessel')

export const primarySystemReactorCore = (
  plant: CompiledProcessPlant,
): CompiledComponent | null => uniqueComponentByKind(plant, 'reactorCore')
