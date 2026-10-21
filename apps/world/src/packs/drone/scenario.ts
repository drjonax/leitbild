import { z } from 'zod'
import {
  geoPointFromLonLat,
  objectIdSchema,
  type GeoJsonPoint
} from '../../core/model/index.ts'
import type { PackScenarioItemSpec,PackScenarioSupport } from '../../core/packs/protocol.ts'
import { droneModelsForConfig,dronePackConfigSchema } from './config.ts'
import {
  droneSwarmMembershipSchema,
  droneVehicleModelSchema,
  requireDroneVehicleModel,
  type DroneVehicleModel
} from './model.ts'
import { createScenarioDroneObject } from './native/object-state.ts'

const lonLatSchema = z.tuple([
  z.number().finite().min(-180).max(180),
  z.number().finite().min(-90).max(90),
])


export const droneSpecSchema = z.object({
  pack: z.literal('drone'),
  type: z.literal('drone'),
  id: objectIdSchema,
  label: z.string().min(1),
  position: lonLatSchema,
  modelId: z.string().min(1).max(128).default('native-survey-quad'),
  model: droneVehicleModelSchema.optional(),
  altitudeM: z.number().finite().min(-1_000).max(100_000).default(35),
  headingDeg: z.number().finite().min(0).max(360).default(0),
  swarm: droneSwarmMembershipSchema.optional(),
}).strict()


const pointFromLonLat = (value: readonly [number, number]): GeoJsonPoint =>
  geoPointFromLonLat(value[0], value[1])

export const dronePackConfigFromSelections = (
  packConfigs: Record<string, unknown>,
): z.infer<typeof dronePackConfigSchema> =>
  dronePackConfigSchema.parse(packConfigs.drone ?? {})

export const droneVehicleModelsFromPackConfigs = (
  packConfigs: Record<string, unknown>,
): ReadonlyArray<DroneVehicleModel> => {
  const parsed = dronePackConfigFromSelections(packConfigs)
  return droneModelsForConfig(parsed)
}

export const droneScenarioSupport: PackScenarioSupport = {
  validateInitialObjects: (objects, config) => {
    const limit = dronePackConfigSchema.parse(config).maxDrones
    if (objects.filter(object => object.packId === 'drone').length > limit) throw new Error(`Drone selection exceeds its configured maximum of ${limit} vehicles`)
  },
  itemSchemas: { drone: droneSpecSchema },
  expandItem: (rawSpec: PackScenarioItemSpec, context) => {
    if (rawSpec.type !== 'drone') throw new Error(`unsupported drone scenario object type: ${rawSpec.type}`)
    const spec = droneSpecSchema.parse(rawSpec)
    const models = spec.model === undefined
      ? droneVehicleModelsFromPackConfigs(context.packConfigs)
      : [...droneVehicleModelsFromPackConfigs(context.packConfigs), spec.model]
    const model = spec.model ?? requireDroneVehicleModel(spec.modelId, models)
    return { objects: [createScenarioDroneObject({
      id: spec.id,
      label: spec.label,
      model,
      point: pointFromLonLat(spec.position),
      altitudeM: spec.altitudeM,
      headingDeg: spec.headingDeg,
      at: context.at,
      ...(spec.swarm === undefined ? {} : { swarm: spec.swarm }),
    })] }
  },
}
