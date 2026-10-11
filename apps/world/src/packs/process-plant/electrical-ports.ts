import { z } from 'zod'
import {
  electricalPortDefinitionSchema,
  type ElectricalPortDefinition,
  type IsoTimestamp,
} from '../../core/model/index.ts'
import type { CompiledComponent } from './graph/index.ts'
import { componentVariablePath } from './runtime/index.ts'
import type { CompiledProcessPlant } from './plant-compiler.ts'
import type { ProcessPlantRuntimeInstance } from './runtime-instance.ts'

const boundaryParametersSchema = z.object({
  externalPortId: z.string().min(1),
  nominalVoltageKv: z.number().finite().positive(),
  maximumExportMw: z.number().finite().nonnegative(),
  maximumImportMw: z.number().finite().nonnegative(),
  generatorInertiaSeconds: z.number().finite().nonnegative().optional(),
}).passthrough()

export interface ProcessPlantElectricalBoundary {
  readonly component: CompiledComponent
  readonly port: ElectricalPortDefinition
}

export const processPlantElectricalBoundaries = (
  plant: CompiledProcessPlant,
): ReadonlyArray<ProcessPlantElectricalBoundary> => plant.graph.components.flatMap(component => {
  if (component.kind !== 'electricalGridSource') return []
  const parsed = boundaryParametersSchema.safeParse(component.parameters)
  if (!parsed.success) return []
  return [{
    component,
    port: electricalPortDefinitionSchema.parse({
      id: parsed.data.externalPortId,
      label: component.label,
      role: 'system',
      nominalKv: parsed.data.nominalVoltageKv,
      maximumExportMw: parsed.data.maximumExportMw,
      maximumImportMw: parsed.data.maximumImportMw,
      ...(parsed.data.generatorInertiaSeconds === undefined ? {} : { inertiaSeconds: parsed.data.generatorInertiaSeconds }),
    }),
  }]
})

export const processPlantElectricalPortDefinitions = (
  plant: CompiledProcessPlant,
): ReadonlyArray<ElectricalPortDefinition> =>
  processPlantElectricalBoundaries(plant).map(boundary => boundary.port)

const totalAuxiliaryDemandMw = (plant: ProcessPlantRuntimeInstance): number =>
  plant.plant.graph.components.reduce((total, component) => {
    const path = componentVariablePath(component, 'demandMw')
    if (!component.variables.some(variable => variable.path === path)) return total
    const value = plant.runtime.readVariable(path)
    return total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0)
  }, 0)

const grossGenerationMw = (plant: ProcessPlantRuntimeInstance): number =>
  plant.plant.graph.components.reduce((total, component) => {
    if (component.kind !== 'turbineLoadSink') return total
    const value = plant.runtime.readVariable(componentVariablePath(component, 'electricMw'))
    return total + (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : 0)
  }, 0)

export const processPlantElectricalPortsAt = (config: {
  readonly plant: ProcessPlantRuntimeInstance
  readonly connected: boolean
  readonly at: IsoTimestamp
}): ReadonlyArray<ElectricalPortDefinition> =>
  processPlantElectricalBoundaries(config.plant.plant).map(boundary => {
    const available = config.plant.runtime.readVariable(componentVariablePath(boundary.component, 'available')) === true
    const voltage = config.plant.runtime.readVariable(componentVariablePath(boundary.component, 'voltageFraction'))
    const frequency = config.plant.runtime.readVariable(componentVariablePath(boundary.component, 'frequencyHz'))
    const connected = config.connected && available && typeof voltage === 'number' && voltage > 0
    const netExportMw = grossGenerationMw(config.plant) - totalAuxiliaryDemandMw(config.plant)
    return electricalPortDefinitionSchema.parse({
      ...boundary.port,
      state: connected
        ? {
            activePowerMw: Math.max(-boundary.port.maximumImportMw, Math.min(boundary.port.maximumExportMw, netExportMw)),
            voltagePu: voltage,
            frequencyHz: frequency,
            energized: true,
            connected,
            observedAt: config.at,
          }
        : { activePowerMw: 0, voltagePu: 0, frequencyHz: null, energized: false, connected, observedAt: config.at },
    })
  })
