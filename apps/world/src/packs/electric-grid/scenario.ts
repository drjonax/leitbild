import type { GeoJsonPoint, IsoTimestamp, OperationalObject, PackId } from '../../core/model/index.ts'
import { geoPointFromLonLat, meters, objectIdSchema } from '../../core/model/index.ts'
import type { PackScenarioItemSpec, PackScenarioSupport } from '../../core/packs/protocol.ts'
import {
  gridAutomationSelectionSchema,
  gridModelSelectionSchema,
  gridOperatingPointSelectionSchema,
} from './config.ts'
import { electricGridPackId, emptyGridProjection, type ElectricGridPackData } from './model.ts'
import { electricGridAdapterId } from './sim/constants.ts'
import { gridDefinitionSchema } from './config.ts'
import { gridElectricalPortDefinitions } from './electrical-ports.ts'
import { z } from 'zod'

export const electricGridScenarioItemSchema = z.object({
  pack: z.literal('electric-grid'),
  type: z.literal('grid'),
  id: objectIdSchema,
  label: z.string().min(1),
  location: z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
  model: gridModelSelectionSchema,
  operatingPoint: gridOperatingPointSelectionSchema,
  automation: gridAutomationSelectionSchema,
}).strict()

const unsupported = (operation: string): never => {
  throw new Error(`electric-grid Pack does not support ${operation}`)
}

const pointFromSpec = (spec: PackScenarioItemSpec): GeoJsonPoint => {
  const location = spec.location
  if (!Array.isArray(location) || location.length !== 2 || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
    throw new Error(`Grid ${spec.id} requires location [lon, lat]`)
  }
  return geoPointFromLonLat(location[0], location[1])
}

const expandGridObject = async (spec: PackScenarioItemSpec, at: IsoTimestamp): Promise<OperationalObject> => {
  const model = gridModelSelectionSchema.parse(spec.model)
  const operatingPoint = gridOperatingPointSelectionSchema.parse(spec.operatingPoint)
  const automation = gridAutomationSelectionSchema.parse(spec.automation)
  // Loaded on first expansion so that importing the Pack never reads or compiles a model.
  const { compileGridDefinition } = await import('./definitions.ts')
  const compiledGrid = compileGridDefinition(gridDefinitionSchema.parse({ id: spec.id, model, operatingPoint, automation }))
  const packData: ElectricGridPackData = {
    type: 'electric-grid',
    schemaVersion: 1,
    model,
    operatingPoint,
    automation,
    electricalPorts: [...gridElectricalPortDefinitions(compiledGrid)],
    projection: emptyGridProjection(at, compiledGrid.model.nominalFrequencyHz),
  }
  return {
    id: objectIdSchema.parse(spec.id),
    kind: 'facility',
    packId: electricGridPackId as PackId,
    label: spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: pointFromSpec(spec),
        accuracyM: meters(10_000),
        observedAt: at,
        staleAfterMs: 60_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: { status: 'initializing', priority: 'normal', mode: 'simulated' },
    alerts: [],
    provenance: { source: 'simulator', adapterId: electricGridAdapterId, externalId: spec.id },
    timestamps: { createdAt: at, updatedAt: at },
    packData,
  }
}

export const electricGridScenarioSupport: PackScenarioSupport = {
  itemSchemas: { grid: electricGridScenarioItemSchema },
  expandItem: async (spec, context) => {
    const parsed = electricGridScenarioItemSchema.parse(spec)
    return { objects: [await expandGridObject(parsed, context.at)] }
  },
}
