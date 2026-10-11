import {
  electricalPortDefinitionSchema,
  type ElectricalPortDefinition,
  type IsoTimestamp,
} from '../../core/model/index.ts'
import type { CompiledGridDefinition } from './grid-model.ts'
import type { GridRuntimeInstance } from './runtime/instance.ts'

export const gridElectricalPortDefinitions = (
  definition: CompiledGridDefinition,
): ReadonlyArray<ElectricalPortDefinition> => definition.model.connectionPoints.map(point =>
  electricalPortDefinitionSchema.parse({
    id: point.id,
    label: point.label,
    role: 'network',
    nominalKv: point.nominalKv,
    maximumExportMw: point.maximumExportMw,
    maximumImportMw: point.maximumImportMw,
  }))

/**
 * Port state at each connection point. A live bus reports nominal voltage (the DC model computes
 * none) and its island frequency; a de-energised bus reports energized=false, voltage 0 and no
 * frequency, and no power flows through the port. `connected` is the Grid side of the bay: true
 * while a present system is connected there, whatever that system's own breaker does, so a
 * system that lost offsite power sees it return when the bus is energised again. Power flows only
 * while the system's own port is connected and energised.
 */
export const gridElectricalPortsAt = (config: {
  readonly grid: GridRuntimeInstance
  readonly at: IsoTimestamp
}): ReadonlyArray<ElectricalPortDefinition> => config.grid.definition.model.connectionPoints.map(point => {
  const bus = config.grid.busStates.get(point.busId)
  if (!bus) throw new Error(`Grid ${config.grid.definition.gridId} has no solved state for connection bus ${point.busId}; advance the Grid first`)
  const connection = config.grid.externalConnections.get(point.id)
  const connected = connection?.systemPresent === true
  const exchanging = connection?.connected === true
  const base = {
    id: point.id,
    label: point.label,
    role: 'network',
    nominalKv: point.nominalKv,
    maximumExportMw: point.maximumExportMw,
    maximumImportMw: point.maximumImportMw,
  }
  return electricalPortDefinitionSchema.parse({
    ...base,
    state: bus.energized
      ? {
          activePowerMw: exchanging ? -connection.systemActivePowerMw : 0,
          voltagePu: bus.voltagePu,
          frequencyHz: bus.frequencyHz,
          energized: true,
          connected,
          observedAt: config.at,
        }
      : { activePowerMw: 0, voltagePu: 0, frequencyHz: null, energized: false, connected, observedAt: config.at },
  })
})
