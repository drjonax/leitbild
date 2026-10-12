import type { ElectricalConnectionDefinition } from '../../../core/model/index.ts'
import type { VariablePath } from '../graph/index.ts'
import { processPlantElectricalBoundaries } from '../electrical-ports.ts'
import type { ProcessPlantRuntimeInstance } from '../runtime-instance.ts'
import { componentVariablePath } from '../runtime/index.ts'

// A Plant connected to a Grid takes its offsite boundary (available, voltageFraction, frequencyHz) from
// the Grid port on every update. A plant-side fault that makes the offsite source unavailable — the
// loss-offsite-power action, or a write of available=false — isolates the Plant from the Grid on its own
// side, as a switchyard or line fault does: the isolation holds against the port, so the Plant keeps no
// offsite voltage and its port reports disconnected to the Grid, until a write of available=true clears
// it or the Run is reset. The Grid owns the boundary's voltage and frequency; plant-side writes of them
// are refused rather than overwritten by the next update.

/** A connected port a plant-side fault has isolated, and the fault that did. */
export interface OffsiteIsolation {
  readonly portId: string
  readonly cause: string
}

type CoupledBoundaryVariable = 'available' | 'voltageFraction' | 'frequencyHz'

interface CoupledBoundaryVariableRef {
  readonly connection: ElectricalConnectionDefinition
  readonly variable: CoupledBoundaryVariable
}

/** Per Plant, each coupled boundary variable's path and the connection that writes it. */
export const coupledBoundaryVariables = (
  connections: ReadonlyArray<ElectricalConnectionDefinition>,
  plants: ReadonlyMap<string, ProcessPlantRuntimeInstance>,
): ReadonlyMap<string, ReadonlyMap<VariablePath, CoupledBoundaryVariableRef>> => {
  const byPlant = new Map<string, Map<VariablePath, CoupledBoundaryVariableRef>>()
  for (const connection of connections) {
    const plantId = String(connection.system.objectId)
    const plant = plants.get(plantId)
    if (!plant) continue
    const boundary = processPlantElectricalBoundaries(plant.plant).find(candidate => candidate.port.id === connection.system.portId)
    if (!boundary) throw new Error(`process plant electrical boundary not found: ${plantId}:${connection.system.portId}`)
    const paths = byPlant.get(plantId) ?? new Map<VariablePath, CoupledBoundaryVariableRef>()
    for (const variable of ['available', 'voltageFraction', 'frequencyHz'] as const) {
      paths.set(componentVariablePath(boundary.component, variable), { connection, variable })
    }
    byPlant.set(plantId, paths)
  }
  return byPlant
}

/** What a set of plant-side writes does to a Plant's coupled boundaries. */
export interface CoupledBoundaryEffect {
  readonly isolate: ReadonlyArray<ElectricalConnectionDefinition>
  readonly clear: ReadonlyArray<ElectricalConnectionDefinition>
}

/**
 * Classifies plant-side writes against the Plant's coupled boundary variables: available=false
 * isolates, available=true clears, and a write of the Grid-owned voltage or frequency is refused.
 */
export const coupledBoundaryEffect = (
  variables: ReadonlyMap<VariablePath, CoupledBoundaryVariableRef> | undefined,
  writes: ReadonlyArray<{ readonly path: VariablePath; readonly value: unknown }>,
): { readonly ok: true; readonly effect: CoupledBoundaryEffect } | { readonly ok: false; readonly reason: string } => {
  const isolate: ElectricalConnectionDefinition[] = []
  const clear: ElectricalConnectionDefinition[] = []
  if (variables === undefined) return { ok: true, effect: { isolate, clear } }
  for (const write of writes) {
    const ref = variables.get(write.path)
    if (!ref) continue
    if (ref.variable !== 'available') {
      return {
        ok: false,
        reason: `${write.path} is set by the Grid this Plant is connected to (${ref.connection.network.objectId}:${ref.connection.network.portId}); change the Grid, or isolate the Plant from it by making the offsite source unavailable (loss-offsite-power, or available=false)`,
      }
    }
    if (write.value === false) isolate.push(ref.connection)
    else if (write.value === true) clear.push(ref.connection)
    else return { ok: false, reason: `${write.path} takes true or false, not ${String(write.value)}` }
  }
  return { ok: true, effect: { isolate, clear } }
}

/** Refuses a ramp of any coupled boundary variable: the Grid sets them on every update. */
export const coupledBoundaryRampRefusal = (
  variables: ReadonlyMap<VariablePath, CoupledBoundaryVariableRef> | undefined,
  path: VariablePath,
): string | null => {
  const ref = variables?.get(path)
  return ref === undefined
    ? null
    : `${path} is set by the Grid this Plant is connected to (${ref.connection.network.objectId}:${ref.connection.network.portId}) and cannot be ramped`
}
