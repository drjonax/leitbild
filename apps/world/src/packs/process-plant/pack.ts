import { z } from 'zod'
import type { GeoJsonPoint,IsoTimestamp,OperationalObject,PackId } from '../../core/model/index.ts'
import { geoPointFromLonLat,meters,objectIdSchema } from '../../core/model/index.ts'
import type { PackScenarioItemSpec,WorldPack } from '../../core/packs/protocol.ts'
import { processPlantControlWriteCommandKind } from './commands.ts'
import {
  processPlantAutomationSelectionSchema,
  processPlantModelSelectionSchema,
  processPlantOperatingPointSelectionSchema,
  processPlantPackConfigSchema,
} from './config.ts'
import { processPlantElectricalPortDefinitions } from './electrical-ports.ts'
import { emptyProcessPlantProjection,processPlantPackId,processPlantUnitPackDataSchema,type ProcessPlantUnitPackData } from './model.ts'
import { compileProcessPlant } from './plant-compiler.ts'
import {
  processPlantDefinitionCatalog,
  processPlantPwrFullPowerOperatingPointRef,
  processPlantPwrReferenceAutomationRef,
  processPlantPwrReferenceModelRef,
} from './plant-definitions.ts'
import { processPlantRecordingProfiles, recordedPlantVariables } from './recording.ts'
import { processPlantObservationCapabilityIds } from './observation/query.ts'
import { processPlantComparableRoles } from './fleet.ts'
import { processPlantSimAdapterId } from './sim/constants.ts'
import { processPlantPackView } from './ui-pack.ts'

const processPlantScenarioItemSchema = z.object({
  pack: z.literal('process-plant'),
  type: z.literal('plant'),
  id: objectIdSchema,
  label: z.string().min(1),
  location: z.tuple([
    z.number().finite().min(-180).max(180),
    z.number().finite().min(-90).max(90),
  ]),
  model: processPlantModelSelectionSchema,
  operatingPoint: processPlantOperatingPointSelectionSchema,
  automation: processPlantAutomationSelectionSchema,
  clusterId: z.string().min(1).optional(),
  coolingWater: z.string().min(1).optional(),
  /** An AI agent operates this Plant directly (a training sandbox); absent, it only proposes (ProcessPlantUnitPackData.aiOperation). */
  aiOperation: z.literal('direct').optional(),
}).strict()

const unsupported = (operation: string): never => {
  throw new Error(`process-plant pack does not support ${operation}`)
}

const pointFromSpec = (spec: PackScenarioItemSpec): GeoJsonPoint => {
  const location = spec.location
  if (!Array.isArray(location) || location.length !== 2 || typeof location[0] !== 'number' || typeof location[1] !== 'number') {
    throw new Error(`process-plant unit ${spec.id} requires location [lon, lat]`)
  }
  return geoPointFromLonLat(location[0], location[1])
}

const optionalString = (spec: PackScenarioItemSpec, key: string): string | undefined => {
  const value = spec[key]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) throw new Error(`process-plant unit ${spec.id} has invalid ${key}`)
  return value
}

const optionalUnitData = (
  spec: PackScenarioItemSpec,
  key: string,
): Record<string, string> => {
  const value = optionalString(spec, key)
  return value === undefined ? {} : { [key]: value }
}

const expandPlantObject = (spec: PackScenarioItemSpec, at: IsoTimestamp): OperationalObject => {
  const model = processPlantModelSelectionSchema.parse(spec.model)
  const operatingPoint = processPlantOperatingPointSelectionSchema.parse(spec.operatingPoint)
  const automation = processPlantAutomationSelectionSchema.parse(spec.automation)
  const compiledPlant = compileProcessPlant({ id: spec.id, model, operatingPoint, automation })
  const packData: ProcessPlantUnitPackData = {
    type: 'process-plant',
    schemaVersion: 1,
    model,
    operatingPoint,
    automation,
    electricalPorts: [...processPlantElectricalPortDefinitions(compiledPlant)],
    ...optionalUnitData(spec, 'clusterId'),
    ...optionalUnitData(spec, 'coolingWater'),
    ...(spec.aiOperation === undefined ? {} : { aiOperation: z.literal('direct').parse(spec.aiOperation) }),
    projection: emptyProcessPlantProjection(at),
  }
  return {
    id: objectIdSchema.parse(spec.id),
    kind: 'facility',
    packId: processPlantPackId as PackId,
    label: spec.label,
    lifecycle: 'active',
    revision: 0,
    spatial: {
      position: {
        point: pointFromSpec(spec),
        accuracyM: meters(10),
        observedAt: at,
        staleAfterMs: 60_000,
      },
      frame: { kind: 'wgs84' },
    },
    operational: {
      status: 'initializing',
      priority: 'normal',
      mode: 'simulated',
    },
    alerts: [],
    provenance: {
      source: 'simulator',
      adapterId: processPlantSimAdapterId,
      externalId: spec.id,
    },
    timestamps: {
      createdAt: at,
      updatedAt: at,
    },
    packData,
  }
}

export const processPlantPack: WorldPack = {
  ...processPlantPackView,
  scenarioConfigSchema: processPlantPackConfigSchema,
  authoring: {
    itemTypes: [{
      id: 'plant',
      label: 'Process plant',
      description: 'A map-visible Plant backed by a selected model, operating point, and automation definition.',
      idPrefix: 'plant',
      defaultItem: {
        model: {
          ref: processPlantPwrReferenceModelRef,
          parameters: { loopCount: 4 },
        },
        operatingPoint: { ref: processPlantPwrFullPowerOperatingPointRef },
        automation: { ref: processPlantPwrReferenceAutomationRef },
      },
      placement: { kind: 'point', path: ['location'] },
      fields: [{ path: ['model', 'ref'], label: 'Model', control: { kind: 'select', options: processPlantDefinitionCatalog().models.map(model => ({ value: model.id, label: model.title })) } },
      { path: ['operatingPoint', 'ref'], label: 'Operating point', control: { kind: 'select', options: processPlantDefinitionCatalog().operatingPoints.map(point => ({ value: point.id, label: point.title, compatibleWith: { path: ['model', 'ref'], values: point.compatibleModelRefs } })) } },
      { path: ['automation', 'ref'], label: 'Automation', control: { kind: 'select', options: processPlantDefinitionCatalog().automations.map(automation => ({ value: automation.id, label: automation.title, compatibleWith: { path: ['model', 'ref'], values: automation.compatibleModelRefs } })) } }, {
        path: ['model', 'parameters', 'loopCount'], label: 'Primary loops',
        control: { kind: 'number', min: 2, max: 6, step: 1 },
      }],
    }],
  },
  recording: {
    profiles: processPlantRecordingProfiles,
    estimateSeries: (objects, profileId) => objects.reduce((sum, object) => {
      const data = processPlantUnitPackDataSchema.parse(object.packData)
      const plant = compileProcessPlant({ id: object.id, model: data.model, operatingPoint: data.operatingPoint, automation: data.automation })
      return sum + recordedPlantVariables(plant, profileId).length
    }, 0),
  },
  knowledge: { wikiRefs: [{ name: 'Process plant knowledge', url: '/wiki?path=world%2Fpacks%2Fprocess-plant%2Findex.md' }] },
  observation: {
    categories: ['process-plants'],
    declarations: processPlantObservationCapabilityIds.declarations,
    read: processPlantObservationCapabilityIds.read,
    topology: { family: 'flow', capability: processPlantObservationCapabilityIds.topology },
    comparable: processPlantComparableRoles,
  },
  scenario: {
    itemSchemas: { plant: processPlantScenarioItemSchema },
    expandItem: (spec, context) => {
      if (spec.pack !== 'process-plant') unsupported(`scenario pack ${spec.pack}`)
      if (spec.type !== 'plant') unsupported(`scenario object type ${spec.type}`)
      return { objects: [expandPlantObject(spec, context.at)] }
    },
  },
}

export { processPlantControlWriteCommandKind }
